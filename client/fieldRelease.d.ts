export const UNDO_CONFIRM: string;

export function fieldReleaseHtml(input: {
  release?: {
    released?: boolean;
    released_by?: string | null;
    released_at?: string | null;
    note?: string | null;
    history?: Array<{
      action?: string;
      note?: string | null;
      actor?: string | null;
      occurred_at?: string;
    }>;
  } | null;
  canRelease: boolean;
  esc: (value: unknown) => string;
  items?: unknown;
  showItems?: boolean;
}): string;

export function bindFieldRelease(
  root: { querySelector: (selector: string) => any } | null | undefined,
  handlers: {
    onRelease: (note: string) => Promise<unknown> | unknown;
    onUndo: (note: string) => Promise<unknown> | unknown;
    onError?: (err: { message?: string }) => void;
    confirm?: (message: string) => boolean;
  },
): void;
