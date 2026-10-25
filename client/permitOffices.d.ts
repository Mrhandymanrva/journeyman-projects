export function officeDirectoryHtml(input: {
  offices: unknown[];
  canEdit: boolean;
  esc: (value: unknown) => string;
}): string;

export function officeCardHtml(
  office: Record<string, unknown>,
  canEdit: boolean,
  esc: (value: unknown) => string,
): string;

export function createPermitOffices(input: {
  api: (path: string, options?: Record<string, unknown>) => Promise<any>;
  esc: (value: unknown) => string;
  can: (capability: string) => boolean;
  openDrawer: (title: string, body: string, onMount?: () => void) => void;
  closeDrawer: () => void;
}): {
  render: (target: { innerHTML: string; querySelector: (selector: string) => any; querySelectorAll: (selector: string) => Iterable<any> }, still?: () => boolean) => Promise<void>;
};
