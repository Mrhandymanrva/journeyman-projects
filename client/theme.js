export const THEME_STORAGE_KEY = "jp.theme";

export function parseThemeChoice(value) {
  if (value === "light" || value === "dark" || value === "system") return value;
  return "system";
}

/** System follows the device. Light and dark ignore it. */
export function resolveTheme(choice, prefersDark) {
  const mode = parseThemeChoice(choice);
  if (mode === "light") return "light";
  if (mode === "dark") return "dark";
  return prefersDark ? "dark" : "light";
}

export function readThemeChoice(storage) {
  try {
    return parseThemeChoice(storage?.getItem?.(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

export function writeThemeChoice(storage, choice) {
  const mode = parseThemeChoice(choice);
  storage.setItem(THEME_STORAGE_KEY, mode);
  return mode;
}

export function applyTheme(root, choice, prefersDark) {
  const mode = parseThemeChoice(choice);
  const theme = resolveTheme(mode, prefersDark);
  root.dataset.theme = theme;
  root.dataset.themeMode = mode;
  if (root.style) root.style.colorScheme = theme;
  return { mode, theme };
}

export function mountThemeControls(doc, storage, media) {
  const root = doc.documentElement;
  const query =
    media ??
    (typeof window !== "undefined"
      ? window.matchMedia("(prefers-color-scheme: dark)")
      : { matches: false });
  const store =
    storage ?? (typeof window !== "undefined" ? window.localStorage : null);
  function sync() {
    const applied = applyTheme(root, readThemeChoice(store), !!query.matches);
    doc.querySelectorAll("[data-theme-choice]").forEach((button) => {
      button.setAttribute(
        "aria-pressed",
        button.getAttribute("data-theme-choice") === applied.mode
          ? "true"
          : "false",
      );
    });
  }
  doc.addEventListener("click", (event) => {
    const target = event.target?.closest
      ? event.target
      : event.target?.parentElement;
    const button = target?.closest?.("[data-theme-choice]");
    if (!button || !doc.contains(button)) return;
    writeThemeChoice(store, button.getAttribute("data-theme-choice"));
    sync();
  });
  const onScheme = () => {
    if (readThemeChoice(store) === "system") sync();
  };
  if (query.addEventListener) query.addEventListener("change", onScheme);
  else if (query.addListener) query.addListener(onScheme);
  sync();
  return sync;
}
