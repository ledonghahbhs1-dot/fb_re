import { chromium, Browser, Page, BrowserContext } from "playwright";
import { logger } from "../lib/logger";
import { bufferLog } from "../lib/logBuffer";
import { botState } from "./state";
import { getClaudeReply } from "./claude";

// Helper: log to both pino and the in-memory buffer visible in the dashboard
function blog(level: "info" | "warn" | "error", data: Record<string, any>, msg: string) {
  logger[level](data, msg);
  bufferLog(level, msg, data);
}

const CHROMIUM_PATH =
  "/nix/store/0n9rl5l9syy808xi9bk4f6dhnfrvhkww-playwright-browsers-chromium/chromium-1080/chrome-linux/chrome";

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
    await sendFbMessage(bPage, threadId, reply, threadType);
    botState.messagesHandled++;
    blog("info", { threadId, senderName }, "Reply sent ✓");
  } catch (err) {
    blog("error", { err: String(err), threadId }, "Reply failed");
    try {
      await sendFbMessage(bPage, threadId, "Xin lỗi, tôi đang gặp sự cố kỹ thuật. Vui lòng thử lại sau.", threadType);
    } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Send message — works on both messenger.com and facebook.com
// ---------------------------------------------------------------------------

function genOfflineId(): string {
  const epoch = BigInt(Date.now());
  const rand = BigInt(Math.floor(Math.random() * 0x3fffff));
  return String((epoch << 22n) | rand);
}

async function sendFbMessage(page: Page, threadID: string, text: string, threadType: string): Promise<void> {
  const isGroup = threadType === "GROUP";
  const ts = String(Date.now());
  const params: Record<string, string> = {
    client: "mercury",
    fb_dtsg: sessionDtsg,
    __user: sessionUID,
    action_type: "ma-type:user-generated-message",
    has_attachment: "false",
    message_id: `<${ts}:01:01>`,
    offline_threading_id: genOfflineId(),
    source: "source:chat:web",
    body: text,
    timestamp: ts,
  };
  if (isGroup) params["thread_fbid"] = threadID;
  else params["other_user_fbid"] = threadID;

  // Always use the current page's own origin to avoid CORS errors.
  // The page is on facebook.com, so this sends to facebook.com/messaging/send/.
  const result = await page.evaluate(
    async (params: Record<string, string>) => {
      const origin = window.location.origin; // https://www.facebook.com
      const body = new URLSearchParams(params);
      try {
        const resp = await fetch(`${origin}/messaging/send/`, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "X-Requested-With": "XMLHttpRequest",
          },
          body: body.toString(),
          credentials: "include",
        });
        const txt = await resp.text();
        const clean = txt.replace(/^for\s*\(;;\);\s*/, "");
        try { return { ok: true, data: JSON.parse(clean), status: resp.status }; }
        catch { return { ok: false, raw: txt.slice(0, 400), status: resp.status }; }
      } catch (e: any) {
        return { ok: false, fetchErr: String(e?.message ?? e), status: 0 };
      }
    },
    params
  );

  if (!result.ok) {
    throw new Error(`Send fetch failed: ${result.fetchErr ?? result.raw} (HTTP ${result.status})`);
  }
  if (result.data?.error_results?.length > 0) {
    throw new Error(`Send API error: ${JSON.stringify(result.data.error_results[0])}`);
  }
  blog("info", { threadID, status: result.status }, "Send response OK");
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

