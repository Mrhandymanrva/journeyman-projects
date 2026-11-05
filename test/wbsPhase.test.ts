import { afterAll, beforeAll, expect, it } from "vitest";
import { phases } from "../src/domain/pmCatalog.js";
import { controlData } from "../src/domain/projectControls.js";
import { createProjectControls } from "../client/projectControls.js";

const taskBody = {
  title: "Trim crew visit",
  start_on: "2026-10-29",
  due_on: "2026-10-30",
};

it("accepts a trimmed WBS phase and stores blank as no phase", () => {
  expect(controlData.task.parse({ ...taskBody, phase: "  Rough-in  " }).phase).toBe(
    "Rough-in",
  );
  expect(controlData.task.parse({ ...taskBody, phase: "Closeout" }).phase).toBe(
    "Closeout",
  );
  expect(controlData.task.parse({ ...taskBody, phase: "" }).phase).toBeNull();
  expect(controlData.task.parse({ ...taskBody, phase: "   " }).phase).toBeNull();
  expect(controlData.task.parse({ ...taskBody, phase: null }).phase).toBeNull();
  expect(controlData.task.parse(taskBody).phase).toBeNull();
  expect(
    controlData.task.safeParse({ ...taskBody, phase: "x".repeat(121) }).success,
  ).toBe(false);
  expect(controlData.task.safeParse({ ...taskBody, phase: 4 }).success).toBe(
    false,
  );
  expect(
    controlData.task.safeParse({ ...taskBody, phase: "Rough-in", extra: true })
      .success,
  ).toBe(false);
});

class FakeNode {
  tagName: string;
  id: string;
  type = "";
  multiple = false;
  checked = false;
  disabled = false;
  hidden = false;
  textContent = "";
  dataset: Record<string, string | undefined> = {};
  options: { value: string; selected: boolean }[] = [];
  children: FakeNode[] = [];
  onsubmit: ((event?: { preventDefault?: () => void }) => unknown) | null = null;
  private html = "";
  private current = "";
  private clickHandler: ((event?: { preventDefault?: () => void }) => unknown) | null =
    null;
  constructor(tag: string, id = "") {
    this.tagName = tag;
    this.id = id;
  }
  get value() {
    return this.current;
  }
  set value(next: string) {
    this.current = next == null ? "" : String(next);
    if (this.tagName === "SELECT" && !this.multiple) {
      for (const option of this.options)
        option.selected = option.value === this.current;
    }
  }
  get selectedOptions() {
    if (this.multiple) return this.options.filter((option) => option.selected);
    const match = this.options.find((option) => option.value === this.current);
    return match ? [match] : [];
  }
  set onclick(handler: FakeNode["clickHandler"]) {
    this.clickHandler = handler;
  }
  get onclick() {
    return this.clickHandler;
  }
  set innerHTML(value: string) {
    this.html = String(value ?? "");
    this.children = parseNodes(this.html);
    for (const child of this.children) {
      if (child.id && child.id !== this.id) nodes.set(child.id, child);
    }
  }
  get innerHTML() {
    return this.html;
  }
  querySelectorAll(selector: string) {
    if (selector === "[data-control-action]")
      return this.children.filter((node) => node.dataset.controlAction);
    if (selector === "[data-task-check]")
      return this.children.filter((node) => node.dataset.taskCheck);
    if (selector === "[data-goal-measures]")
      return this.children.filter((node) => node.dataset.goalMeasures);
    if (selector === '[id^="cf-"]')
      return this.children.filter((node) => node.id.startsWith("cf-"));
    return [];
  }
  addEventListener() {}
  replaceChildren() {
    this.children = [];
  }
  append() {}
}

const nodes = new Map<string, FakeNode>();

function el(id: string) {
  if (!nodes.has(id)) nodes.set(id, new FakeNode("DIV", id));
  return nodes.get(id)!;
}

function decode(value: string) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function attr(source: string, name: string) {
  const match = source.match(new RegExp("\\s" + name + '="([^"]*)"'));
  return match ? decode(match[1]!) : undefined;
}

function parseNodes(html: string) {
  const found: FakeNode[] = [];
  const tags = /<([a-zA-Z][\w:-]*)(\s[^>]*)?>/g;
  let match: RegExpExecArray | null;
  while ((match = tags.exec(html))) {
    const tag = match[1]!.toUpperCase();
    const attrs = match[2] ?? "";
    const id = attr(attrs, "id") ?? "";
    const action = attr(attrs, "data-control-action");
    const taskCheck = attr(attrs, "data-task-check");
    if (!id && !action && !taskCheck) continue;
    const node = new FakeNode(tag, id);
    node.multiple = /\smultiple\b/.test(attrs);
    node.type =
      attr(attrs, "type") ??
      (tag === "SELECT" ? (node.multiple ? "select-multiple" : "select-one") : "");
    node.checked = /\schecked\b/.test(attrs);
    node.dataset = {
      controlAction: action,
      record: attr(attrs, "data-record"),
      taskCheck,
      goalMeasures: attr(attrs, "data-goal-measures"),
    };
    if (tag === "SELECT") {
      const start = match.index + match[0].length;
      const end = html.indexOf("</select>", start);
      const inner = end >= 0 ? html.slice(start, end) : "";
      node.options = [...inner.matchAll(/<option\s+value="([^"]*)"([^>]*)>/g)].map(
        (option) => ({
          value: decode(option[1]!),
          selected: /\sselected\b/.test(option[2] ?? ""),
        }),
      );
      const selected = node.options.find((option) => option.selected);
      node.value =
        selected?.value ?? (node.multiple ? "" : (node.options[0]?.value ?? ""));
    } else if (tag === "TEXTAREA") {
      const start = match.index + match[0].length;
      const end = html.indexOf("</textarea>", start);
      node.value = decode(end >= 0 ? html.slice(start, end) : "");
    } else if (attr(attrs, "value") !== undefined) {
      node.value = attr(attrs, "value") ?? "";
    }
    found.push(node);
  }
  return found;
}

