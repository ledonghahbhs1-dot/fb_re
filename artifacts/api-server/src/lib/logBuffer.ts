export interface LogEntry {
  ts: number;
  level: string;
  msg: string;
  data?: Record<string, any>;
}

const MAX = 300;
const buffer: LogEntry[] = [];

export function bufferLog(level: string, msg: string, data?: Record<string, any>) {
  buffer.push({ ts: Date.now(), level, msg, data });
  if (buffer.length > MAX) buffer.shift();
}

export function getRecentLogs(since?: number): LogEntry[] {
  if (!since) return buffer.slice(-100);
  return buffer.filter((e) => e.ts > since);
}
