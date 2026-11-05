export function csrHandoffHtml(
  view: Record<string, unknown>,
  opts: { esc: (value: unknown) => string; canSave: boolean },
): string;

export function bindCsrHandoff(
  root: { querySelector: (selector: string) => unknown },
  opts: {
    api: (path: string, options?: Record<string, unknown>) => Promise<unknown>;
    projectId: string;
    onSaved?: () => Promise<void> | void;
  },
): void;
