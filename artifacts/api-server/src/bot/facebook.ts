import { chromium, Browser, Page, BrowserContext } from "playwright";
import { logger } from "../lib/logger";
import { botState } from "./state";
import { getClaudeReply } from "./claude";

const CHROMIUM_PATH =
  "/nix/store/0n9rl5l9syy808xi9bk4f6dhnfrvhkww-playwright-browsers-chromium/chromium-1080/chrome-linux/chrome";

let browser: Browser | null = null;
let bContext: BrowserContext | null = null;
let bPage: Page | null = null;
let stopSignal = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

const lastSeenTimestamp = new Map<string, number>();
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
      const t = s.textContent ?? "";
      const m =
        t.match(/\["DTSGInitialData",\[\],\{"token":"([^"]+)"/) ||
        t.match(/"token"\s*:\s*"([A-Za-z0-9_\-]{10,}[^"]*)"/) ||
        t.match(/name="fb_dtsg"\s+value="([^"]+)"/);
      if (m?.[1]) return m[1];
    }
    return "";
  });
}

async function refreshDtsg(page: Page): Promise<void> {
  try {
    const dtsg = await extractDtsg(page);
    if (dtsg) sessionDtsg = dtsg;
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Facebook API helpers (run via page.evaluate to use browser's HTTP stack)
// ---------------------------------------------------------------------------

async function fbPost(page: Page, url: string, params: Record<string, string>): Promise<any> {
  const result = await page.evaluate(
    async ({ url, params }: { url: string; params: Record<string, string> }) => {
      const body = new URLSearchParams(params);
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: body.toString(),
        credentials: "include",
      });
      const text = await resp.text();
      // Facebook prepends "for(;;);" as CSRF protection
      return JSON.parse(text.startsWith("for(;;);") ? text.slice(9) : text);
    },
    { url, params }
  );
  return result;
}

async function getThreadList(page: Page): Promise<any[]> {
  const resp = await fbPost(page, "https://www.facebook.com/ajax/mercury/threadlist_info.php", {
    client: "mercury",
    fb_dtsg: sessionDtsg,
    __user: sessionUID,
    "inbox[offset]": "0",
    "inbox[limit]": "20",
  });
  if (resp?.error) throw Object.assign(new Error("Thread list error"), { fbError: resp.error });
  return resp?.payload?.threads ?? [];
}

async function getThreadHistory(page: Page, threadID: string, threadType: string): Promise<any[]> {
  const isGroup = threadType === "GROUP";
  const keyType = isGroup ? "thread_fbids" : "user_ids";
  const form: Record<string, string> = {
    client: "mercury",
    fb_dtsg: sessionDtsg,
    __user: sessionUID,
    [`messages[${keyType}][${threadID}][offset]`]: "0",
    [`messages[${keyType}][${threadID}][timestamp]`]: "0",
    [`messages[${keyType}][${threadID}][limit]`]: "5",
  };
  try {
    const resp = await fbPost(page, "https://www.facebook.com/ajax/mercury/thread_info.php", form);
    if (resp?.payload?.actions) return resp.payload.actions;
    if (!isGroup) {
      // Retry with thread_fbids if user_ids returns nothing
      const form2 = {
        ...form,
        [`messages[thread_fbids][${threadID}][offset]`]: "0",
        [`messages[thread_fbids][${threadID}][timestamp]`]: "0",
        [`messages[thread_fbids][${threadID}][limit]`]: "5",
      };
      delete form2[`messages[user_ids][${threadID}][offset]`];
      delete form2[`messages[user_ids][${threadID}][timestamp]`];
      delete form2[`messages[user_ids][${threadID}][limit]`];
      const resp2 = await fbPost(page, "https://www.facebook.com/ajax/mercury/thread_info.php", form2);
      return resp2?.payload?.actions ?? [];
    }
  } catch (e: any) {
    logger.warn({ threadID, err: e?.message ?? String(e) }, "thread_info.php error");
  }
  return [];
}

function genOfflineId(): string {
  const epoch = BigInt(Date.now());
  const rand = BigInt(Math.floor(Math.random() * 0x3fffff));
  return String((epoch << 22n) | rand);
}

async function sendFbMessage(page: Page, threadID: string, text: string, threadType: string): Promise<void> {
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

  const resp = await fbPost(page, "https://www.facebook.com/messaging/send/", params);
  if (resp?.error_results?.length > 0) {
    throw new Error(`Send error: ${JSON.stringify(resp.error_results[0])}`);
  }
}

// ---------------------------------------------------------------------------
// Message handler
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
      await sendFbMessage(bPage, threadId, "Xin lỗi, tôi đang gặp sự cố kỹ thuật. Vui lòng thử lại sau.", threadType);
    } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Polling loop
