export type BotStatus = "stopped" | "connecting" | "running" | "error" | "waiting_2fa";

export interface BotState {
  status: BotStatus;
  error: string | null;
  startedAt: Date | null;
  messagesHandled: number;
  systemPrompt: string;
  autoReplyEnabled: boolean;
  ignoredThreadIds: Set<string>;
}

const DEFAULT_PROMPT =
  "Bạn là một trợ lý AI thông minh, thân thiện và hữu ích. Hãy trả lời ngắn gọn, tự nhiên bằng tiếng Việt hoặc ngôn ngữ mà người dùng đang dùng. Không tiết lộ rằng bạn là AI trừ khi được hỏi trực tiếp.";

export const botState: BotState = {
  status: "stopped",
  error: null,
  startedAt: null,
  messagesHandled: 0,
  systemPrompt: process.env["SYSTEM_PROMPT"] ?? DEFAULT_PROMPT,
  autoReplyEnabled: true,
  ignoredThreadIds: new Set(),
};
