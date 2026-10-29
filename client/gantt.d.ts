export const GANTT_ROW_HEIGHT: number;
export const UNPHASED: string;

export function phaseColor(phase: string | null | undefined): string;
export function phaseName(row: { phase?: string | null }): string;
export function inclusiveDays(start: string, end: string): number;
export function phaseProgress(
  tasks: Array<{ status?: string; window_start: string; window_end: string }>,
): number;
export function groupGanttRows(rows: GanttRow[]): GanttGroup[];
export function loadCollapsed(): Set<string>;
export function saveCollapsed(phases: Set<string>): void;
export function collapsedSet(collapsed?: Set<string> | string[] | undefined): Set<string>;
export function ganttLayout(
  rows: GanttRow[],
  collapsed?: Set<string> | string[],
): {
  groups: GanttGroup[];
  visual: Array<
    | {
        kind: "phase";
        phase: string;
        start: string;
        end: string;
        progress: number;
        tasks: GanttRow[];
        collapsed: boolean;
        index: number;
        y: number;
      }
    | { kind: "task"; task: GanttRow; phase: string; index: number; y: number }
  >;
  anchorY(taskId: string): number | undefined;
  height: number;
};
export function dependencyArrows(
  rows: GanttRow[],
  options: { from: string; days: number; collapsed?: Set<string> | string[] },
): {
  layout: ReturnType<typeof ganttLayout>;
  arrows: Array<{
    predecessorId: string;
    successorId: string;
    x: number;
    y: number;
    x2: number;
    y2: number;
    d: string;
  }>;
};
export function renderGantt(input: {
  rows: GanttRow[];
  from: string;
  days: number;
  projectId?: string;
  editable?: boolean;
  esc: (value: unknown) => string;
  today?: string;
  collapsed?: Set<string> | string[];
}): string;
export function bindGantt(
  container: {
    querySelector(selector: string): { textContent: string } | null;
    querySelectorAll(selector: string): Iterable<{
      dataset: { ganttId?: string; ganttCollapse?: string };
      addEventListener(type: string, fn: (event: any) => void): void;
      getAttribute?(name: string): string | null;
    }>;
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
  },
  options: {
    rows: GanttRow[];
    save: (row: GanttRow, dates: { window_start: string; window_end: string }) => Promise<void>;
    rerender?: () => void;
  },
): void;

export interface GanttRow {
  id: string;
  title: string;
  phase?: string | null;
  window_start: string;
  window_end: string;
  status: string;
  source?: string;
  project_id?: string;
  dependencies?: Array<{ predecessor_id: string }>;
}

export interface GanttGroup {
  phase: string;
  tasks: GanttRow[];
  start: string;
  end: string;
  progress: number;
}
