export const SCHEDULE_PROGRESS_CAPTION: string;

export function appointmentReadWindow(
  today: string,
  project?: {
    scheduled_start?: string | null;
    scheduled_end?: string | null;
    actual_start?: string | null;
  },
): { from: string; to: string };

export function scheduleProgress(input: {
  activities?: unknown[];
  appointments?: unknown[];
  preconTasks?: unknown[];
  today: string;
}): {
  total: number;
  complete: number;
  percent: number | null;
  week: Array<{
    kind: string;
    id: string;
    title: string;
    start: string;
    end: string;
    complete: boolean;
    status: string;
    detail: string;
  }>;
  caption: string;
};
