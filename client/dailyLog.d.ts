export function todayInNewYork(now?: Date): string;

export function formatCalendarDay(value: unknown): string;

export function formatDailyLogStamp(log: {
  log_date?: unknown;
  created_at?: unknown;
} | null | undefined): string;