type BrowserGlobals = {
  document?: unknown;
  window?: unknown;
  location?: { search: string; pathname: string; hash: string };
};
const browser = globalThis as typeof globalThis & BrowserGlobals;
const previous = {
  document: browser.document,
  window: browser.window,
  location: browser.location,
};

beforeAll(() => {
  browser.location = { search: "", pathname: "/", hash: "" };
  browser.window = { history: { replaceState() {} }, confirm: () => true };
  browser.document = {
    getElementById: () => null,
    createElement: () => new FakeNode("DIV"),
    body: { appendChild() {} },
    querySelectorAll: () => [],
  };
});

afterAll(() => {
  browser.document = previous.document;
  browser.window = previous.window;
  browser.location = previous.location;
});

it("round-trips a phase through the WBS task form", async () => {
  const task = {
    id: "task-1",
    kind: "task",
    active: true,
    version: 1,
    data: {
      title: "Trim crew visit",
      description: "",
      owner_id: null as string | null,
      start_on: "2026-10-29",
      due_on: "2026-10-30",
      completed_on: null as string | null,
      state: "not_started",
      parent_id: null as string | null,
      dependency_ids: [] as string[],
      milestone_id: null as string | null,
      resource_id: null as string | null,
      job_link_id: "job-1",
      sort_order: 0,
    } as Record<string, unknown>,
  };
  const saved: Array<Record<string, unknown>> = [];
  const controls = createProjectControls({
    api: async (path: string, opts?: { method?: string; body?: string }) => {
      if (opts?.body) {
        const body = JSON.parse(opts.body) as { data: Record<string, unknown> };
        saved.push(body.data);
        task.data = body.data;
        task.version += 1;
        return { ...task };
      }
      if (path.endsWith("/controls"))
        return {
          records: [{ ...task, data: { ...task.data } }],
          baseline: null,
          history: [],
          rag: { schedule: "green", cost: "green" },
        };
      if (path === "/staff") return [];
      if (path === "/resources") return [];
      if (path.endsWith("/jobs"))
        return [
          {
            id: "job-1",
            external_job_id: "900185",
            source_job_number: "WBS-185",
            source_active: true,
          },
        ];
      if (path === "/planning-catalog")
        return { phases, trades: [], activities: [] };
      throw new Error("unexpected " + path);
    },
    el,
    esc: (value: unknown) =>
      String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;"),
    can: () => true,
    current: () => ({ id: "project-1", currency: "USD" }),
    openDrawer: (_title: string, html: string) => {
      const form = el("control-form");
      form.tagName = "FORM";
      form.innerHTML = html;
    },
    closeDrawer: () => {},
  });

  async function openEdit() {
    const button = el("plan-controls")
      .querySelectorAll("[data-control-action]")
      .find((node) => node.dataset.controlAction === "edit");
    expect(button?.onclick).toEqual(expect.any(Function));
    await button!.onclick!();
  }

  await controls.mount("plan", "plan-controls", "tasks");
  await openEdit();
  const phase = () => el("cf-phase");
  expect(phase().value).toBe("");
  expect(phase().options.map((option) => option.value)).toEqual(["", ...phases]);
  expect(el("plan-controls").innerHTML).not.toContain("Phase:");

  phase().value = "Rough-in";
  await el("control-form").onsubmit!({ preventDefault() {} });
  expect(saved.at(-1)?.phase).toBe("Rough-in");
  expect(saved.at(-1)?.title).toBe("Trim crew visit");
  expect(saved.at(-1)?.job_link_id).toBe("job-1");
  expect(el("plan-controls").innerHTML).toContain("Phase: Rough-in");

  await openEdit();
  expect(phase().value).toBe("Rough-in");
  phase().value = "";
  await el("control-form").onsubmit!({ preventDefault() {} });
  expect(saved.at(-1)?.phase).toBeNull();

  task.data = { ...task.data, phase: "Legacy finish" };
  await controls.mount("plan", "plan-controls", "tasks");
  await openEdit();
  expect(phase().value).toBe("Legacy finish");
  expect(phase().options.map((option) => option.value)).toContain("Legacy finish");
});