async function scrapeConversationDOM(page: Page): Promise<void> {
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
      if (!(/gửi/i.test(lb) || /sent (a message|by|at)/i.test(lb))) return;

      // Skip my own messages
      if (/\bdo bạn gửi\b/i.test(lb) || /\byou sent\b/i.test(lb)) return;

      // Extract message body after the last ": "
      const colonIdx = lb.lastIndexOf(": ");
      const msgBody = colonIdx >= 0 ? lb.slice(colonIdx + 2).trim() : "";

      // Extract sender name:
      //   VN: "do [SENDER] gửi lúc"  →  capture between "do " and " gửi"
      //   EN: "from [SENDER] sent at" →  capture between "from " and " sent"
      let senderName = "";
      const vnMatch = lb.match(/\bdo\s+(.+?)\s+gửi\b/i);
      const enMatch = lb.match(/\bfrom\s+(.+?)\s+sent\b/i);
      senderName = (vnMatch?.[1] ?? enMatch?.[1] ?? "Người dùng").trim();

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

  for (const m of result.sentByMsgs as any[]) {
    const text: string = m.msgBody;
    const senderName: string = m.senderName;
    if (!text) continue;

    // Use cleaned message body for dedup key (not full label with timestamp)
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
// Poll loop — reload messenger.com to trigger fresh GraphQL fetches
// ---------------------------------------------------------------------------

function startPollLoop() {
  async function doPoll() {
    if (stopSignal || !bPage) return;

    try {
      // Reload the page to trigger fresh API calls + let E2EE decrypt + render
      await bPage.reload({ waitUntil: "domcontentloaded", timeout: 25000 });
      // Refresh tokens after reload
      const dtsg = await extractDtsg(bPage);
      if (dtsg) sessionDtsg = dtsg;
      const currentUrl = bPage.url();
      blog("info", { url: currentUrl }, "Poll reload done");

      // DOM scrape — works for both plain and E2EE threads
      await scrapeConversationDOM(bPage);

    } catch (err: any) {
      const msg = err?.message ?? String(err);
      blog("error", { err: msg }, "Poll reload error");
      if (msg.includes("Target closed") || msg.includes("browser has been closed")) {
        botState.status = "error";
        botState.error = "Browser gặp lỗi. Vui lòng dừng và khởi động lại bot.";
        return;
      }
    }

    if (!stopSignal) pollTimer = setTimeout(doPoll, 8000);
  }

  // First poll after a short delay to let the page fully settle
  pollTimer = setTimeout(doPoll, 6000);
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
      "--no-sandbox", "--disable-setuid-sandbox",
      "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled",
      "--disable-gpu",
    ],
  });

  bContext = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    locale: "en-US",
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
  });

  if (credentials.type === "appstate") {
    // Inject cookies for BOTH facebook.com AND messenger.com
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
    blog("info", { count: fbCookies.length }, "Cookies injected for facebook.com + messenger.com");
  }

  bPage = await bContext.newPage();

  // Set up interceptors BEFORE any navigation
  await setupInterceptor(bPage);

  // Step 1: Quick visit to facebook.com to establish session
  blog("info", {}, "Step 1: Establishing Facebook session...");
  await bPage.goto("https://www.facebook.com/", { waitUntil: "domcontentloaded", timeout: 30000 });

  const fbUrl = bPage.url();
  blog("info", { url: fbUrl }, "Facebook navigation result");

  if (fbUrl.includes("checkpoint")) {
    throw new Error("Tài khoản đang bị Facebook checkpoint. Vui lòng xác minh trên trình duyệt rồi thử lại với cookies mới.");
  }
  if (fbUrl.includes("/login")) {
    throw new Error("Cookie đã hết hạn hoặc không hợp lệ. Vui lòng lấy cookies mới từ trình duyệt.");
  }

  let uid = await extractUID(bPage);
  if (!uid && credentials.type === "appstate") {
    const cUser = credentials.appState.find((c: any) => c.key === "c_user");
    if (cUser) uid = String(cUser.value);
  }
  sessionUID = uid;

  // Step 2: Navigate to messenger.com (Facebook SSO kicks in automatically)
  blog("info", {}, "Step 2: Navigating to messenger.com...");
  const msgrResp = await bPage.goto("https://www.messenger.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
  const msgrUrl = bPage.url();
  blog("info", { status: msgrResp?.status(), url: msgrUrl }, "Messenger.com navigation result");

  if (msgrUrl.includes("/login") || msgrUrl.includes("facebook.com/login")) {
    throw new Error("Không đăng nhập được vào messenger.com. Cookie có thể đã hết hạn.");
  }

  const dtsg = await extractDtsg(bPage);
  if (!dtsg) {
    blog("warn", {}, "fb_dtsg not found on messenger.com — retrying on facebook.com");
    await bPage.goto("https://www.facebook.com/messages/", { waitUntil: "domcontentloaded", timeout: 20000 });
    const dtsg2 = await extractDtsg(bPage);
    if (!dtsg2) throw new Error("Không thể lấy token bảo mật (fb_dtsg). Cookie có thể không đủ hoặc đã hết hạn.");
    sessionDtsg = dtsg2;
  } else {
    sessionDtsg = dtsg;
  }

  blog("info", { uid, dtsgPrefix: sessionDtsg.substring(0, 10) + "...", msgrUrl }, "Session ready on messenger.com");

  botState.status = "running";
  botState.startedAt = new Date();
  botState.error = null;

  // Start poll loop (reload messenger.com → triggers fresh GraphQL calls → intercepted)
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
