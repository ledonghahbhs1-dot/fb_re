import { chromium, Browser, Page, BrowserContext } from "playwright";
import { logger } from "../lib/logger";
import { bufferLog } from "../lib/logBuffer";
import { botState } from "./state";
import { getClaudeReply } from "./claude";
import * as fs from "fs";
import * as path from "path";

// Helper: log to both pino and the in-memory buffer visible in the dashboard
function blog(level: "info" | "warn" | "error", data: Record<string, any>, msg: string) {
  logger[level](data, msg);
  bufferLog(level, msg, data);
}

const CHROMIUM_PATH =
  "/nix/store/0n9rl5l9syy808xi9bk4f6dhnfrvhkww-playwright-browsers-chromium/chromium-1080/chrome-linux/chrome";

// Persisted browser state (cookies + localStorage incl. E2EE keys)
const BROWSER_STATE_PATH = path.join(process.cwd(), "dist", "browser-state.json");

function loadBrowserState(): object | null {
  try {
    if (fs.existsSync(BROWSER_STATE_PATH)) {
      const raw = fs.readFileSync(BROWSER_STATE_PATH, "utf8");
      const state = JSON.parse(raw);
      blog("info", { path: BROWSER_STATE_PATH }, "Loaded saved browser state");
      return state;
    }
  } catch (e) {
    blog("warn", { err: String(e) }, "Could not load browser state — will use raw cookies");
  }
  return null;
}

async function saveBrowserState(ctx: BrowserContext): Promise<void> {
  try {
    const state = await ctx.storageState();
    fs.mkdirSync(path.dirname(BROWSER_STATE_PATH), { recursive: true });
    fs.writeFileSync(BROWSER_STATE_PATH, JSON.stringify(state));
    blog("info", {}, "Browser state saved (cookies + E2EE keys)");
  } catch (e) {
    blog("warn", { err: String(e) }, "Could not save browser state");
  }
}

let browser: Browser | null = null;
let bContext: BrowserContext | null = null;
let bPage: Page | null = null;
let stopSignal = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

// Track last processed timestamp per thread
const lastSeenTimestamp = new Map<string, number>();
// Deduplicate replied messages
const repliedMessageIds = new Set<string>();
let sessionUID = "";
let sessionDtsg = "";

export type LoginCredentials =
  | { type: "credentials"; email: string; password: string }
  | { type: "appstate"; appState: any[] };

// ---------------------------------------------------------------------------
// Session helpers — work on both facebook.com and messenger.com
// ---------------------------------------------------------------------------

async function extractDtsg(page: Page): Promise<string> {
  return page.evaluate(() => {
    const scripts = Array.from(document.querySelectorAll("script"));
    for (const s of scripts) {
      const t = (s as HTMLScriptElement).textContent ?? "";
      const m =
        t.match(/\["DTSGInitialData",\[\],\{"token":"([^"]+)"/) ||
        t.match(/"token"\s*:\s*"([A-Za-z0-9_\-]{10,}[^"]*)"\s*,\s*"async"/) ||
        t.match(/name="fb_dtsg"\s+value="([^"]+)"/) ||
        t.match(/"fb_dtsg"\s*,\s*null\s*,\s*"([^"]+)"/);
      if (m?.[1]) return m[1];
    }
    return "";
  });
}

async function extractUID(page: Page): Promise<string> {
  return page.evaluate(() => {
    const scripts = Array.from(document.querySelectorAll("script"));
    for (const s of scripts) {
      const t = (s as HTMLScriptElement).textContent ?? "";
      const m =
        t.match(/"USER_ID"\s*:\s*"(\d+)"/) ||
        t.match(/"actorID"\s*:\s*"(\d+)"/) ||
        t.match(/"user_id"\s*:\s*"(\d+)"/) ||
        t.match(/,"uid":(\d+),/);
      if (m?.[1]) return m[1];
    }
    return "";
  });
}

