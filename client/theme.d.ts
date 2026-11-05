export const THEME_STORAGE_KEY: string;

export function parseThemeChoice(
  value: string | null | undefined,
): "system" | "light" | "dark";

export function resolveTheme(
  choice: string | null | undefined,
  prefersDark: boolean,
): "light" | "dark";

export function readThemeChoice(storage: {
  getItem: (key: string) => string | null;
} | null | undefined): "system" | "light" | "dark";

export function writeThemeChoice(
  storage: { setItem: (key: string, value: string) => void },
  choice: string | null | undefined,
): "system" | "light" | "dark";

export function applyTheme(
  root: {
    dataset: { theme?: string; themeMode?: string };
    style?: { colorScheme?: string };
  },
  choice: string | null | undefined,
  prefersDark: boolean,
): { mode: "system" | "light" | "dark"; theme: "light" | "dark" };

export function mountThemeControls(
  doc: {
    documentElement: {
      dataset: { theme?: string; themeMode?: string };
      style?: { colorScheme?: string };
    };
    querySelectorAll: (selector: string) => Iterable<{
      getAttribute: (name: string) => string | null;
      setAttribute: (name: string, value: string) => void;
    }>;
    addEventListener: (type: string, fn: (event: any) => void) => void;
    contains: (node: unknown) => boolean;
  },
  storage?: { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void } | null,
  media?: {
    matches: boolean;
    addEventListener?: (type: string, fn: () => void) => void;
    addListener?: (fn: () => void) => void;
  },
): () => void;
