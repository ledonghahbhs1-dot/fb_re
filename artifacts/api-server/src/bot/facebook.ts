import { createRequire } from "node:module";
import { logger } from "../lib/logger";
import { botState } from "./state";
import { getClaudeReply } from "./claude";

const require = createRequire(import.meta.url);

let api: any = null;
let stopSignal = false;

export function getFacebookApi() {
  return api;
}

export type LoginCredentials =
  | { type: "credentials"; email: string; password: string }
  | { type: "appstate"; appState: any[] };

export async function startBot(credentials: LoginCredentials): Promise<void> {
  if (botState.status === "running" || botState.status === "connecting") {
    throw new Error("Bot đang chạy hoặc đang kết nối");
  }

  stopSignal = false;
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
        logger.error({ err, errMsg, errType: typeof err, errKeys: err ? Object.keys(err) : [] }, "Facebook login failed");
        return reject(new Error(errMsg ?? "Đăng nhập thất bại"));
      }

      api = fbApi;
      botState.status = "running";
      botState.startedAt = new Date();

      if (credentials.type === "credentials") {
        try {
          const savedState = fbApi.getAppState();
          logger.info({ appState: JSON.stringify(savedState) }, "AppState saved for reuse");
        } catch (_) {}
      }

      logger.info("Facebook bot connected and listening");
      resolve();

      fbApi.setOptions({ listenEvents: true, logLevel: "silent" });

      fbApi.listenMqtt((listenErr: any, event: any) => {
        if (stopSignal) return;

        if (listenErr) {
          logger.error({ err: listenErr }, "Facebook listen error");
          botState.status = "error";
          api = null;
          const rawErr = listenErr.error ?? listenErr.res?.error ?? String(listenErr);
          const errCode = listenErr.res?.error;
          if (rawErr === "Not logged in" || errCode === 1357004) {
            botState.error =
              "Phiên đăng nhập hết hạn (Not logged in). Vui lòng dừng bot, lấy cookies mới từ trình duyệt và khởi động lại.";
          } else {
            botState.error = String(rawErr);
          }
          return;
        }

        if (!event) return;

        logger.info({ eventType: event.type, threadID: event.threadID, senderID: event.senderID }, "Event received");

        if (event.type !== "message") return;

        if (!botState.autoReplyEnabled) {
          logger.info({ threadId: event.threadID }, "Auto-reply disabled, skipping");
          return;
        }

        const threadId: string = event.threadID;
        const body: string = event.body ?? "";

        if (!body.trim()) return;

        if (botState.ignoredThreadIds.has(threadId)) {
          logger.info({ threadId }, "Thread ignored, skipping");
          return;
        }

        const senderName = event.senderName ?? "người dùng";
        logger.info({ threadId, senderID: event.senderID, body: body.substring(0, 80) }, "Message received — sending to Claude");

        getClaudeReply(threadId, body, botState.systemPrompt)
          .then((reply) => {
            fbApi.sendMessage(reply, threadId, (sendErr: any) => {
              if (sendErr) {
                logger.error({ err: sendErr, threadId }, "Failed to send message");
              } else {
                botState.messagesHandled++;
                logger.info({ threadId, senderName }, "Reply sent");
              }
            });
          })
          .catch((claudeErr) => {
            logger.error({ err: claudeErr, threadId }, "Claude reply failed");
            fbApi.sendMessage(
              "Xin lỗi, tôi đang gặp sự cố kỹ thuật. Vui lòng thử lại sau.",
              threadId,
              () => {}
            );
          });
      });
    });
  });
}

export function stopBot(): void {
  stopSignal = true;
  if (api) {
    try {
      api.logout(() => {});
    } catch (_) {}
    api = null;
  }
  botState.status = "stopped";
  botState.error = null;
  logger.info("Facebook bot stopped");
}