// ---------------------------------------------------------------------------
// Process any GraphQL response that may contain message data.
// Handles multiple response formats:
//   1. messenger.com /api/graphql/ — plain JSON: {"data":{...}}
//   2. facebook.com /api/graphqlbatch/ — line-separated: [{o0:{data:{...}}},{status}]
//   3. Relay response arrays: [{data:{...}},...]
// ---------------------------------------------------------------------------

async function processGraphQLText(text: string, source: string) {
  if (stopSignal) return;

  const clean = text.replace(/^for\s*\(;;\);\s*/, "").trim();
  if (!clean.startsWith("{") && !clean.startsWith("[")) return;

  // Parse all candidate JSON objects
  const candidates: any[] = [];

  // Try as single JSON object
  try {
    const obj = JSON.parse(clean);
    candidates.push(obj);
  } catch {
    // Try as newline-separated JSON lines
    for (const line of clean.split("\n")) {
      const l = line.trim();
      if (!l.startsWith("{") && !l.startsWith("[")) continue;
      try { candidates.push(JSON.parse(l)); } catch {}
    }
  }

  if (candidates.length === 0) return;

  for (const item of candidates) {
    // Log top-level keys to understand structure (especially E2EE responses)
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const topKeys = Object.keys(item);
      blog("info", { source, topKeys }, "GraphQL top-level keys");
      // Log second-level keys for deeper structure understanding
      for (const k of topKeys.slice(0, 3)) {
        const v = item[k];
        if (v && typeof v === "object") {
          blog("info", { source, parent: k, childKeys: Object.keys(v).slice(0, 8) }, "GraphQL nested keys");
        }
      }
    }

    // Format 1: messenger.com — {"data": {"viewer": ...}} or {"data": {"message_thread": ...}}
    await processDataNode(item?.data, source);

    // Format 2: graphqlbatch — {"o0": {"data": {...}}}
    if (item?.o0) await processDataNode(item.o0?.data, source);

    // Format 3: array wrapper — [{"data":{...}}, ...]
    if (Array.isArray(item)) {
      for (const el of item) {
        await processDataNode(el?.data, source);
        if (el?.o0) await processDataNode(el.o0?.data, source);
      }
    }
  }
}

async function processDataNode(data: any, source: string) {
  if (!data || stopSignal) return;

  const keys = Object.keys(data);
  if (keys.length > 0) {
    blog("info", { keys, source }, "GraphQL data keys found");
  }

  // Thread list: viewer.message_threads.nodes
  const threadNodes: any[] = data?.viewer?.message_threads?.nodes ?? [];
  if (threadNodes.length > 0) {
    blog("info", { count: threadNodes.length, source }, "Thread list found");
  }

  for (const thread of threadNodes) {
    const threadID = String(
      thread?.thread_key?.thread_fbid ?? thread?.thread_key?.other_user_id ?? ""
    );
    const threadType: string = thread?.thread_type ?? "ONE_TO_ONE";
    if (!threadID) continue;

    // Messages embedded in thread list
    const embeddedMsgs: any[] = thread?.messages?.nodes ?? thread?.last_message?.nodes ?? [];
    for (const msg of embeddedMsgs) {
      await checkAndHandleMsg(msg, threadID, threadType);
    }
  }

  // Single thread history: message_thread.messages.nodes
  const threadData = data?.message_thread ?? data?.thread;
  if (threadData) {
    const threadID = String(
      threadData?.thread_key?.thread_fbid ?? threadData?.thread_key?.other_user_id ?? ""
    );
    const threadType: string = threadData?.thread_type ?? "ONE_TO_ONE";
    const msgs: any[] = threadData?.messages?.nodes ?? [];

    if (msgs.length > 0) {
      blog("info", { threadID, msgCount: msgs.length, source }, "Thread messages found");
    }

    for (const msg of msgs) {
      await checkAndHandleMsg(msg, threadID, threadType);
    }
  }
}

