import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../lib/logger";

// Replit AI integration proxy (available on Replit only)
const replitBaseURL = process.env["AI_INTEGRATIONS_ANTHROPIC_BASE_URL"];
const replitApiKey = process.env["AI_INTEGRATIONS_ANTHROPIC_API_KEY"];

// Standard Anthropic API key (for Railway / any non-Replit deployment)
const directApiKey = process.env["ANTHROPIC_API_KEY"];

if (!replitApiKey && !directApiKey) {
  throw new Error(
    "Thiếu API key cho Claude. Trên Railway: thêm ANTHROPIC_API_KEY vào Variables. " +
    "Trên Replit: dùng Anthropic integration."
  );
}

const anthropic = replitBaseURL && replitApiKey
  ? new Anthropic({ baseURL: replitBaseURL, apiKey: replitApiKey })
  : new Anthropic({ apiKey: directApiKey! });

const conversationHistory = new Map<string, Anthropic.MessageParam[]>();

export async function getClaudeReply(
  threadId: string,
  userMessage: string,
  systemPrompt: string
): Promise<string> {
  const history = conversationHistory.get(threadId) ?? [];

  history.push({ role: "user", content: userMessage });

  if (history.length > 20) {
    history.splice(0, history.length - 20);
  }

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 8192,
      system: systemPrompt,
      messages: history,
    });

    const block = response.content[0];
    const replyText = block.type === "text" ? block.text : "";

    history.push({ role: "assistant", content: replyText });
    conversationHistory.set(threadId, history);

    return replyText;
  } catch (err) {
    logger.error({ err, threadId }, "Claude API error");
    throw err;
  }
}

export function clearConversation(threadId: string) {
  conversationHistory.delete(threadId);
}

export function getConversationLength(threadId: string): number {
  return conversationHistory.get(threadId)?.length ?? 0;
}
