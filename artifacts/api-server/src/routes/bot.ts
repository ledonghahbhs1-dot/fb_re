import { Router, type IRouter } from "express";
import { logger } from "../lib/logger";
import { botState } from "../bot/state";
import { startBot, stopBot } from "../bot/facebook";
import { clearConversation } from "../bot/claude";

const router: IRouter = Router();

router.get("/bot/status", (_req, res) => {
  res.json({
    status: botState.status,
    error: botState.error,
    startedAt: botState.startedAt,
    messagesHandled: botState.messagesHandled,
    autoReplyEnabled: botState.autoReplyEnabled,
    systemPrompt: botState.systemPrompt,
  });
});

router.post("/bot/start", async (req, res) => {
  const { email, password } = req.body as { email?: string; password?: string };

  if (!email || !password) {
    res.status(400).json({ error: "Vui lòng cung cấp email và password" });
    return;
  }

  try {
    await startBot(email, password);
    res.json({ success: true, message: "Bot đã kết nối thành công" });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? "Đăng nhập thất bại" });
  }
});

router.post("/bot/stop", (_req, res) => {
  stopBot();
  res.json({ success: true, message: "Bot đã dừng" });
});

router.put("/bot/settings", (req, res) => {
  const { systemPrompt, autoReplyEnabled } = req.body as {
    systemPrompt?: string;
    autoReplyEnabled?: boolean;
  };

  if (systemPrompt !== undefined) {
    botState.systemPrompt = systemPrompt;
  }
  if (autoReplyEnabled !== undefined) {
    botState.autoReplyEnabled = autoReplyEnabled;
  }

  res.json({
    success: true,
    systemPrompt: botState.systemPrompt,
    autoReplyEnabled: botState.autoReplyEnabled,
  });
});

router.post("/bot/ignore-thread", (req, res) => {
  const { threadId, ignore } = req.body as { threadId?: string; ignore?: boolean };
  if (!threadId) {
    res.status(400).json({ error: "threadId là bắt buộc" });
    return;
  }
  if (ignore === false) {
    botState.ignoredThreadIds.delete(threadId);
  } else {
    botState.ignoredThreadIds.add(threadId);
  }
  res.json({ success: true, ignoredThreadIds: [...botState.ignoredThreadIds] });
});

router.post("/bot/clear-conversation", (req, res) => {
  const { threadId } = req.body as { threadId?: string };
  if (!threadId) {
    res.status(400).json({ error: "threadId là bắt buộc" });
    return;
  }
  clearConversation(threadId);
  res.json({ success: true, message: "Đã xóa lịch sử trò chuyện" });
});

export default router;