async function checkAndHandleMsg(msg: any, threadID: string, threadType: string) {
  if (!msg || stopSignal) return;

  const ts = Number(msg.timestamp_precise ?? msg.timestamp ?? 0);
  const lastSeen = lastSeenTimestamp.get(threadID) ?? 0;
  if (ts <= lastSeen) return;

  const senderId = String(msg.message_sender?.id ?? msg.actor_id ?? "");
  if (senderId === sessionUID) return;

  const body: string = msg.message?.text ?? msg.body ?? "";
  if (!body.trim()) return;

  lastSeenTimestamp.set(threadID, Math.max(lastSeen, ts));

  const msgId = msg.message_id ?? `${threadID}-${ts}`;
  await handleMessage(threadID, threadType, body, msg.message_sender?.name ?? "người dùng", senderId, msgId);
}

// ---------------------------------------------------------------------------
// Message handler → Claude reply
// ---------------------------------------------------------------------------

async function handleMessage(
  threadId: string, threadType: string, body: string,
  senderName: string, senderID: string, messageId: string
) {
  if (repliedMessageIds.has(messageId)) return;
  repliedMessageIds.add(messageId);
  if (repliedMessageIds.size > 500) repliedMessageIds.delete(repliedMessageIds.values().next().value!);

  if (!botState.autoReplyEnabled) return;
  if (!body.trim()) return;
  if (botState.ignoredThreadIds.has(threadId)) {
    blog("info", { threadId }, "Thread ignored");
    return;
  }

  blog("info", { threadId, senderID, body: body.substring(0, 80) }, "Message → Claude");
  if (!bPage) return;

  try {
    const reply = await getClaudeReply(threadId, body, botState.systemPrompt);
    await sendFbMessageUI(bPage, threadId, reply);
    botState.messagesHandled++;
    blog("info", { threadId, senderName }, "Reply sent ✓");
  } catch (err) {
    blog("error", { err: String(err), threadId }, "Reply failed");
    try {
      await sendFbMessageUI(bPage, threadId, "Xin lỗi, tôi đang gặp sự cố kỹ thuật. Vui lòng thử lại sau.");
    } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Send message via UI interaction — works for all thread types (1:1, group, E2EE)
// Does NOT require fb_dtsg tokens or knowledge of the REST/GraphQL API.
// ---------------------------------------------------------------------------

async function sendFbMessageUI(page: Page, threadID: string, text: string): Promise<void> {
  // Navigate to the thread if not already there
  const currentUrl = page.url();
  const isCorrectThread =
    currentUrl.includes(`/t/${threadID}`) || currentUrl.includes(`/e2ee/t/${threadID}`);

  if (!isCorrectThread) {
    blog("info", { threadID }, "Navigating to thread for send");
    await page.goto(`https://www.facebook.com/messages/t/${threadID}/`, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
    await page.waitForTimeout(2500);
  }

  // Facebook uses a contenteditable Lexical editor div for the message input.
  // Try multiple selectors to handle both VN and EN locales.
  const INPUT_SELECTORS = [
    '[aria-label*="nhắn tin"]',
    '[aria-label*="Nhập tin nhắn"]',
    '[aria-label*="Message"]',
    '[aria-label*="message"]',
    '[role="textbox"][contenteditable="true"]',
    '[contenteditable="true"]',
  ];

  // Wait for the Lexical editor to be ready before interacting
  await page.waitForTimeout(1000);

  let clicked = false;
  for (const sel of INPUT_SELECTORS) {
    const loc = page.locator(sel).last();
    const visible = await loc.isVisible({ timeout: 3000 }).catch(() => false);
    if (visible) {
      // Use force:true to bypass Playwright's actionability checks (element may be
      // technically covered by a thin overlay that doesn't affect real interaction)
      await loc.click({ timeout: 10000, force: true });
      clicked = true;
      break;
    }
  }
  if (!clicked) throw new Error("Không tìm thấy ô nhập tin nhắn");

  // Small pause to ensure focus landed, then type
  await page.waitForTimeout(300);
  await page.keyboard.press("Control+a");
  await page.keyboard.type(text, { delay: 15 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);

  blog("info", { threadID, len: text.length }, "Message sent via UI ✓");
}

// ---------------------------------------------------------------------------
// DOM scraper — reads decrypted messages directly from the rendered page.
// Works for both plain and E2EE threads since the browser has already
// decrypted the content before rendering.
// ---------------------------------------------------------------------------

interface DomMessage {
  text: string;
  isMine: boolean;
  ts: number;          // epoch ms (0 if unknown)
  msgKey: string;      // unique key for dedup
}

async function scrapeConversationDOM(page: Page, initOnly = false): Promise<void> {
  if (stopSignal) return;

  // Wait for React to render — E2EE threads need extra time to decrypt
  await page.waitForTimeout(1500);

  const result = await page.evaluate((myUID: string) => {
    const url = window.location.pathname;
    const threadMatch = url.match(/\/messages\/(?:e2ee\/)?t\/(\d+)/);
    const threadID = threadMatch?.[1] ?? "";
    const isE2EE = url.includes("/e2ee/");

    // ── Approach 1: accessibility tree via role="row" ──
    const rows = Array.from(document.querySelectorAll('[role="row"]'));
    const msgs: any[] = [];

    for (const row of rows) {
      // Grab all dir="auto" text nodes (message body)
      const textEls = Array.from(row.querySelectorAll('[dir="auto"]'));
      const texts = textEls
        .map((el) => el.textContent?.trim() ?? "")
        .filter((t) => t.length > 0 && t.length < 4000);
      if (texts.length === 0) continue;

      // Aria-label often contains sender name
      const label = row.getAttribute("aria-label") ?? "";

      // Time element
      const timeEl = row.querySelector("abbr[title], time[datetime]");
      const timeHint = timeEl?.getAttribute("title") ?? timeEl?.getAttribute("datetime") ?? "";

      // Heuristic: rows where the container is flex-end are "mine"
      // We fall back to detecting myUID in label
      const isMine = label.toLowerCase().includes("you") || label.toLowerCase().includes("bạn");

      msgs.push({ texts, label: label.slice(0, 120), timeHint, isMine });
    }

    // ── Approach 2: scan ALL aria-labels on the page for "Sent by" / "gửi" pattern ──
    // aria-label format (Vietnamese): "Nhập, Tin nhắn do [SENDER] gửi lúc [TIME]: [MSG]"
    // aria-label format (English):    "Press Enter, Message from [SENDER] sent at [TIME]: [MSG]"
    // My own messages:                "...do bạn gửi..." / "...You sent..."
    const sentByMsgs: any[] = [];
    document.querySelectorAll("[aria-label]").forEach((el) => {
      const lb = el.getAttribute("aria-label") ?? "";

      // Only match the specific Facebook "sent by" aria-label formats:
      //   VN: "Nhập, Tin nhắn do [SENDER] gửi lúc [TIME]: [MSG]"
      //   EN: "Press Enter, Message from [SENDER] sent at [TIME]: [MSG]"
      // This avoids false positives where the message BODY contains "gửi".
      const isVN = /Tin nhắn do\s+.+?\s+gửi lúc/i.test(lb);
      const isEN = /Message from\s+.+?\s+sent at/i.test(lb);
      if (!isVN && !isEN) return;

      // Skip my own messages ("do bạn gửi" / "you sent")
      if (/do bạn gửi/i.test(lb) || /you sent/i.test(lb)) return;

      // Extract message body after the last ": "
      const colonIdx = lb.lastIndexOf(": ");
      const msgBody = colonIdx >= 0 ? lb.slice(colonIdx + 2).trim() : "";

      // Extract sender name between "do " and " gửi" / "from " and " sent"
      const vnMatch = lb.match(/\bdo\s+(.+?)\s+gửi\b/i);
      const enMatch = lb.match(/\bfrom\s+(.+?)\s+sent\b/i);
      const senderName = (vnMatch?.[1] ?? enMatch?.[1] ?? "Người dùng").trim();

      if (msgBody) sentByMsgs.push({ lb: lb.slice(0, 140), msgBody, senderName });
    });

    // ── Diagnostics: unique aria-labels on page (first 8) ──
    const allLabels: string[] = [];
    document.querySelectorAll("[aria-label]").forEach((el) => {
      const lb = el.getAttribute("aria-label")?.trim() ?? "";
      if (lb) allLabels.push(lb.slice(0, 60));
    });
    const uniqueLabels = [...new Set(allLabels)].slice(0, 10);

    return {
      threadID, isE2EE, url,
      rowCount: rows.length,
      rowMsgs: msgs.slice(-6),       // last 6 rows
      sentByCount: sentByMsgs.length,
      sentByMsgs: sentByMsgs.slice(-4),
      uniqueLabels,
    };
  }, sessionUID);

  // ── Detect login overlay — Facebook shows login form when session expires ──
  const loginLabels = ["email or phone", "password", "email or phone number"];
  const isLoginPage = result.uniqueLabels.some((lb: string) =>
    loginLabels.some((l) => lb.toLowerCase().includes(l))
  );
  if (isLoginPage) {
    blog("error", { uniqueLabels: result.uniqueLabels }, "Login overlay detected — cookies expired or invalid!");
    botState.status = "error";
    botState.error = "Phiên đăng nhập hết hạn. Vui lòng vào Settings → dừng bot → cập nhật cookies mới → khởi động lại.";
    stopSignal = true;
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    return;
  }

  blog("info", {
    threadID: result.threadID,
    isE2EE: result.isE2EE,
    rowCount: result.rowCount,
    sentByCount: result.sentByCount,
    uniqueLabels: result.uniqueLabels,
  }, "DOM scrape diagnostics");

  if (result.rowMsgs.length > 0) {
    blog("info", { sample: result.rowMsgs }, "DOM row messages sample");
  }
  if (result.sentByMsgs.length > 0) {
    blog("info", { sample: result.sentByMsgs }, "DOM sentBy messages sample");
  }

  // ── Process sentBy messages ──
  const threadID = result.threadID;
  if (!threadID) return;

  if (initOnly) {
    // First poll: just mark all visible messages as seen so we don't reply to history
    let marked = 0;
    for (const m of result.sentByMsgs as any[]) {
      if (!m.msgBody) continue;
      const msgKey = `dom-${threadID}-${m.msgBody.slice(0, 50)}`;
      repliedMessageIds.add(msgKey);
      marked++;
    }
    blog("info", { threadID, marked }, "First poll: existing messages marked as seen (no reply)");
    return;
  }

  for (const m of result.sentByMsgs as any[]) {
    const text: string = m.msgBody;
    const senderName: string = m.senderName;
    if (!text) continue;

    const msgKey = `dom-${threadID}-${text.slice(0, 50)}`;
    if (repliedMessageIds.has(msgKey)) continue;

    blog("info", { threadID, senderName, text: text.slice(0, 80) }, "DOM: new message detected");
    const ts = Date.now();
    await checkAndHandleMsg(
      {
        message: { text },
        timestamp_precise: String(ts),
        message_sender: { id: "0", name: senderName },
        message_id: msgKey,
      },
      threadID, "ONE_TO_ONE"
    );
  }
}

// ---------------------------------------------------------------------------
// Interceptor — captures messenger.com GraphQL calls
// ---------------------------------------------------------------------------

async function setupInterceptor(page: Page) {
  // Intercept messenger.com /api/graphql/ (main message data endpoint)
  await page.route("**/api/graphql/**", async (route, request) => {
    try {
      const response = await route.fetch();
      const body = await response.text();
      // messenger.com GraphQL responses are plain JSON (no for(;;); prefix)
      processGraphQLText(body, request.url()).catch(() => {});
      await route.fulfill({ response, body });
    } catch (err: any) {
      blog("warn", { err: err?.message }, "graphql route error");
      await route.continue();
    }
  });

  // Also capture via response event (catches calls we didn't route)
  page.on("response", async (resp) => {
    const url = resp.url();
    if (!url.includes("messenger.com") && !url.includes("facebook.com")) return;
    const path = new URL(url).pathname;
    if (!path.includes("graphql") && !path.includes("messaging")) return;

    try {
      const text = await resp.text();
      processGraphQLText(text, path).catch(() => {});
    } catch (_) {}
  });

  blog("info", {}, "messenger.com interceptors registered");
}

// ---------------------------------------------------------------------------
// Extract thread IDs visible in the sidebar/inbox
// ---------------------------------------------------------------------------
async function getSidebarThreadIDs(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href*="/messages/t/"], a[href*="/messages/e2ee/t/"]'));
    const seen = new Set<string>();
    for (const link of links) {
      const href = link.getAttribute("href") ?? "";
      const m = href.match(/\/messages\/(?:e2ee\/)?t\/(\d+)/);
      if (m?.[1]) seen.add(m[1]);
    }
    return [...seen].slice(0, 10); // top 10 conversations
  });
}

// ---------------------------------------------------------------------------
// Poll loop — multi-conversation: check top conversations on every cycle
// ---------------------------------------------------------------------------
function startPollLoop() {
  let firstPoll = true;

  async function doPoll() {
    if (stopSignal || !bPage) return;

    try {
      // Always start from the inbox to get an updated sidebar
      await bPage.goto("https://www.facebook.com/messages/", {
        waitUntil: "domcontentloaded",
        timeout: 25000,
      });
      // Let the sidebar load
      await bPage.waitForTimeout(2500);

      const dtsg = await extractDtsg(bPage);
      if (dtsg) sessionDtsg = dtsg;

      // Discover conversations from the sidebar
      const threadIDs = await getSidebarThreadIDs(bPage);
      blog("info", { threadIDs, initOnly: firstPoll }, "Poll: discovered conversations");

      // Visit each conversation and scrape it
      for (const tid of threadIDs) {
        if (stopSignal) break;

        await bPage.goto(`https://www.facebook.com/messages/t/${tid}/`, {
          waitUntil: "domcontentloaded",
          timeout: 20000,
        });
        await bPage.waitForTimeout(1800);

        await scrapeConversationDOM(bPage, firstPoll);
      }

      firstPoll = false;

    } catch (err: any) {
      const msg = err?.message ?? String(err);
      blog("error", { err: msg }, "Poll error");
      if (msg.includes("Target closed") || msg.includes("browser has been closed")) {
        botState.status = "error";
        botState.error = "Browser gặp lỗi. Vui lòng dừng và khởi động lại bot.";
        return;
      }
    }

    if (!stopSignal) pollTimer = setTimeout(doPoll, 15000);
  }

  // First poll after a short delay to let the page fully settle
  pollTimer = setTimeout(doPoll, 5000);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function startBot(credentials: LoginCredentials): Promise<void> {
  if (botState.status === "running" || botState.status === "connecting") {
    throw new Error("Bot đang chạy hoặc đang kết nối");
  }

  stopSignal = false;
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  lastSeenTimestamp.clear();
  repliedMessageIds.clear();
  botState.status = "connecting";
  botState.error = null;
  botState.startedAt = null;
  botState.messagesHandled = 0;

  blog("info", {}, "Launching Chromium");

  browser = await chromium.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--disable-gpu",
      "--disable-infobars",
      "--disable-extensions",
      "--no-first-run",
      "--ignore-certificate-errors",
    ],
  });

  // Try to load saved browser state (contains cookies + E2EE keys from last session)
  const savedState = loadBrowserState();

  bContext = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    locale: "vi-VN",
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: { "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7" },
    ...(savedState ? { storageState: savedState as any } : {}),
  });

  // Hide all Playwright/automation indicators so Facebook doesn't detect the bot
  await bContext.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, "languages", { get: () => ["vi-VN", "vi", "en-US", "en"] });
    // @ts-ignore
    delete window.__playwright;
    // @ts-ignore
    delete window.__pw_manual;
    // @ts-ignore
    delete window.__selenium_unwrapped;
    // @ts-ignore
    if (!window.chrome) window.chrome = { runtime: {} };
  });

  if (credentials.type === "appstate") {
    // Always inject the user's fresh cookies on top of any saved state.
    // This ensures the latest tokens are used even if saved state has older cookies.
    const cookiesBases = credentials.appState.map((c: any) => ({
      name: c.key,
      value: c.value,
      path: c.path ?? "/",
      expires: typeof c.expires === "number" && c.expires > 0 ? c.expires : -1,
      httpOnly: c.httpOnly ?? true,
      secure: c.secure ?? true,
      sameSite: "None" as const,
    }));
    const fbCookies = cookiesBases.map((c) => ({ ...c, domain: ".facebook.com" }));
    const msgrCookies = cookiesBases.map((c) => ({ ...c, domain: ".messenger.com" }));
    await bContext.addCookies([...fbCookies, ...msgrCookies]);
    blog("info", { count: fbCookies.length, hasSavedState: !!savedState }, "Cookies injected");
  }

  bPage = await bContext.newPage();

  // Set up interceptors BEFORE any navigation
  await setupInterceptor(bPage);

  // Navigate to facebook.com/messages/ to load the session
  blog("info", {}, "Navigating to facebook.com/messages/...");
  await bPage.goto("https://www.facebook.com/messages/", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  const fbUrl = bPage.url();
  blog("info", { url: fbUrl }, "Navigation result");

  if (fbUrl.includes("checkpoint")) {
    throw new Error("Tài khoản đang bị Facebook checkpoint. Vui lòng xác minh trên trình duyệt rồi thử lại với cookies mới.");
  }
  if (fbUrl.includes("/login")) {
    // Delete stale saved state so next attempt uses fresh cookies
    try { fs.unlinkSync(BROWSER_STATE_PATH); } catch (_) {}
    throw new Error("Cookie đã hết hạn hoặc không hợp lệ. Vui lòng lấy cookies mới từ trình duyệt.");
  }

  // Wait a bit for React + E2EE keys to initialize
  await bPage.waitForTimeout(3000);

  let uid = await extractUID(bPage);
  if (!uid && credentials.type === "appstate") {
    const cUser = credentials.appState.find((c: any) => c.key === "c_user");
    if (cUser) uid = String(cUser.value);
  }
  sessionUID = uid;

  const dtsg = await extractDtsg(bPage);
  if (!dtsg) throw new Error("Không thể lấy token bảo mật (fb_dtsg). Cookie có thể không đủ hoặc đã hết hạn.");
  sessionDtsg = dtsg;

  // Save browser state now (cookies + localStorage with E2EE keys)
  await saveBrowserState(bContext);

  blog("info", { uid, dtsgPrefix: sessionDtsg.substring(0, 10) + "...", url: fbUrl }, "Session ready");

  botState.status = "running";
  botState.startedAt = new Date();
  botState.error = null;

  startPollLoop();
}

export function stopBot(): void {
  stopSignal = true;
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  if (browser) {
    browser.close().catch(() => {});
    browser = null;
    bContext = null;
    bPage = null;
  }
  botState.status = "stopped";
  botState.error = null;
  blog("info", {}, "Bot stopped");
}

export function getFacebookApi() {
  return bPage ? { active: true } : null;
}
