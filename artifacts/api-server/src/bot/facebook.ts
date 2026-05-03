import { chromium, Browser, Page, BrowserContext, Route, Request } from "playwright";
import { logger } from "../lib/logger";
import { botState } from "./state";
import { getClaudeReply } from "./claude";

const CHROMIUM_PATH =
  "/nix/store/0n9rl5l9syy808xi9bk4f6dhnfrvhkww-playwright-browsers-chromium/chromium-1080/chrome-linux/chrome";

let browser: Browser | null = null;
let bContext: BrowserContext | null = null;
let bPage: Page | null = null;
let stopSignal = false;
let reloadTimer: ReturnType<typeof setTimeout> | null = null;

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
// Session helpers
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
// Process intercepted GraphQL batch responses
// ---------------------------------------------------------------------------

function parseGraphQLBatchLines(text: string): any[] {
  const lines = text.trim().split("\n").filter(Boolean);
  return lines.flatMap((line) => {
    // Strip for(;;); prefix
    const clean = line.replace(/^for\s*\(;;\);\s*/, "");
    try { return [JSON.parse(clean)]; } catch { return []; }
  });
}

async function processInterceptedData(text: string) {
  if (stopSignal) return;
  const parsed = parseGraphQLBatchLines(text);

  for (const item of parsed) {
    // Thread list response: viewer.message_threads.nodes
    const threadNodes: any[] =
      item?.o0?.data?.viewer?.message_threads?.nodes ?? [];

    for (const thread of threadNodes) {
      const threadID = String(
        thread?.thread_key?.thread_fbid ?? thread?.thread_key?.other_user_id ?? ""
      );
      const threadType: string = thread?.thread_type ?? "ONE_TO_ONE";
      if (!threadID) continue;

      // Check last message snippet
      const lastMsgNodes: any[] = thread?.last_message?.nodes ?? [];
      for (const msg of lastMsgNodes) {
        await checkAndHandleMsg(msg, threadID, threadType);
      }
    }

    // Single thread message response: message_thread.messages.nodes
    const msgNodes: any[] =
      item?.o0?.data?.message_thread?.messages?.nodes ?? [];
    const threadIDFromHistory = String(
      item?.o0?.data?.message_thread?.thread_key?.thread_fbid ??
      item?.o0?.data?.message_thread?.thread_key?.other_user_id ?? ""
    );
    const threadTypeFromHistory: string =
      item?.o0?.data?.message_thread?.thread_type ?? "ONE_TO_ONE";

    if (msgNodes.length > 0 && threadIDFromHistory) {
      for (const msg of msgNodes) {
        await checkAndHandleMsg(msg, threadIDFromHistory, threadTypeFromHistory);
      }
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

  const body: string =
    msg.message?.text ?? msg.body ?? msg.snippet ?? "";
  if (!body.trim()) return;

  lastSeenTimestamp.set(threadID, Math.max(lastSeen, ts));

  const msgId = msg.message_id ?? `${threadID}-${ts}`;
  await handleMessage(
    threadID,
    threadType,
    body,
    msg.message_sender?.name ?? "người dùng",
    senderId,
    msgId
  );
}

// ---------------------------------------------------------------------------
// Message handler → Claude reply
// ---------------------------------------------------------------------------

async function handleMessage(
  threadId: string,
  threadType: string,
  body: string,
  senderName: string,
  senderID: string,
  messageId: string
) {
  if (repliedMessageIds.has(messageId)) return;
  repliedMessageIds.add(messageId);
  if (repliedMessageIds.size > 500) {
    repliedMessageIds.delete(repliedMessageIds.values().next().value!);
  }

  if (!botState.autoReplyEnabled) return;
  if (!body.trim()) return;
  if (botState.ignoredThreadIds.has(threadId)) {
    logger.info({ threadId }, "Thread ignored");
    return;
  }

  logger.info({ threadId, senderID, body: body.substring(0, 80) }, "Message → Claude");

  if (!bPage) return;

  try {
    const reply = await getClaudeReply(threadId, body, botState.systemPrompt);
    await sendFbMessage(bPage, threadId, reply, threadType);
    botState.messagesHandled++;
    logger.info({ threadId, senderName }, "Reply sent");
  } catch (err) {
    logger.error({ err, threadId }, "Reply failed");
    try {
      await sendFbMessage(
        bPage,
        threadId,
        "Xin lỗi, tôi đang gặp sự cố kỹ thuật. Vui lòng thử lại sau.",
        threadType
      );
    } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Send message via browser fetch (proper Chrome TLS/headers)
// ---------------------------------------------------------------------------

function genOfflineId(): string {
  const epoch = BigInt(Date.now());
  const rand = BigInt(Math.floor(Math.random() * 0x3fffff));
  return String((epoch << 22n) | rand);
}

async function sendFbMessage(
  page: Page,
  threadID: string,
  text: string,
  threadType: string
): Promise<void> {
  const isGroup = threadType === "GROUP";
  const ts = String(Date.now());
  const offlineId = genOfflineId();

  const params: Record<string, string> = {
    client: "mercury",
    fb_dtsg: sessionDtsg,
    __user: sessionUID,
    action_type: "ma-type:user-generated-message",
    has_attachment: "false",
    message_id: `<${ts}:01:01>`,
    offline_threading_id: offlineId,
    source: "source:chat:web",
    body: text,
    timestamp: ts,
  };
  if (isGroup) {
    params["thread_fbid"] = threadID;
  } else {
    params["other_user_fbid"] = threadID;
  }

  const result = await page.evaluate(
    async ({ params }: { params: Record<string, string> }) => {
      const body = new URLSearchParams(params);
      const resp = await fetch("https://www.facebook.com/messaging/send/", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: body.toString(),
        credentials: "include",
      });
      const text = await resp.text();
      const clean = text.replace(/^for\s*\(;;\);\s*/, "");
      try { return JSON.parse(clean); } catch { return { __raw: text.slice(0, 300), __status: resp.status }; }
    },
    { params }
  );

  if (result?.__raw) {
    logger.warn({ raw: result.__raw, status: result.__status }, "Send: unexpected response");
  }
  if (result?.error_results?.length > 0) {
    throw new Error(`Send error: ${JSON.stringify(result.error_results[0])}`);
  }
}

// ---------------------------------------------------------------------------
// Route interceptor — captures Facebook's OWN graphqlbatch API calls
// ---------------------------------------------------------------------------

async function setupInterceptor(page: Page) {
  await page.route("**/api/graphqlbatch/**", async (route: Route, request: Request) => {
    try {
      const response = await route.fetch();
      const body = await response.text();

      // Process async (don't block the response)
      processInterceptedData(body).catch((err) =>
        logger.warn({ err: err?.message }, "processInterceptedData error")
      );

      await route.fulfill({ response, body });
    } catch (err: any) {
      logger.warn({ err: err?.message }, "Interceptor fetch error");
      await route.continue();
    }
  });
  logger.info("GraphQL batch interceptor registered");
}

// ---------------------------------------------------------------------------
// Reload loop — triggers Facebook to fetch fresh message data
// ---------------------------------------------------------------------------

function startReloadLoop() {
  async function doReload() {
    if (stopSignal || !bPage) return;

    try {
      await bPage.reload({ waitUntil: "domcontentloaded", timeout: 20000 });
      // Refresh dtsg after reload
      const dtsg = await extractDtsg(bPage);
      if (dtsg) sessionDtsg = dtsg;
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      logger.error({ err: msg }, "Reload error");

      const fatal =
        msg.includes("Target closed") ||
        msg.includes("browser has been closed") ||
        msg.includes("Navigation failed");

      if (fatal) {
        botState.status = "error";
        botState.error = "Browser gặp lỗi. Vui lòng dừng và khởi động lại bot.";
        return;
      }
    }

    if (!stopSignal) {
      reloadTimer = setTimeout(doReload, 5000);
    }
  }

  reloadTimer = setTimeout(doReload, 5000);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function startBot(credentials: LoginCredentials): Promise<void> {
  if (botState.status === "running" || botState.status === "connecting") {
    throw new Error("Bot đang chạy hoặc đang kết nối");
  }

  stopSignal = false;
  if (reloadTimer) { clearTimeout(reloadTimer); reloadTimer = null; }
  lastSeenTimestamp.clear();
  repliedMessageIds.clear();
  botState.status = "connecting";
  botState.error = null;
  botState.startedAt = null;
  botState.messagesHandled = 0;

  logger.info("Launching Chromium");

  browser = await chromium.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--disable-gpu",
    ],
  });

  bContext = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    locale: "en-US",
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
  });

  if (credentials.type === "appstate") {
    const cookies = credentials.appState.map((c: any) => ({
      name: c.key,
      value: c.value,
      domain: (c.domain ?? ".facebook.com").replace(/^(?!\.)/, "."),
      path: c.path ?? "/",
      expires: typeof c.expires === "number" && c.expires > 0 ? c.expires : -1,
      httpOnly: c.httpOnly ?? true,
      secure: c.secure ?? true,
      sameSite: "None" as const,
    }));
    await bContext.addCookies(cookies);
    logger.info({ count: cookies.length }, "Cookies injected");
  }

  bPage = await bContext.newPage();

  // Set up interceptor BEFORE navigating so we capture initial load calls
  await setupInterceptor(bPage);

  // Navigate to Facebook messages (triggers thread list API call)
  logger.info("Navigating to facebook.com/messages...");
  const response = await bPage.goto("https://www.facebook.com/messages/", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  const finalUrl = bPage.url();
  logger.info({ status: response?.status(), url: finalUrl }, "Navigation result");

  if (finalUrl.includes("checkpoint")) {
    throw new Error(
      "Tài khoản đang bị Facebook checkpoint. Vui lòng xác minh trên trình duyệt của bạn rồi thử lại với cookies mới."
    );
  }
  if (finalUrl.includes("/login")) {
    throw new Error(
      "Cookie đã hết hạn hoặc không hợp lệ. Vui lòng lấy cookies mới từ trình duyệt."
    );
  }

  const dtsg = await extractDtsg(bPage);
  if (!dtsg) {
    throw new Error(
      "Không thể lấy token bảo mật (fb_dtsg). Cookie có thể không đủ hoặc đã hết hạn."
    );
  }

  let uid = await extractUID(bPage);
  if (!uid && credentials.type === "appstate") {
    const cUser = credentials.appState.find((c: any) => c.key === "c_user");
    if (cUser) uid = String(cUser.value);
  }

  sessionDtsg = dtsg;
  sessionUID = uid;

  logger.info({ uid, dtsgPrefix: dtsg.substring(0, 10) + "..." }, "Session ready — interceptor active");

  botState.status = "running";
  botState.startedAt = new Date();
  botState.error = null;

  // Start reload loop (each reload triggers fresh FB API calls → intercepted)
  startReloadLoop();
}

export function stopBot(): void {
  stopSignal = true;
  if (reloadTimer) { clearTimeout(reloadTimer); reloadTimer = null; }
  if (browser) {
    browser.close().catch(() => {});
    browser = null;
    bContext = null;
    bPage = null;
  }
  botState.status = "stopped";
  botState.error = null;
  logger.info("Bot stopped");
}

export function getFacebookApi() {
  return bPage ? { active: true } : null;
}
