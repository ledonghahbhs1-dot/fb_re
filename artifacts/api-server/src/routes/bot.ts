import { Router, type IRouter } from "express";
import { botState } from "../bot/state";
import { startBot, stopBot, submit2FACode, TwoFactorRequired } from "../bot/facebook";
import { clearConversation } from "../bot/claude";
import { logger } from "../lib/logger";
import { getRecentLogs } from "../lib/logBuffer";

const router: IRouter = Router();

/**
 * Convert cookie string (e.g. "c_user=123; xs=abc") to AppState array format
 * used by fca-unofficial.
 */
function cookieStringToAppState(cookieStr: string): any[] {
  return cookieStr
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eqIdx = part.indexOf("=");
      if (eqIdx === -1) return null;
      const key = part.slice(0, eqIdx).trim();
      const value = part.slice(eqIdx + 1).trim();
      return {
        key,
        value,
        domain: ".facebook.com",
        path: "/",
        hostOnly: false,
        creation: new Date().toISOString(),
        lastAccessed: new Date().toISOString(),
      };
    })
    .filter(Boolean);
}

/**
 * Parse AppState from user input — accepts:
 *   1. JSON array (fca-unofficial native format)
 *   2. Cookie string "c_user=xxx; xs=xxx; ..."
 */
function parseAppState(raw: string): { parsed: any[]; error?: string } {
  const trimmed = raw.trim();

  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) {
        return { parsed: [], error: "AppState phải là một JSON array" };
      }
      if (parsed.length === 0) {
        return { parsed: [], error: "AppState array không được rỗng" };
      }
      return { parsed };
    } catch (e: any) {
      return { parsed: [], error: "JSON không hợp lệ: " + e.message };
    }
  }

  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed);
      return { parsed: [obj] };
    } catch (e: any) {
      return { parsed: [], error: "JSON object không hợp lệ: " + e.message };
    }
  }

  if (trimmed.includes("=")) {
    const converted = cookieStringToAppState(trimmed);
    if (converted.length === 0) {
      return { parsed: [], error: "Không thể đọc cookie string" };
    }
    logger.info({ count: converted.length }, "Converted cookie string to AppState");
    return { parsed: converted };
  }

  return {
    parsed: [],
    error:
      'Định dạng không hợp lệ. Cần JSON array ([{...},...]) hoặc cookie string (c_user=xxx; xs=xxx; ...)',
  };
}

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
  const body = req.body as {
    email?: string;
    identifier?: string;
    password?: string;
    appState?: string;
  };
  // Support both "email" (legacy) and "identifier" (email / phone / FB ID)
  const identifier = body.identifier ?? body.email;
  const { password, appState } = body;

  try {
    if (appState) {
      const { parsed, error } = parseAppState(appState);
      if (error) {
        res.status(400).json({ error });
        return;
      }

      // Validate required cookies are present
      const keys = parsed.map((c: any) => (c.key ?? c.name ?? "").toLowerCase());
      logger.info({ keys, appStateEntries: parsed.length }, "Parsed AppState keys");

      if (!keys.includes("xs")) {
        res.status(400).json({
          error:
            "Cookie thiếu 'xs' — đây là cookie quan trọng nhất. Vui lòng copy lại đủ cookie từ DevTools (bao gồm xs, c_user, datr).",
        });
        return;
      }
      if (!keys.includes("c_user")) {
        res.status(400).json({
          error: "Cookie thiếu 'c_user' (ID Facebook). Vui lòng copy lại đủ cookie.",
        });
        return;
      }

      await startBot({ type: "appstate", appState: parsed });
    } else if (identifier && password) {
      await startBot({ type: "credentials", email: identifier.trim(), password });
    } else {
      res.status(400).json({ error: "Vui lòng cung cấp email/SĐT/Facebook ID + password hoặc appState" });
      return;
    }

    res.json({ success: true, message: "Bot đã kết nối thành công" });
  } catch (err: any) {
    if (err instanceof TwoFactorRequired || err?.name === "TwoFactorRequired") {
      res.json({ success: true, requires_2fa: true, message: "Cần nhập mã xác minh 2FA để hoàn tất đăng nhập" });
      return;
    }
    res.status(500).json({ error: err.message ?? "Đăng nhập thất bại" });
  }
});

router.post("/bot/2fa", async (req, res) => {
  const { code } = req.body as { code?: string };
  if (!code?.trim()) {
    res.status(400).json({ error: "Vui lòng cung cấp mã xác minh 2FA" });
    return;
  }
  try {
    await submit2FACode(code.trim());
    res.json({ success: true, message: "Xác minh 2FA thành công. Bot đã kết nối!" });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? "Xác minh 2FA thất bại" });
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

router.get("/bot/logs", (req, res) => {
  const since = req.query.since ? Number(req.query.since) : undefined;
  res.json({ logs: getRecentLogs(since) });
});

export default router;
