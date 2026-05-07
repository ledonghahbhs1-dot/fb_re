import { Router, type IRouter, type Request, type Response } from "express";
import { logger } from "../lib/logger";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

const router: IRouter = Router();

// ── AI client setup ────────────────────────────────────────────────────────
const replitBaseURL = process.env["AI_INTEGRATIONS_ANTHROPIC_BASE_URL"];
const replitApiKey  = process.env["AI_INTEGRATIONS_ANTHROPIC_API_KEY"];
const anthropicKey  = process.env["ANTHROPIC_API_KEY"];
const githubToken   = process.env["GITHUB_TOKEN"] ?? process.env["GITHUB_PERSONAL_ACCESS_TOKEN"];
const customBaseURL = process.env["AI_BASE_URL"];
const customApiKey  = process.env["AI_API_KEY"];
const AI_MODEL      = process.env["AI_MODEL"];

type Provider = "anthropic" | "openai-compat" | "none";
let provider: Provider = "none";
let anthropicClient: Anthropic | undefined;
let openaiClient: OpenAI | undefined;
let defaultModel: string = "claude-sonnet-4-6";

if (replitBaseURL && replitApiKey) {
  provider = "anthropic";
  anthropicClient = new Anthropic({ baseURL: replitBaseURL, apiKey: replitApiKey });
  defaultModel = AI_MODEL ?? "claude-sonnet-4-6";
} else if (anthropicKey) {
  provider = "anthropic";
  anthropicClient = new Anthropic({ apiKey: anthropicKey });
  defaultModel = AI_MODEL ?? "claude-sonnet-4-6";
} else if (githubToken) {
  provider = "openai-compat";
  openaiClient = new OpenAI({
    baseURL: "https://models.inference.ai.azure.com",
    apiKey: githubToken,
  });
  defaultModel = AI_MODEL ?? "gpt-4o-mini";
} else if (customBaseURL && customApiKey) {
  provider = "openai-compat";
  openaiClient = new OpenAI({ baseURL: customBaseURL, apiKey: customApiKey });
  defaultModel = AI_MODEL ?? "gpt-4o";
}

// ── Cookie parser ──────────────────────────────────────────────────────────
interface ParsedCookie {
  key: string;
  value: string;
}

function parseCookieString(raw: string): ParsedCookie[] {
  return raw
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .flatMap((part) => {
      const eqIdx = part.indexOf("=");
      if (eqIdx === -1) return [];
      return [{
        key: part.slice(0, eqIdx).trim(),
        value: part.slice(eqIdx + 1).trim(),
      }];
    });
}

function parseCookies(raw: string | Record<string, string>): ParsedCookie[] {
  if (typeof raw === "object" && raw !== null) {
    return Object.entries(raw).map(([key, value]) => ({ key, value }));
  }
  const trimmed = String(raw).trim();
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed);
      return Array.isArray(arr) ? arr.map((c: any) => ({ key: c.key ?? c.name, value: c.value })) : [];
    } catch { return []; }
  }
  return parseCookieString(trimmed);
}

// ── In-memory session store ────────────────────────────────────────────────
interface Session {
  cookies: ParsedCookie[];
  history: { role: "user" | "assistant"; content: string }[];
  createdAt: number;
  lastUsed: number;
}

const sessions = new Map<string, Session>();

// Clean sessions older than 2 hours
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, s] of sessions.entries()) {
    if (s.lastUsed < cutoff) sessions.delete(id);
  }
}, 30 * 60 * 1000);

function genSessionId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ── POST /api/chat ─────────────────────────────────────────────────────────
/**
 * Send a prompt using Facebook cookies for session identity.
 *
 * Body:
 *   cookies      – Cookie string "c_user=xxx; xs=yyy; ..."  OR  JSON object  OR  session_id
 *   prompt       – User message / question
 *   system_prompt – (optional) AI persona / instructions
 *   session_id   – (optional) Reuse an existing session (keeps history & cookies)
 *   model        – (optional) Override AI model
 */
