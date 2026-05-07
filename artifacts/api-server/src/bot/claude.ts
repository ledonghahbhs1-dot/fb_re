import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { logger } from "../lib/logger";

// ── API configuration ─────────────────────────────────────────────────────
// Priority order:
//  1. Replit AI integration proxy (Replit only)
//  2. Direct Anthropic API key
//  3. GitHub Models free tier  →  set GITHUB_TOKEN
//  4. Any OpenAI-compatible endpoint  →  set AI_BASE_URL + AI_API_KEY
//
// Railway deployment: use GITHUB_TOKEN (free) or ANTHROPIC_API_KEY (paid)
// ─────────────────────────────────────────────────────────────────────────

const replitBaseURL = process.env["AI_INTEGRATIONS_ANTHROPIC_BASE_URL"];
const replitApiKey  = process.env["AI_INTEGRATIONS_ANTHROPIC_API_KEY"];
const anthropicKey  = process.env["ANTHROPIC_API_KEY"];
const githubToken   = process.env["GITHUB_TOKEN"] ?? process.env["GITHUB_PERSONAL_ACCESS_TOKEN"];
const customBaseURL = process.env["AI_BASE_URL"];
const customApiKey  = process.env["AI_API_KEY"];

// Model override — useful when switching between providers
// GitHub Models: "claude-3-5-sonnet"  |  Anthropic: "claude-sonnet-4-5"
const AI_MODEL = process.env["AI_MODEL"];

type Provider = "anthropic" | "openai-compat";

let provider: Provider;
let anthropicClient: Anthropic | undefined;
let openaiClient: OpenAI | undefined;
let defaultModel: string;

if (replitBaseURL && replitApiKey) {
  provider = "anthropic";
  anthropicClient = new Anthropic({ baseURL: replitBaseURL, apiKey: replitApiKey });
  defaultModel = AI_MODEL ?? "claude-sonnet-4-6";
  logger.info("Claude: using Replit AI integration proxy");
} else if (anthropicKey) {
  provider = "anthropic";
  anthropicClient = new Anthropic({ apiKey: anthropicKey });
  defaultModel = AI_MODEL ?? "claude-sonnet-4-6";
  logger.info("Claude: using direct Anthropic API");
} else if (githubToken) {
  provider = "openai-compat";
  openaiClient = new OpenAI({
    baseURL: "https://models.inference.ai.azure.com",
    apiKey: githubToken,
  });
  defaultModel = AI_MODEL ?? "gpt-4o-mini";
  logger.info({ model: AI_MODEL ?? "gpt-4o-mini" }, "Claude: using GitHub Models free tier");
} else if (customBaseURL && customApiKey) {
  provider = "openai-compat";
  openaiClient = new OpenAI({ baseURL: customBaseURL, apiKey: customApiKey });
  defaultModel = AI_MODEL ?? "claude-3-5-sonnet";
  logger.info({ baseURL: customBaseURL }, "Claude: using custom OpenAI-compatible endpoint");
} else {
  logger.warn(
    "Chưa cấu hình AI. Thêm một trong: GITHUB_TOKEN, ANTHROPIC_API_KEY, hoặc AI_BASE_URL + AI_API_KEY. Bot sẽ không trả lời tin nhắn."
  );
  provider = "anthropic" as Provider;
  defaultModel = "claude-sonnet-4-6";
}

const conversationHistory = new Map<string, { role: "user" | "assistant"; content: string }[]>();

export async function getClaudeReply(
  threadId: string,
  userMessage: string,
  systemPrompt: string
): Promise<string> {
  const history = conversationHistory.get(threadId) ?? [];
  history.push({ role: "user", content: userMessage });
  if (history.length > 20) history.splice(0, history.length - 20);

  logger.info({ threadId, model: defaultModel, provider }, "Calling AI API");

  try {
    let replyText: string;

    if (provider === "anthropic" && anthropicClient) {
      const response = await anthropicClient.messages.create({
        model: defaultModel,
        max_tokens: 1024,
        system: systemPrompt,
        messages: history,
      });
      const block = response.content[0];
      replyText = block.type === "text" ? block.text : "";
    } else if (openaiClient) {
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: "system", content: systemPrompt },
        ...history,
      ];
      const response = await openaiClient.chat.completions.create({
        model: defaultModel,
        max_tokens: 1024,
        messages,
      });
      replyText = response.choices[0]?.message?.content ?? "";
    } else {
      throw new Error("No AI client configured");
    }

    logger.info({ threadId, replyLen: replyText.length }, "AI API success");
    history.push({ role: "assistant", content: replyText });
    conversationHistory.set(threadId, history);
    return replyText;
  } catch (err: any) {
    const errMsg = err?.message ?? String(err);
    const statusCode = err?.status ?? err?.statusCode ?? null;
    logger.error({ err: errMsg, statusCode, threadId, model: defaultModel, provider }, "AI API error");
    throw err;
  }
}

export function clearConversation(threadId: string) {
  conversationHistory.delete(threadId);
}

export function getConversationLength(threadId: string): number {
  return conversationHistory.get(threadId)?.length ?? 0;
}
