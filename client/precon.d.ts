export const PRECON_STATUSES: Array<[string, string]>;
export const PRECON_TYPES: Array<[string, string]>;
export const INSPECTION_RESULTS: Array<[string, string]>;

export function preconHtml(input: {
  precon?: { open?: number; overdue?: number; tasks?: unknown[] } | null;
  canEdit: boolean;
  esc: (value: unknown) => string;
}): string;

export function bindPrecon(
  root: {
    querySelector: (selector: string) => any;
    querySelectorAll: (selector: string) => Iterable<any>;
  } | null
    | undefined,
  handlers: {
    onApply: () => Promise<unknown> | unknown;
    onAdd: () => void;
    onEdit: (id: string) => void;
    onInspect: (id: string) => void;
    onStatus: (id: string, status: string) => Promise<unknown> | unknown;
    onError?: (err: { message?: string }) => void;
  },
): void;
