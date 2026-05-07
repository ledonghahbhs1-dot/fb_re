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

// On Replit (NixOS): set CHROMIUM_PATH env var or it auto-detects via REPL_ID.
// On Railway Docker (mcr.microsoft.com/playwright image): leave unset → Playwright
// finds the bundled Chromium automatically (no executablePath needed).
const CHROMIUM_PATH: string | undefined =
  process.env.CHROMIUM_PATH ??
  (process.env.REPL_ID
    ? "/nix/store/0n9rl5l9syy808xi9bk4f6dhnfrvhkww-playwright-browsers-chromium/chromium-1080/chrome-linux/chrome"
    : undefined);

// Persisted browser state (cookies + localStorage incl. E2EE keys).
// On Railway: mount a volume at /data and set STATE_DIR=/data for persistence
// across restarts. Without a volume, state resets on each deploy.
const STATE_BASE = process.env.STATE_DIR ?? path.join(process.cwd(), "dist");
const BROWSER_STATE_PATH = path.join(STATE_BASE, "browser-state.json");
// Flag written when bot starts successfully; deleted when manually stopped.
// Presence = user wants bot to auto-restart on server reboot.
const AUTOSTART_FLAG_PATH = path.join(STATE_BASE, "autostart.flag");

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

// ── Special error thrown when Facebook requires 2FA ─────────────────────────
export class TwoFactorRequired extends Error {
  constructor() {
    super("2FA_REQUIRED");
    this.name = "TwoFactorRequired";
  }
}

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
    if (!item || typeof item !== "object") continue;

    // ── Handle Facebook GraphQL error responses ──
    // Format: { __ar, error, errorSummary, errorDescription, isNotCritical, payload, ... }
    // These are NOT fatal — Facebook often returns errors for non-message queries.
    // We still try to extract data from `payload` if present.
    if (!Array.isArray(item) && item.error !== undefined) {
      const isCritical = !item.isNotCritical;
      blog(isCritical ? "warn" : "info", {
        source,
        errorSummary: item.errorSummary ?? item.error,
        errorDescription: item.errorDescription,
        hasPayload: !!item.payload,
      }, isCritical ? "GraphQL error response (critical)" : "GraphQL error response (non-critical, skipping)");

      // Try to salvage data from payload if present
      if (item.payload) await processDataNode(item.payload, source);
      continue;
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
  if (threadType === "GROUP" || threadType === "COMMUNITY") {
    blog("info", { threadId, threadType }, "Skipping group/community thread (DM-only mode)");
    return;
  }
  if (botState.ignoredThreadIds.has(threadId)) {
    blog("info", { threadId }, "Thread ignored");
    return;
  }

  blog("info", { threadId, senderID, body: body.substring(0, 80) }, "Message → Claude");
  if (!bPage) {
    blog("warn", { threadId }, "bPage is null — cannot reply");
    return;
  }

  try {
    const reply = await getClaudeReply(threadId, body, botState.systemPrompt);
    if (!reply || !reply.trim()) {
      blog("error", { threadId }, "AI returned empty reply — skipping send");
      return;
    }
    blog("info", { threadId, replyPreview: reply.substring(0, 80) }, "AI reply ready");
    await sendFbMessageUI(bPage, threadId, reply);
    botState.messagesHandled++;
    blog("info", { threadId, senderName }, "Reply sent ✓");
  } catch (err) {
    blog("error", { err: String(err), threadId }, "Reply failed — sending fallback");
    try {
      await sendFbMessageUI(bPage, threadId, "Xin lỗi, tôi đang gặp sự cố kỹ thuật. Vui lòng thử lại sau.");
      blog("info", { threadId }, "Fallback message sent");
    } catch (fbErr) {
      blog("error", { err: String(fbErr), threadId }, "Fallback send also failed");
    }
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

  // Wait for Lexical editor to fully mount
  await page.waitForTimeout(1500);

  const INPUT_SELECTORS = [
    '[aria-placeholder="Aa"]',
    '[contenteditable="true"][data-lexical-editor="true"]',
    '[aria-label*="Viết"][contenteditable="true"]',
    '[aria-label*="nhắn"][contenteditable="true"]',
    '[role="textbox"][contenteditable="true"]',
    '[contenteditable="true"]',
  ];

  // Focus the input and insert text using execCommand('insertText').
  // This is REQUIRED for Lexical/React editors — keyboard.type() only fires native
  // DOM events, but Lexical listens to execCommand-triggered InputEvent which
  // properly updates its internal EditorState so the message is non-empty on send.
  const result = await page.evaluate(
    ({ selectors, textToType }: { selectors: string[]; textToType: string }) => {
      for (const sel of selectors) {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el) continue;

        el.focus();
        el.click();

        // Clear any existing content
        document.execCommand("selectAll", false);
        document.execCommand("delete", false);

        // Insert text — this triggers Lexical's onBeforeInput/onInput handlers
        const ok = document.execCommand("insertText", false, textToType);

        return { sel, ok, len: el.textContent?.length ?? 0 };
      }
      return null;
    },
    { selectors: INPUT_SELECTORS, textToType: text }
  );

  if (!result) throw new Error("Không tìm thấy ô nhập tin nhắn");

  blog("info", { threadID, sel: result.sel, execOk: result.ok, editorLen: result.len }, "Text inserted into editor");

  // Give Lexical time to process the InputEvent and update its EditorState
  await page.waitForTimeout(400);

  // Press Enter to submit (Messenger sends on Enter, not Shift+Enter)
  await page.keyboard.press("Enter");
  await page.waitForTimeout(600);

  // Verify the input cleared (= message was submitted, not just newline)
  const afterLen = await page.evaluate((sel: string) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    return el?.textContent?.trim().length ?? 0;
  }, result.sel);

  if (afterLen > 0) {
    // Input still has text → Enter created a newline instead of sending.
    // Try clicking the send button as a fallback.
    blog("warn", { threadID, afterLen }, "Enter did not send — trying send button");
    const sendBtn = await page.evaluate(() => {
      // Facebook send button: role=button near the compose area
      const btns = Array.from(document.querySelectorAll('[aria-label="Gửi"], [aria-label="Send"]'));
      const btn = btns[0] as HTMLElement | null;
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (!sendBtn) await page.keyboard.press("Enter"); // last resort
    await page.waitForTimeout(600);
  }

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

    // ── Detect group chat — scan [role="main"] only (NOT whole document) ──
    // The sidebar is [role="navigation"] / [role="complementary"], NOT [role="main"],
    // so scanning mainEl is safe and won't give false positives from sidebar Groups links.
    let isGroupThread = false;
    let groupDetectReason = "";
    const mainEl = document.querySelector('[role="main"]');

    if (mainEl) {
      // Signal 1: any text node with "X thành viên" / "X members" pattern
      const mainText = mainEl.textContent ?? "";
      if (/\d+\s*(thành viên|members)/i.test(mainText)) {
        isGroupThread = true;
        const m = mainText.match(/\d+\s*(thành viên|members)/i);
        groupDetectReason = `main text: "${m?.[0]}"`;
      }

      // Signal 2: aria-labels containing group keywords (within main only)
      if (!isGroupThread) {
        mainEl.querySelectorAll("[aria-label]").forEach((el) => {
          if (isGroupThread) return;
          const lb = (el.getAttribute("aria-label") ?? "").toLowerCase();
          // Group-specific keywords — exclude message-action labels
          if (
            /thành viên|members|participants|nhóm chat|group chat|rời nhóm|leave group|add people|thêm người/i.test(lb) &&
            !/(gửi|send|reply|attach|emoji|like|react|sticker|gif|file|audio|video call|gọi)/i.test(lb)
          ) {
            isGroupThread = true;
            groupDetectReason = `main aria-label: "${lb.slice(0, 80)}"`;
          }
        });
      }

      // Signal 3: "Leave group" / "Rời nhóm" button (group-only UI element)
      if (!isGroupThread) {
        const leaveBtn = mainEl.querySelector('[aria-label*="Rời nhóm"], [aria-label*="Leave group"], [aria-label*="Leave Group"]');
        if (leaveBtn) {
          isGroupThread = true;
          groupDetectReason = "leave-group button found";
        }
      }

      // Signal 4: multiple distinct avatar images in the thread header area
      // Group chats show 2+ overlapping avatars; DMs show exactly 1
      if (!isGroupThread) {
        const headerEl = mainEl.querySelector("header");
        if (headerEl) {
          const avatarImgs = headerEl.querySelectorAll("img[src]");
          if (avatarImgs.length >= 2) {
            isGroupThread = true;
            groupDetectReason = `multiple avatars in header: ${avatarImgs.length}`;
          }
        }
      }
    }

    // ── Diagnostics: unique aria-labels on page (first 8) ──
    const allLabels: string[] = [];
    document.querySelectorAll("[aria-label]").forEach((el) => {
      const lb = el.getAttribute("aria-label")?.trim() ?? "";
      if (lb) allLabels.push(lb.slice(0, 60));
    });
    const uniqueLabels = [...new Set(allLabels)].slice(0, 10);

    return {
      threadID, isE2EE, url,
      isGroupThread, groupDetectReason,
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

  // ── Skip group/community threads — only reply to personal DMs ──
  if (result.isGroupThread) {
    blog("info", { threadID: result.threadID, reason: result.groupDetectReason }, "Skipping group thread (DM-only mode)");
    return;
  }

  blog("info", {
    threadID: result.threadID,
    isE2EE: result.isE2EE,
    isGroup: false,
    rowCount: result.rowCount,
    sentByCount: result.sentByCount,
    uniqueLabels: result.uniqueLabels,
  }, "DOM scrape diagnostics — thread is personal DM ✓");

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
    // First poll: mark everything as seen EXCEPT messages sent TODAY.
    // "Today" = timestamp after "gửi lúc" is just HH:MM (no date) or contains "hôm nay".
    // Messages with weekday names (Thứ...), month names (Tháng), or any year are OLD.
    let markedOld = 0;
    let keptRecent = 0;
    for (const m of result.sentByMsgs as any[]) {
      if (!m.msgBody) continue;
      const msgKey = `dom-${threadID}-${m.msgBody.slice(0, 50)}`;
      const lb: string = m.lb ?? "";
      // BUG FIX: use ": " (colon + space) as delimiter so "15:35 CH: msg" captures
      // "15:35 CH" instead of stopping at the first ":" inside the time "15:35".
      const tsMatch = lb.match(/gửi lúc\s+(.+?):\s/i) ?? lb.match(/sent at\s+(.+?):\s/i);
      const ts = tsMatch?.[1]?.trim() ?? "";
      // BUG FIX: handle optional space before period indicator — "15:35 CH", "3:35 ch",
      // "3:35 sáng", "3:35chiều", plain "15:35", or "hôm nay".
      const isToday =
        /^\d{1,2}:\d{2}(\s*(ch|chiều|sáng|am|pm))?$/i.test(ts) ||
        /hôm nay/i.test(ts) ||
        ts === "";   // empty ts = can't determine → treat as today to be safe
      blog("info", { ts, isToday, msgKey: msgKey.slice(0, 60) }, "initOnly: time check");
      if (isToday) {
        keptRecent++;
      } else {
        repliedMessageIds.add(msgKey);
        markedOld++;
      }
    }
    blog("info", { threadID, markedOld, keptRecent }, "First poll: old msgs marked seen, today's msgs queued for reply");
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
  // How often to do a full reload of the inbox (every N fast polls)
  const FULL_RELOAD_EVERY = 6;
  let fastPollCount = 0;

  async function doPoll() {
    if (stopSignal || !bPage) return;

    try {
      const currentUrl = bPage.url();
      const alreadyOnMessages =
        currentUrl.includes("facebook.com/messages") ||
        currentUrl.includes("messenger.com");

      if (firstPoll || !alreadyOnMessages || fastPollCount % FULL_RELOAD_EVERY === 0) {
        // Full navigation — needed on first poll or when page drifted
        await bPage.goto("https://www.facebook.com/messages/", {
          waitUntil: "domcontentloaded",
          timeout: 25000,
        });
        await bPage.waitForTimeout(1200);
      } else {
        // Fast reload — stays on same URL, triggers GraphQL interceptors
        await bPage.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
        await bPage.waitForTimeout(800);
      }

      fastPollCount++;

      const dtsg = await extractDtsg(bPage);
      if (dtsg) sessionDtsg = dtsg;

      // Discover conversations from the sidebar
      const threadIDs = await getSidebarThreadIDs(bPage);
      blog("info", { threadIDs, initOnly: firstPoll, fastPollCount }, "Poll: discovered conversations");

      if (firstPoll) {
        // On first poll: visit every thread to seed lastSeenTimestamp (no reply)
        for (const tid of threadIDs) {
          if (stopSignal) break;
          await bPage.goto(`https://www.facebook.com/messages/t/${tid}/`, {
            waitUntil: "domcontentloaded",
            timeout: 20000,
          });
          await bPage.waitForTimeout(900);
          await scrapeConversationDOM(bPage, true);
        }
      } else {
        // Subsequent polls: visit threads with unread badges PLUS always
        // check the top 3 sidebar threads as fallback (in case badge detection misses).
        const threadIDsWithNew = await bPage.evaluate(() => {
          // Facebook marks unread threads with a blue dot or bold text
          const unread: string[] = [];
          document.querySelectorAll('a[href*="/messages/t/"], a[href*="/messages/e2ee/t/"]').forEach((a) => {
            const href = a.getAttribute("href") ?? "";
            const m = href.match(/\/messages\/(?:e2ee\/)?t\/(\d+)/);
            if (!m?.[1]) return;
            // Heuristic: unread = has a visible badge/dot element inside
            const hasBadge =
              a.querySelector('[aria-label*="chưa đọc"], [aria-label*="unread"], [data-visualcompletion="ignore"]') !== null ||
              (a as HTMLElement).closest('[aria-label*="chưa đọc"]') !== null;
            if (hasBadge) unread.push(m[1]);
          });
          return unread;
        });

        // Always visit top 3 sidebar threads regardless of badge detection.
        // Badge heuristic often fails when Facebook changes DOM → toVisit was empty.
        const topThreads = threadIDs.slice(0, 3);
        const toVisit = [...new Set([...threadIDsWithNew, ...topThreads])].slice(0, 5);
        blog("info", { badgeThreads: threadIDsWithNew, topThreads, toVisit }, "Poll: threads to visit");

        for (const tid of toVisit) {
          if (stopSignal) break;
          await bPage.goto(`https://www.facebook.com/messages/t/${tid}/`, {
            waitUntil: "domcontentloaded",
            timeout: 15000,
          });
          await bPage.waitForTimeout(700);
          await scrapeConversationDOM(bPage, false);
          // Return to inbox after each thread
          await bPage.goto("https://www.facebook.com/messages/", {
            waitUntil: "domcontentloaded",
            timeout: 15000,
          });
          await bPage.waitForTimeout(600);
        }
      }

      firstPoll = false;

    } catch (err: any) {
      const msg = err?.message ?? String(err);
      blog("error", { err: msg }, "Poll error");

      const isFatal =
        msg.includes("browser has been closed") ||
        msg.includes("Browser closed") ||
        msg.includes("Target closed");

      const isCrash =
        msg.includes("Page crashed") ||
        msg.includes("page.goto: Page crashed") ||
        msg.includes("crashed");

      if (isFatal || isCrash) {
        blog("warn", { isFatal, isCrash }, "Browser closed/crashed — attempting full browser restart");
        try {
          // Tear down old browser completely
          try { browser?.close(); } catch {}
          browser = null; bContext = null; bPage = null;

          await new Promise((r) => setTimeout(r, 3000));
          if (stopSignal) return;

          // Relaunch browser with same flags
          browser = await chromium.launch({
            ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}),
            headless: true,
            args: [
              "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
              "--disable-blink-features=AutomationControlled",
              "--disable-gpu", "--disable-gpu-sandbox",
              "--disable-features=VizDisplayCompositor,TranslateUI,BlinkGenPropertyTrees",
              "--disable-accelerated-2d-canvas", "--disable-webgl",
              "--disable-software-rasterizer", "--disable-background-networking",
              "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
              "--disable-renderer-backgrounding", "--disable-ipc-flooding-protection",
              "--disable-hang-monitor", "--no-zygote", "--single-process",
              "--no-first-run", "--no-default-browser-check", "--ignore-certificate-errors",
              "--mute-audio", "--hide-scrollbars", "--memory-pressure-off",
              "--js-flags=--max-old-space-size=256",
            ],
          });

          const savedState = loadBrowserState();
          bContext = await browser.newContext({
            userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            locale: "vi-VN",
            viewport: { width: 1280, height: 800 },
            extraHTTPHeaders: { "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7" },
            ...(savedState ? { storageState: savedState as any } : {}),
          });
          await bContext.addInitScript(() => {
            Object.defineProperty(navigator, "webdriver", { get: () => false });
            // @ts-ignore
            if (!window.chrome) window.chrome = { runtime: {} };
          });

          bPage = await bContext.newPage();
          await setupInterceptor(bPage);
          blog("info", {}, "Browser restarted successfully — resuming poll");
          if (!stopSignal) pollTimer = setTimeout(doPoll, 5000);
        } catch (restartErr: any) {
          blog("error", { err: restartErr?.message }, "Browser restart failed — stopping bot");
          botState.status = "error";
          botState.error = "Không thể khởi động lại browser. Vui lòng dừng và khởi động lại bot.";
        }
        return;
      }
    }

    // Fast poll: 5s normally, slower after a full reload to let page settle
    if (!stopSignal) pollTimer = setTimeout(doPoll, 5000);
  }

  // First poll after a short delay to let the page fully settle
  pollTimer = setTimeout(doPoll, 4000);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// ── Post-login setup: navigate to messages, extract UID/DTSG, start poll ────
async function finishBotSetup(fallbackUID?: string): Promise<void> {
  if (!bPage || !bContext) throw new Error("Browser not initialized");

  blog("info", {}, "Navigating to facebook.com/messages/...");
  await bPage.goto("https://www.facebook.com/messages/", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  const fbUrl = bPage.url();
  blog("info", { url: fbUrl }, "Navigation result");

  if (fbUrl.includes("checkpoint")) {
    throw new Error("Tài khoản đang bị Facebook checkpoint. Vui lòng xác minh trên điện thoại rồi thử lại.");
  }
  if (fbUrl.includes("/login")) {
    try { fs.unlinkSync(BROWSER_STATE_PATH); } catch (_) {}
    throw new Error("Đăng nhập thất bại hoặc cookie đã hết hạn. Vui lòng thử lại.");
  }

  await bPage.waitForTimeout(3000);

  let uid = await extractUID(bPage);
  if (!uid && fallbackUID) uid = fallbackUID;
  sessionUID = uid;

  const dtsg = await extractDtsg(bPage);
  if (!dtsg) throw new Error("Không thể lấy token bảo mật (fb_dtsg). Vui lòng thử lại.");
  sessionDtsg = dtsg;

  await saveBrowserState(bContext);

  // Write autostart flag so server knows to restart bot after reboot
  try {
    fs.mkdirSync(STATE_BASE, { recursive: true });
    fs.writeFileSync(AUTOSTART_FLAG_PATH, new Date().toISOString());
  } catch {}

  blog("info", { uid, dtsgPrefix: sessionDtsg.substring(0, 10) + "..." }, "Session ready");

  botState.status = "running";
  botState.startedAt = new Date();
  botState.error = null;

  startPollLoop();
}

/** Check whether a saved browser state + autostart flag exist for auto-restart. */
export function canAutoRestart(): boolean {
  return fs.existsSync(AUTOSTART_FLAG_PATH) && fs.existsSync(BROWSER_STATE_PATH);
}

// ── Submit OTP code when Facebook requires 2-step verification ───────────────
export async function submit2FACode(code: string): Promise<void> {
  if (!bPage || botState.status !== "waiting_2fa") {
    throw new Error("Không có phiên 2FA đang chờ. Vui lòng đăng nhập lại.");
  }

  blog("info", {}, "Submitting 2FA OTP code");

  const codeInput = bPage.locator([
    'input[name="approvals_code"]',
    'input[name="otp"]',
    'input[autocomplete="one-time-code"]',
    'input[type="tel"]',
    'input[inputmode="numeric"]',
    'input[name="code"]',
  ].join(", "));

  await codeInput.waitFor({ timeout: 10000 });
  await codeInput.fill(code.trim());

  const submitDone = await bPage.evaluate(() => {
    const selectors = [
      "#checkpointSubmitButton",
      'button[name="submit[Continue]"]',
      'button[type="submit"]',
      'input[type="submit"]',
      "form button",
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (el) { el.click(); return sel; }
    }
    return null;
  });
  if (!submitDone) await codeInput.press("Enter");

  await bPage.waitForURL(
    (url) => !url.toString().includes("checkpoint") && !url.toString().includes("two_step"),
    { timeout: 20000 }
  ).catch(() => {});

  await bPage.waitForTimeout(2000);

  const postUrl = bPage.url();
  if (
    postUrl.includes("checkpoint") ||
    postUrl.includes("two_step") ||
    postUrl.includes("/login")
  ) {
    throw new Error("Mã xác minh không đúng hoặc đã hết hạn. Vui lòng thử lại.");
  }

  blog("info", { url: postUrl }, "2FA verified — continuing bot setup");
  botState.error = null;

  await finishBotSetup();
}

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
    ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}),
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--disable-gpu",
      "--disable-gpu-sandbox",
      "--disable-infobars",
      "--disable-extensions",
      "--disable-default-apps",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-features=VizDisplayCompositor,TranslateUI,BlinkGenPropertyTrees",
      "--disable-ipc-flooding-protection",
      "--disable-hang-monitor",
      "--disable-accelerated-2d-canvas",
      "--disable-webgl",
      "--disable-software-rasterizer",
      "--no-zygote",
      "--single-process",
      "--no-first-run",
      "--no-default-browser-check",
      "--ignore-certificate-errors",
      "--mute-audio",
      "--hide-scrollbars",
      "--memory-pressure-off",
      "--js-flags=--max-old-space-size=256",
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

  if (credentials.type === "credentials") {
    // ── Credentials login: automate Playwright browser login ──
    blog("info", { identifier: credentials.email }, "Performing credentials login via Playwright");

    await bPage.goto("https://m.facebook.com/login", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    const emailInput = bPage.locator('input[name="email"], input[type="email"], #m_login_email');
    await emailInput.waitFor({ timeout: 15000 });
    await emailInput.fill(credentials.email);

    const passInput = bPage.locator('input[name="pass"], input[type="password"]');
    await passInput.waitFor({ timeout: 10000 });
    await passInput.fill(credentials.password);

    // Try multiple strategies to submit the login form:
    // 1. Click any visible submit button inside the form
    // 2. Fallback: press Enter on the password field
    const submitted = await bPage.evaluate(() => {
      const selectors = [
        'button[name="login"]',
        'input[name="login"]',
        '[data-sigil="m_login_button"]',
        'button[type="submit"]',
        'input[type="submit"]',
        'form button',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (el) { el.click(); return sel; }
      }
      return null;
    });

    if (!submitted) {
      blog("info", {}, "No submit button found — pressing Enter on password field");
      await passInput.press("Enter");
    } else {
      blog("info", { submitted }, "Login button clicked");
    }

    await bPage.waitForURL((url) => !url.toString().includes("/login"), { timeout: 25000 }).catch(() => {});
    await bPage.waitForTimeout(2500);

    const loginUrl = bPage.url();
    const loginContent = await bPage.content();

    if (loginUrl.includes("/login") || loginUrl.includes("login.php")) {
      const hasError =
        loginContent.includes("Mật khẩu") ||
        loginContent.includes("password") ||
        loginContent.includes("incorrect") ||
        loginContent.includes("không đúng") ||
        loginContent.includes("error");
      if (hasError) {
        throw new Error("Email/SĐT/Facebook ID hoặc mật khẩu không đúng. Vui lòng kiểm tra lại.");
      }
    }

    if (
      loginUrl.includes("checkpoint") ||
      loginUrl.includes("two_step") ||
      loginUrl.includes("2fac") ||
      loginContent.includes("mã xác nhận") ||
      loginContent.includes("verification code") ||
      loginContent.includes("two-factor") ||
      loginContent.includes("approvals_code")
    ) {
      blog("info", { url: loginUrl }, "2FA detected — waiting for user OTP");
      botState.status = "waiting_2fa";
      botState.error = "Tài khoản yêu cầu xác minh 2 bước. Vui lòng nhập mã OTP để tiếp tục đăng nhập.";
      throw new TwoFactorRequired();
    }

    blog("info", { url: loginUrl }, "Credentials login succeeded");
  }

  // ── Post-login: navigate to messages, extract session data, start poll ─────
  let fallbackUID: string | undefined;
  if (credentials.type === "appstate") {
    const cUser = credentials.appState.find((c: any) => c.key === "c_user");
    if (cUser) fallbackUID = String(cUser.value);
  }

  await finishBotSetup(fallbackUID);
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
  // Remove autostart flag so server won't restart bot on next reboot
  try { fs.unlinkSync(AUTOSTART_FLAG_PATH); } catch {}
  blog("info", {}, "Bot stopped");
}

export function getFacebookApi() {
  return bPage ? { active: true } : null;
}
