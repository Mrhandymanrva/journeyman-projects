/** Types for the Plan page module. The implementation is client/planning.js. */

export interface PlanningNode {
  hidden: boolean;
  insertAdjacentHTML(position: "beforebegin" | "afterbegin" | "beforeend" | "afterend", html: string): void;
  addEventListener(type: string, listener: (event: { target: PlanningNode }) => void): void;
  querySelectorAll(selector: string): ArrayLike<PlanningNode & { dataset: Record<string, string | undefined> }>;
}

export function createPlanning(deps: {
  api: (path: string, options?: { method?: string; body?: string }) => Promise<unknown>;
  el: (id: string) => (PlanningNode & Record<string, unknown>) | null;
  esc: (value: unknown) => string;
  can: (capability: string) => boolean;
  current: () => { id?: string } | null | undefined;
  openDrawer: (title: string, body: string, mount?: () => void) => void;
  submit: (target: unknown, action: () => Promise<unknown>) => unknown;
  field: (label: string, html: string) => string;
  messageSlot: string;
  refresh: () => Promise<void> | void;
}): {
  render: (rows: readonly unknown[]) => Promise<void>;
  refresh: () => Promise<void>;
  activity: (item?: unknown) => Promise<void>;
  resource: () => Promise<void>;
};
