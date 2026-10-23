export function createAccounting(deps: {
  api: (path: string, options?: { method?: string; body?: string }) => Promise<unknown>;
  el: (id: string) => any;
  esc: (value: unknown) => string;
  can: (capability: string) => boolean;
  current: () => { id: string } | null;
  openDrawer: (title: string, html: string, onMount?: () => void) => void;
  closeDrawer: () => void;
}): { render: () => Promise<void>; renderSettings: () => Promise<void> };
