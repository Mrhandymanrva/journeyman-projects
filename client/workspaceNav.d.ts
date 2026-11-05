export const SHOW_COMMUNICATIONS_TAB: boolean;
export const PROJECT_PAGE_ID: string;
export const PROJECT_PAGE_ALIASES: string[];
export const PROJECT_PAGE_ORDER: string[];
export const LABOR_PAGE_ID: string;
export const PRECON_ROLE_NOTE: string;
export const workspacePages: Record<string, [string, string]>;
export function navEntries(
  showCommunications?: boolean,
): Array<[string, [string, string]]>;
