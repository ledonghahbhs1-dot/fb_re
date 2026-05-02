export type BotStatus = "stopped" | "connecting" | "running" | "error";

export interface BotState {
  status: BotStatus;
  error: string | null;
  startedAt: Date | null;
  messagesHandled: number;
  systemPrompt: string;
  autoReplyEnabled: boolean;
  ignoredThreadIds: Set<string>;
}

export const botState: BotState = {
  status: "stopped",
  error: null,
  startedAt: null,
  messagesHandled: 0,
  systemPrompt:
    "Bạn là một trợ lý AI thông minh, thân thiện và hữu ích. Hãy trả lời ngắn gọn, tự nhiên bằng tiếng Việt hoặc ngôn ngữ mà người dùng đang dùng. Không tiết lộ rằng bạn là AI trừ khi được hỏi trực tiếp.",
  autoReplyEnabled: true,
  ignoredThreadIds: new Set(),
};
