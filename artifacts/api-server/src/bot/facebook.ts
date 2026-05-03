import { createRequire } from "node:module";
import { logger } from "../lib/logger";
import { botState } from "./state";
import { getClaudeReply } from "./claude";

const require = createRequire(import.meta.url);

let api: any = null;
let stopSignal = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

// Track the latest message timestamp per thread to avoid re-processing
const lastSeenTimestamp = new Map<string, number>();
// Track messages we've already replied to
const repliedMessageIds = new Set<string>();

export function getFacebookApi() {
  return api;
}

export type LoginCredentials =
  | { type: "credentials"; email: string; password: string }
  | { type: "appstate"; appState: any[] };

async function handleMessage(fbApi: any, threadId: string, body: string, senderName: string, senderID: string, messageId: string) {
  if (repliedMessageIds.has(messageId)) return;
  repliedMessageIds.add(messageId);

  // Limit set size
  if (repliedMessageIds.size > 500) {
    const first = repliedMessageIds.values().next().value;
    repliedMessageIds.delete(first);
  }

  if (!botState.autoReplyEnabled) return;
  if (!body.trim()) return;
  if (botState.ignoredThreadIds.has(threadId)) {
    logger.info({ threadId }, "Thread ignored, skipping");
    return;
  }

  logger.info({ threadId, senderID, body: body.substring(0, 80) }, "Message received — sending to Claude");

  try {
    const reply = await getClaudeReply(threadId, body, botState.systemPrompt);
    await new Promise<void>((res) => {
      fbApi.sendMessage(reply, threadId, (sendErr: any) => {
        if (sendErr) {
          logger.error({ err: sendErr, threadId }, "Failed to send message");
        } else {
          botState.messagesHandled++;
          logger.info({ threadId, senderName }, "Reply sent");
        }
        res();
      });
    });
  } catch (claudeErr) {
    logger.error({ err: claudeErr, threadId }, "Claude reply failed");
    fbApi.sendMessage("Xin lỗi, tôi đang gặp sự cố kỹ thuật. Vui lòng thử lại sau.", threadId, () => {});
  }
}

function startPolling(fbApi: any, myUserID: string) {
  if (stopSignal) return;

  logger.info("Starting HTTP polling fallback (MQTT unavailable)");
  botState.status = "running";
  botState.error = null;

  async function poll() {
    if (stopSignal) return;

    try {
      const threads: any[] = await new Promise((resolve, reject) => {
        fbApi.getThreadList(20, null, ["INBOX"], (err: any, list: any[]) => {
          if (err) reject(err);
          else resolve(list ?? []);
        });
      });

      for (const thread of threads) {
        if (stopSignal) break;
        const threadId: string = thread.threadID;
        const lastSeen = lastSeenTimestamp.get(threadId) ?? 0;

        // getThreadHistory to fetch recent messages
        const messages: any[] = await new Promise((resolve, reject) => {
          fbApi.getThreadHistory(threadId, 5, undefined, (err: any, history: any[]) => {
            if (err) reject(err);
            else resolve(history ?? []);
          });
        });

        for (const msg of messages) {
          if (stopSignal) break;
          const ts: number = msg.timestamp ? Number(msg.timestamp) : 0;
          if (ts <= lastSeen) continue;
          if (msg.senderID === myUserID) continue; // skip own messages
          if (!msg.body?.trim()) continue;

          lastSeenTimestamp.set(threadId, Math.max(lastSeen, ts));
          await handleMessage(fbApi, threadId, msg.body, msg.senderName ?? "người dùng", msg.senderID, msg.messageID ?? `${threadId}-${ts}`);
        }

        // Update last seen to latest message time
        if (messages.length > 0) {
          const latest = Math.max(...messages.map((m) => Number(m.timestamp ?? 0)));
          if (latest > (lastSeenTimestamp.get(threadId) ?? 0)) {
            lastSeenTimestamp.set(threadId, latest);
          }
        }
      }
    } catch (err: any) {
      logger.error({ err: err?.message ?? String(err) }, "Polling error");
      if (String(err).includes("Not logged in") || String(err?.error ?? "").includes("Not logged in")) {
        botState.status = "error";
        botState.error = "Phiên đăng nhập hết hạn. Vui lòng dừng bot và đăng nhập lại với cookies mới.";
        api = null;
        return;
      }
    }

    if (!stopSignal) {
      pollTimer = setTimeout(poll, 5000);
    }
  }

  poll();
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

  return new Promise((resolve, reject) => {
    let fca: any;
    try {
      fca = require("@xaviabot/fca-unofficial");
    } catch (err) {
      botState.status = "error";
      botState.error = "Không thể load thư viện @xaviabot/fca-unofficial";
      return reject(new Error("Không thể load thư viện @xaviabot/fca-unofficial"));
    }

    const loginOptions = {
      logLevel: "silent",
      selfListen: false,
      listenEvents: true,
      updatePresence: false,
      forceLogin: true,
      online: true,
    };

    const loginData =
      credentials.type === "appstate"
        ? { appState: credentials.appState }
        : { email: credentials.email, password: credentials.password };

    logger.info(
      { loginType: credentials.type, appStateLen: credentials.type === "appstate" ? credentials.appState.length : 0 },
      "Attempting Facebook login"
    );

    fca(loginData, loginOptions, (err: any, fbApi: any) => {
      if (err) {
        botState.status = "error";
        const errMsg =
          err.error ?? err.message ?? (typeof err === "string" ? err : JSON.stringify(err));
        botState.error = errMsg;
        logger.error({ err, errMsg }, "Facebook login failed");
        return reject(new Error(errMsg ?? "Đăng nhập thất bại"));
      }

      api = fbApi;
      botState.status = "running";
      botState.startedAt = new Date();

      const myUserID: string = fbApi.getCurrentUserID?.() ?? "";
      logger.info({ myUserID }, "Facebook bot connected");
      resolve();

      // Try MQTT first, fall back to HTTP polling if it fails
      let mqttFailed = false;

      try {
        fbApi.listenMqtt((listenErr: any, event: any) => {
          if (stopSignal) return;

          if (listenErr) {
            if (!mqttFailed) {
              mqttFailed = true;
              const errCode = listenErr.res?.error;
              const rawErr = listenErr.error ?? String(listenErr);
              logger.warn({ err: rawErr, errCode }, "MQTT failed — switching to HTTP polling");
              // Fall back to polling
              startPolling(fbApi, myUserID);
            }
            return;
          }

          if (!event) return;

          if (event.type !== "message") return;
          if (!event.body?.trim()) return;

          handleMessage(fbApi, event.threadID, event.body, event.senderName ?? "người dùng", event.senderID, event.messageID ?? `${event.threadID}-${event.timestamp}`);
        });
      } catch (mqttErr) {
        logger.warn({ err: mqttErr }, "MQTT threw exception — switching to HTTP polling");
        startPolling(fbApi, myUserID);
      }
    });
  });
}

export function stopBot(): void {
  stopSignal = true;
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  if (api) {
    try { api.logout(() => {}); } catch (_) {}
    api = null;
  }
  botState.status = "stopped";
  botState.error = null;
  logger.info("Facebook bot stopped");
}