// ---------------------------------------------------------------------------

function startPolling() {
  async function poll() {
    if (stopSignal || !bPage) return;

    try {
      const threads = await getThreadList(bPage);
      if (threads.length > 0) {
        logger.info({ count: threads.length }, "Poll OK");
      }

      for (const thread of threads) {
        if (stopSignal) break;
        const threadID: string = thread.threadID ?? thread.thread_fbid ?? "";
        const threadType: string = thread.threadType ?? "USER";
        if (!threadID) continue;

        const lastSeen = lastSeenTimestamp.get(threadID) ?? 0;
        const messages = await getThreadHistory(bPage, threadID, threadType);

        for (const msg of messages) {
          if (stopSignal) break;
          const ts = Number(msg.timestamp ?? 0);
          if (ts <= lastSeen) continue;

          const senderId: string = (msg.sender_fbid ?? msg.author ?? "").replace("fbid:", "");
          if (senderId === sessionUID) continue;
          if (!msg.body?.trim()) continue;

          lastSeenTimestamp.set(threadID, Math.max(lastSeen, ts));
          await handleMessage(
            threadID,
            threadType,
            msg.body,
            msg.sender_name ?? "người dùng",
            senderId,
            msg.message_id ?? `${threadID}-${ts}`
          );
        }

        if (messages.length > 0) {
          const latest = Math.max(...messages.map((m: any) => Number(m.timestamp ?? 0)));
          if (latest > (lastSeenTimestamp.get(threadID) ?? 0)) {
            lastSeenTimestamp.set(threadID, latest);
          }
        }
      }

      // Periodically refresh dtsg token
      await refreshDtsg(bPage);
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      logger.error({ err: msg }, "Poll error");

      const fatal =
        msg.toLowerCase().includes("not logged in") ||
        msg.includes("1357004") ||
        msg.includes("Target closed") ||
        msg.includes("browser has been closed");

      if (fatal) {
        botState.status = "error";
        botState.error = "Phiên đăng nhập hết hạn hoặc browser gặp lỗi. Vui lòng dừng và khởi động lại bot.";
        return;
      }
    }

    if (!stopSignal) {
      pollTimer = setTimeout(poll, 5000);
    }
  }

  poll();
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

  logger.info("Launching Chromium for Facebook bot");

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
    logger.info({ count: cookies.length }, "Cookies injected into browser");
  }

  bPage = await bContext.newPage();

  logger.info("Navigating to facebook.com...");
  const response = await bPage.goto("https://www.facebook.com/", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  const status = response?.status() ?? 0;
  const finalUrl = bPage.url();
  logger.info({ status, url: finalUrl }, "Facebook navigation result");

  if (finalUrl.includes("checkpoint")) {
    throw new Error(
      "Tài khoản đang bị Facebook checkpoint. Vui lòng xác minh trên trình duyệt của bạn rồi thử lại với cookies mới."
    );
  }
  if (finalUrl.includes("/login")) {
    throw new Error("Cookie đã hết hạn hoặc không hợp lệ. Vui lòng lấy cookies mới từ trình duyệt.");
  }

  const dtsg = await extractDtsg(bPage);
  if (!dtsg) {
    throw new Error(
      "Không thể lấy token bảo mật (fb_dtsg) từ Facebook. Cookie có thể không đủ hoặc đã hết hạn."
    );
  }

  const uid: string = await bPage.evaluate(() => {
    const m = document.cookie.match(/c_user=(\d+)/);
    return m?.[1] ?? "";
  });

  sessionDtsg = dtsg;
  sessionUID = uid;

  logger.info({ uid, dtsgPrefix: dtsg.substring(0, 10) + "..." }, "Playwright session ready");

  botState.status = "running";
  botState.startedAt = new Date();
  botState.error = null;

  startPolling();
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
  logger.info("Bot stopped");
}

export function getFacebookApi() {
  return bPage ? { active: true } : null;
}
