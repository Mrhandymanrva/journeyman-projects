export const SCHEDULE_CAPTION: string;

export function addDays(date: string, n: number): string;

export function milestoneCredit(input?: {
  tasks?: Array<{ state?: string; data?: { state?: string } }>;
  linkedTotal?: number | string | null;
  linkedDone?: number | string | null;
  state?: string | null;
}): number;

export function milestoneIsComplete(input?: {
  tasks?: Array<{ state?: string; data?: { state?: string } }>;
  linkedTotal?: number | string | null;
  linkedDone?: number | string | null;
  state?: string | null;
}): boolean;

export function itemFromActivity(row: any): ScheduleItem;
export function itemFromAppointment(row: any): ScheduleItem;
export function itemFromPrecon(row: any): ScheduleItem;
export function itemFromWbs(row: any): ScheduleItem;
export function itemFromMilestone(row: any, tasks?: any[] | null): ScheduleItem;
export function itemFromPermit(row: any): ScheduleItem | null;

export interface ScheduleItem {
  kind: string;
  id: string;
  title: string;
  start: string;
  end: string;
  complete: boolean;
  cancelled: boolean;
  status: string;
  detail: string;
  project_id: string | null;
  project_number: string | null;
  project_name: string | null;
  owner_name: string | null;
  owner_role: string | null;
  overdue?: boolean;
}

export function buildScheduleItems(input?: {
  activities?: unknown[];
  appointments?: unknown[];
  preconTasks?: unknown[];
  wbsTasks?: unknown[];
  milestones?: unknown[];
  permitMilestones?: unknown[];
  controlRecords?: unknown[];
}): ScheduleItem[];

export function summarizeSchedule(
  items: Array<ScheduleItem | null | undefined>,
  today: string,
): {
  total: number;
  complete: number;
  percent: number | null;
  week: ScheduleItem[];
  due: ScheduleItem[];
  caption: string;
};
