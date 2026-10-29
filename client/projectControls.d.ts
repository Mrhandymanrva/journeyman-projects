export function createProjectControls(options: {
  api: (
    path: string,
    init?: { method?: string; body?: string },
  ) => Promise<unknown>;
  el: (id: string) => any;
  esc: (value: unknown) => string;
  can: (capability: string) => boolean;
  current: () => { id?: string; currency?: string } | null | undefined;
  openDrawer: (title: string, html: string) => void;
  closeDrawer: () => void;
}): {
  mount: (page: string, targetId: string, tab?: string) => Promise<void>;
  dashboard: (targetId: string) => Promise<void>;
  cancel: () => void;
};
