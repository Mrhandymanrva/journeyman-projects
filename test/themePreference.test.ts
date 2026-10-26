import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  THEME_STORAGE_KEY,
  applyTheme,
  mountThemeControls,
  parseThemeChoice,
  readThemeChoice,
  resolveTheme,
  writeThemeChoice,
} from "../client/theme.js";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    getItem: (key: string) => (key in data ? data[key]! : null),
    setItem: (key: string, value: string) => {
      data[key] = value;
    },
    data,
  };
}

describe("theme preference", () => {
  it("treats a missing or unknown choice as system", () => {
    expect(parseThemeChoice(null)).toBe("system");
    expect(parseThemeChoice(undefined)).toBe("system");
    expect(parseThemeChoice("")).toBe("system");
    expect(parseThemeChoice("sepia")).toBe("system");
    expect(parseThemeChoice("light")).toBe("light");
    expect(parseThemeChoice("dark")).toBe("dark");
    expect(parseThemeChoice("system")).toBe("system");
  });

  it("follows the device only when the choice is system", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme(null, true)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("reads and writes the per-user choice", () => {
    const storage = memoryStorage();
    expect(readThemeChoice(storage)).toBe("system");
    expect(writeThemeChoice(storage, "dark")).toBe("dark");
    expect(storage.data[THEME_STORAGE_KEY]).toBe("dark");
    expect(readThemeChoice(storage)).toBe("dark");
    expect(writeThemeChoice(storage, "nope")).toBe("system");
    expect(readThemeChoice({ getItem: () => { throw new Error("blocked"); } })).toBe("system");
  });

  it("applies the resolved theme on the document element", () => {
    const root = { dataset: {} as { theme?: string; themeMode?: string }, style: { colorScheme: "" } };
    expect(applyTheme(root, "system", true)).toEqual({ mode: "system", theme: "dark" });
    expect(root.dataset.theme).toBe("dark");
    expect(root.dataset.themeMode).toBe("system");
    expect(root.style.colorScheme).toBe("dark");
    applyTheme(root, "light", true);
    expect(root.dataset.theme).toBe("light");
    expect(root.dataset.themeMode).toBe("light");
  });

  it("persists a toggle choice and keeps system in sync with the device", () => {
    const storage = memoryStorage({ [THEME_STORAGE_KEY]: "system" });
    const media = { matches: false, listener: null as null | (() => void), addEventListener: (_t: string, fn: () => void) => { media.listener = fn; } };
    const buttons = ["system", "light", "dark"].map((choice) => {
      const attrs: Record<string, string> = { "data-theme-choice": choice, "aria-pressed": "false" };
      return {
        getAttribute: (name: string) => attrs[name] ?? null,
        setAttribute: (name: string, value: string) => { attrs[name] = value; },
        attrs,
      };
    });
    const root = { dataset: {} as { theme?: string; themeMode?: string }, style: { colorScheme: "" } };
    let click: (event: { target: unknown }) => void = () => {};
    const doc = {
      documentElement: root,
      querySelectorAll: () => buttons,
      addEventListener: (type: string, fn: (event: { target: unknown }) => void) => { if (type === "click") click = fn; },
      contains: () => true,
    };
    mountThemeControls(doc, storage, media);
    expect(root.dataset.theme).toBe("light");
    expect(buttons.find((b) => b.attrs["data-theme-choice"] === "system")?.attrs["aria-pressed"]).toBe("true");

    click({ target: { closest: (sel: string) => (sel === "[data-theme-choice]" ? buttons[2] : null) } });
    expect(storage.data[THEME_STORAGE_KEY]).toBe("dark");
    expect(root.dataset.theme).toBe("dark");
    expect(buttons[2]?.attrs["aria-pressed"]).toBe("true");
    expect(buttons[0]?.attrs["aria-pressed"]).toBe("false");

    click({ target: { closest: (sel: string) => (sel === "[data-theme-choice]" ? buttons[0] : null) } });
    expect(root.dataset.theme).toBe("light");
    media.matches = true;
    media.listener?.();
    expect(root.dataset.theme).toBe("dark");
    expect(root.dataset.themeMode).toBe("system");
  });
});

function lin(channel: number) {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function lum(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}
function contrast(a: string, b: string) {
  const hi = Math.max(lum(a), lum(b));
  const lo = Math.min(lum(a), lum(b));
  return (hi + 0.05) / (lo + 0.05);
}
function hue(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  let r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return h;
}
function blockVars(css: string) {
  const vars: Record<string, string> = {};
  for (const match of css.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)) vars[match[1]!] = match[2]!.toLowerCase();
  return vars;
}

describe("theme tokens", () => {
  const css = fs.readFileSync("client/tokens.css", "utf8");
  const light = blockVars(css.slice(0, css.indexOf('html[data-theme="dark"]')));
  const dark = blockVars(css.slice(css.indexOf('html[data-theme="dark"]'), css.indexOf("@media print")));
  const print = blockVars(css.slice(css.indexOf("@media print")));

  const textPairs = [
    ["ink", "paper"],
    ["ink", "card"],
    ["ink", "surface"],
    ["ink", "today"],
    ["muted", "paper"],
    ["muted", "card"],
    ["muted", "surface"],
    ["accent", "paper"],
    ["accent", "card"],
    ["accent", "surface"],
    ["on-accent", "accent-strong"],
    ["on-accent", "accent"],
    ["accent-ink", "accent-soft"],
    ["status-track", "status-track-bg"],
    ["status-track", "card"],
    ["status-risk", "status-risk-bg"],
    ["status-risk", "card"],
    ["status-late", "status-late-bg"],
    ["status-late", "card"],
    ["status-done", "status-done-bg"],
    ["status-done", "card"],
    ["bar-planned-ink", "bar-planned"],
    ["bar-confirmed-ink", "bar-confirmed"],
    ["bar-progress-ink", "bar-progress"],
    ["bar-done-ink", "bar-done"],
  ] as const;

  it("keeps text at WCAG AA and separates status hues in both themes", () => {
    for (const [name, theme] of [["light", light], ["dark", dark]] as const) {
      for (const [fg, bg] of textPairs) {
        expect(contrast(theme[fg]!, theme[bg]!), `${name} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
      for (let i = 1; i <= 10; i++) {
        expect(contrast(theme["phase-ink"]!, theme[`phase-${i}`]!), `${name} phase ${i}`).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(theme["pip-idle"]!, theme.card!), `${name} idle pip`).toBeGreaterThanOrEqual(3);
      const hues = {
        track: hue(theme["status-track"]!),
        risk: hue(theme["status-risk"]!),
        late: hue(theme["status-late"]!),
        done: hue(theme["status-done"]!),
        accent: hue(theme.accent!),
      };
      const names = Object.keys(hues) as Array<keyof typeof hues>;
      for (let i = 0; i < names.length; i++) {
        for (let j = i + 1; j < names.length; j++) {
          let delta = Math.abs(hues[names[i]!] - hues[names[j]!]);
          if (delta > 180) delta = 360 - delta;
          expect(delta, `${name} ${names[i]} vs ${names[j]}`).toBeGreaterThanOrEqual(25);
        }
      }
    }
  });

  it("prints with the light palette", () => {
    for (const [key, value] of Object.entries(light)) expect(print[key]).toBe(value);
  });

  it("loads the saved choice before the first stylesheet", () => {
    for (const file of ["client/index.html", "client/bid-response.html"]) {
      const html = fs.readFileSync(file, "utf8");
      const scriptAt = html.indexOf(THEME_STORAGE_KEY);
      const cssAt = html.indexOf("tokens.css");
      expect(scriptAt, file).toBeGreaterThan(-1);
      expect(scriptAt, file).toBeLessThan(cssAt);
      expect(html).toContain('prefers-color-scheme: dark');
      expect(html).toContain('data-theme-choice="system"');
      expect(html).toContain('data-theme-choice="light"');
      expect(html).toContain('data-theme-choice="dark"');
    }
  });

  it("keeps raw colors in the token file", () => {
    const files = fs.readdirSync("client").filter((name) => /\.(css|html|js)$/.test(name) && name !== "tokens.css");
    for (const name of files) {
      const text = fs.readFileSync(`client/${name}`, "utf8");
      expect(text, name).not.toMatch(/(?<!&)#[0-9a-fA-F]{3,8}\b/);
    }
  });
});
