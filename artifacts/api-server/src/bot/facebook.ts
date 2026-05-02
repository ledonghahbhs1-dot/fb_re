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

export async function startBot(email: string, password: string): Promise<void> {
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
      fca = require("fca-unofficial");
    } catch (err) {
      botState.status = "error";
      botState.error = "Không thể load thư viện fca-unofficial";
      return reject(new Error("Không thể load thư viện fca-unofficial"));
    }

    const loginOptions = {
      logLevel: "silent",
      selfListen: false,
      listenEvents: true,
      updatePresence: false,
      forceLogin: false,
    };

    fca({ email, password }, loginOptions, (err: any, fbApi: any) => {
      if (err) {
        botState.status = "error";
        botState.error = err.error ?? err.message ?? String(err);
        logger.error({ err: botState.error }, "Facebook login failed");
        return reject(new Error(botState.error ?? "Đăng nhập thất bại"));
      }

      api = fbApi;
      botState.status = "running";
      botState.startedAt = new Date();
      logger.info("Facebook bot connected and listening");
      resolve();

      fbApi.setOptions({ listenEvents: true, logLevel: "silent" });

      fbApi.listenMqtt((listenErr: any, event: any) => {
        if (stopSignal) return;

        if (listenErr) {
          logger.error({ err: listenErr }, "Facebook listen error");
          botState.status = "error";
          botState.error = listenErr.error ?? String(listenErr);
          return;
        }

        if (!event || event.type !== "message") return;
        if (event.isGroup && false) return;

        if (!botState.autoReplyEnabled) return;

        const threadId: string = event.threadID;
        const body: string = event.body ?? "";

        if (!body.trim()) return;

        if (botState.ignoredThreadIds.has(threadId)) return;

        const senderName = event.senderName ?? "người dùng";
        logger.info({ threadId, body: body.substring(0, 80) }, "Message received");

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