router.post("/chat", async (req: Request, res: Response) => {
  const { cookies, prompt, system_prompt, session_id, model } = req.body as {
    cookies?: string | Record<string, string>;
    prompt?: string;
    system_prompt?: string;
    session_id?: string;
    model?: string;
  };

  if (!prompt || !prompt.trim()) {
    res.status(400).json({ error: "prompt là bắt buộc / prompt is required" });
    return;
  }

  if (provider === "none") {
    res.status(503).json({
      error: "Chưa cấu hình AI. Thêm một trong các biến môi trường: ANTHROPIC_API_KEY, GITHUB_TOKEN, hoặc AI_BASE_URL + AI_API_KEY",
    });
    return;
  }

  // Resolve or create session
  let session: Session | undefined;
  let sid: string;

  if (session_id && sessions.has(session_id)) {
    sid = session_id;
    session = sessions.get(session_id)!;
    session.lastUsed = Date.now();
  } else {
    sid = genSessionId();
    const parsed = cookies ? parseCookies(cookies) : [];
    session = {
      cookies: parsed,
      history: [],
      createdAt: Date.now(),
      lastUsed: Date.now(),
    };
    sessions.set(sid, session);
  }

  // If new cookies provided on existing session, update them
  if (cookies && session_id && sessions.has(session_id)) {
    session.cookies = parseCookies(cookies);
  }

  // Build context from cookies for the AI
  const cookieContext = session.cookies.length > 0
    ? `\n\n[Session context — Facebook cookies present: ${session.cookies.map((c) => c.key).join(", ")}]`
    : "";

  const sysPrompt = (system_prompt ?? "Bạn là một trợ lý AI hữu ích. Trả lời bằng ngôn ngữ người dùng đang dùng.") + cookieContext;

  // Append to history
  session.history.push({ role: "user", content: prompt.trim() });
  if (session.history.length > 20) session.history.splice(0, session.history.length - 20);

  const useModel = model ?? defaultModel;

  logger.info({ sid, model: useModel, provider, historyLen: session.history.length }, "POST /api/chat");

  try {
    let reply = "";

    if (provider === "anthropic" && anthropicClient) {
      const resp = await anthropicClient.messages.create({
        model: useModel,
        max_tokens: 1024,
        system: sysPrompt,
        messages: session.history,
      });
      const block = resp.content[0];
      reply = block.type === "text" ? block.text : "";
    } else if (openaiClient) {
      const msgs: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: "system", content: sysPrompt },
        ...session.history,
      ];
      const resp = await openaiClient.chat.completions.create({
        model: useModel,
        max_tokens: 1024,
        messages: msgs,
      });
      reply = resp.choices[0]?.message?.content ?? "";
    }

    session.history.push({ role: "assistant", content: reply });

    res.json({
      success: true,
      session_id: sid,
      reply,
      model: useModel,
      cookies_loaded: session.cookies.length,
      cookie_keys: session.cookies.map((c) => c.key),
      history_length: session.history.length,
    });
  } catch (err: any) {
    logger.error({ err: err?.message, sid }, "Chat error");
    res.status(500).json({ error: err?.message ?? "Lỗi không xác định" });
  }
});

// ── POST /api/chat/reset ───────────────────────────────────────────────────
router.post("/chat/reset", (req: Request, res: Response) => {
  const { session_id } = req.body as { session_id?: string };
  if (session_id && sessions.has(session_id)) {
    sessions.delete(session_id);
    res.json({ success: true, message: "Session đã được xóa" });
  } else {
    res.status(404).json({ error: "Không tìm thấy session" });
  }
});

// ── GET /api/chat/session/:id ─────────────────────────────────────────────
router.get("/chat/session/:id", (req: Request, res: Response) => {
  const session = sessions.get(String(req.params.id));
  if (!session) {
    res.status(404).json({ error: "Session không tồn tại" });
    return;
  }
  res.json({
    session_id: req.params.id,
    cookie_keys: session.cookies.map((c) => c.key),
    cookies_loaded: session.cookies.length,
    history_length: session.history.length,
    created_at: new Date(session.createdAt).toISOString(),
    last_used: new Date(session.lastUsed).toISOString(),
  });
});

export default router;
