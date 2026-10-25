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
  fieldStart?: {
    date?: string | null;
    source?: "servicetitan" | "manual" | null;
    observed_at?: string | null;
  } | null;
}): string;

export function fieldStartHtml(input: {
  fieldStart?: {
    date?: string | null;
    source?: string | null;
    observed_at?: string | null;
  } | null;
  canRefresh: boolean;
  canOverride: boolean;
  esc: (value: unknown) => string;
  compact?: boolean;
}): string;

export function bindFieldStart(
  root: { querySelector: (selector: string) => any } | null | undefined,
  handlers: {
    onRefresh: () => Promise<unknown> | unknown;
    onOverride: (date: string | null) => Promise<unknown> | unknown;
    onError?: (err: { message?: string }) => void;
  },
): void;

export function bindFieldRelease(
  root: { querySelector: (selector: string) => any } | null | undefined,
  handlers: {
    onRelease: (note: string) => Promise<unknown> | unknown;
    onUndo: (note: string) => Promise<unknown> | unknown;
    onError?: (err: { message?: string }) => void;
    confirm?: (message: string) => boolean;
  },
): void;
