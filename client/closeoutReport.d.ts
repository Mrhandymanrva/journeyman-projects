export function reportFormState(
  view: Record<string, any>,
  options?: Record<string, any>,
): {
  live: boolean;
  figures: any;
  reportDate: string;
  narrative: Record<string, string>;
  postText: Record<string, string>;
  roles: Array<Record<string, any>>;
  risks: Array<Record<string, any>>;
  communications: Array<Record<string, any>>;
  outcomes: Array<Record<string, any>>;
  milestones: Array<Record<string, any>>;
};

export function closeoutReportHtml(
  view: Record<string, any>,
  helpers: {
    esc: (value: unknown) => string;
    preferLive?: boolean;
    draft?: Record<string, any>;
  },
): string;

export function closeoutReportPayload(root: any): {
  version: 1;
  report_date: string;
  roles: Array<Record<string, unknown>>;
  narrative: Record<string, string>;
  risks: Array<Record<string, unknown>>;
  communications: Array<Record<string, unknown>>;
  learning_outcomes: Array<Record<string, unknown>>;
  post_mortem: Record<string, unknown>;
};

export function mountCloseoutReport(
  host: {
    dataset: Record<string, string>;
    innerHTML: string;
    querySelector(selector: string): any;
    contains(node: unknown): boolean;
    addEventListener(type: string, listener: (event: any) => void): void;
  },
  deps: {
    projectId: string;
    projectNumber?: string;
    esc: (value: unknown) => string;
    alert: (message: string) => void;
    load: () => Promise<Record<string, any>>;
    save: (body: unknown) => Promise<Record<string, any>>;
    finalize: (body: unknown) => Promise<Record<string, any>>;
    fetchRaw: (path: string, options?: Record<string, unknown>) => Promise<any>;
  },
): Promise<void>;
