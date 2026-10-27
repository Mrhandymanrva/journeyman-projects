import { formRow } from "./formRows.js";

export const UNDO_CONFIRM =
  "Undo the field release? This clears the current release. The history is kept.";

function when(value) {
  if (!value) return "";
  const text = String(value);
  const match = text.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  return match ? `${match[1]} ${match[2]} UTC` : text;
}

function labels(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => {
    if (typeof item === "string") return { label: item, done: false };
    return {
      label: String(item?.label || item?.key || "Item"),
      done: item?.done === true,
    };
  });
}

/**
 * Gate-view markup for the field-release flag.
 * `items` are the Gate 2 checklist labels, shown beside the flag.
 * Passing `showItems: false` omits that column when the checklist is already
 * on screen, which is how the gate drawer uses it.
 */
export function fieldReleaseHtml({
  release,
  canRelease,
  esc,
  items,
  showItems = true,
  fieldStart,
}) {
  const current = release || {};
  const history = Array.isArray(current.history) ? current.history : [];
  const status = current.released
    ? `Released by ${esc(current.released_by || "unknown")} at ${esc(when(current.released_at))}.`
    : "Not released.";
  const note =
    current.released && current.note
      ? `<p class="field-release-current-note">Note: ${esc(current.note)}</p>`
      : "";
  const itemList = labels(items);
  const itemsHtml = itemList.length
    ? `<ul class="field-release-items">${itemList
        .map(
          (item) =>
            `<li class="${item.done ? "done" : ""}">${esc(item.label)}</li>`,
        )
        .join("")}</ul>`
    : `<p class="note">No checklist items on Gate 2.</p>`;
  const form = canRelease
    ? `<label>Note (optional)<textarea class="field-release-note" maxlength="2000" placeholder="Optional"></textarea></label>
       <div class="actions">
         <button class="btn primary field-release-go" type="button">Release</button>
         <button class="btn danger field-release-undo" type="button"${current.released ? "" : " disabled"}>Undo</button>
       </div>`
    : `<p class="note">You can view the field release. An owner or manager records it.</p>`;
  const historyHtml = history.length
    ? `<ul class="field-release-history">${history
        .map((event) => {
          const action = event.action === "undo" ? "Undo" : "Release";
          const eventNote = event.note ? esc(event.note) : "No note";
          return `<li data-action="${esc(event.action)}"><b>${action}</b> · ${esc(event.actor || "unknown")} · ${esc(when(event.occurred_at))} · ${eventNote}</li>`;
        })
        .join("")}</ul>`
    : `<p class="note">No release history.</p>`;
  const itemsColumn = showItems
    ? `<div><span class="lbl">Gate 2 items</span>${itemsHtml}<p class="note">Open Gate 2 to tick these. Field release does not change them.</p></div>`
    : "";
  return `<section class="field-release" data-gate="2">
    <div class="field-release-grid">
      ${itemsColumn}
      <div>
        <span class="lbl">Field release</span>
        <p class="field-release-status">${status}</p>
        ${note}
        <p class="note">A flag only. It does not block scheduling, gates, or any other step.</p>
        ${fieldStart ? fieldStartHtml({ fieldStart, canRefresh: false, canOverride: false, esc, compact: true }) : ""}
        ${form}
        <span class="lbl">History</span>
        ${historyHtml}
        <p class="field-release-msg"></p>
      </div>
    </div>
  </section>`;
}

function sourceLabel(source) {
  if (source === "servicetitan") return "ServiceTitan";
  if (source === "manual") return "Manual";
  return "Not set";
}

function calendarLabel(value) {
  const match = String(value || "").match(/^(\d{4}-\d{2}-\d{2})/);
  if (!match) return "Not set";
  return new Date(match[1] + "T12:00:00").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function observedLabel(value) {
  if (!value) return "";
  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  return match ? `${match[1]} ${match[2]} UTC` : String(value);
}

/**
 * Field start is the earliest ServiceTitan appointment day, or a manual date.
 * It is separate from the logged start on the project.
 * `compact` is the one-line form used beside a field release.
 */
export function fieldStartHtml({
  fieldStart,
  canRefresh,
  canOverride,
  esc,
  compact = false,
}) {
  const current = fieldStart || {};
  const source =
    current.source === "servicetitan" || current.source === "manual"
      ? current.source
      : "";
  const when = current.date ? calendarLabel(current.date) : "not set";
  const line = `Field start ${when}${source ? " · " + sourceLabel(source) : ""}.`;
  if (compact) return `<p class="field-start-line">${esc(line)}</p>`;
  const observed = current.observed_at
    ? `<p class="note">Last observed ${esc(observedLabel(current.observed_at))}.</p>`
    : "";
  const guidance =
    source === "manual"
      ? `<p class="note">This date was set by hand. Refresh leaves it in place until it is cleared.</p>`
      : `<p class="note">Taken from the earliest active ServiceTitan appointment, on the America/New_York calendar. It does not change the logged start.</p>`;
  const refresh = canRefresh
    ? `<button class="btn field-start-refresh" type="button">Refresh from ServiceTitan</button>`
    : "";
  const override = canOverride
    ? `<form class="field-start-override">
         ${formRow(
           "Manual date",
           `<input class="field-start-date" id="field-start-manual" type="date" value="${esc(current.date || "")}">`,
           "field-start-manual",
         )}
         <div class="form-actions">
           <button class="btn primary" type="submit">Save manual date</button>
           <button class="btn field-start-clear" type="button"${current.date || source ? "" : " disabled"}>Clear</button>
         </div>
       </form>`
    : "";
  const viewOnly =
    !canRefresh && !canOverride
      ? `<p class="note">You can view field start. An owner or manager can set it by hand. A project manager can refresh it from ServiceTitan.</p>`
      : "";
  return `<section class="field-start" data-source="${esc(source)}">
    <span class="lbl">Field start</span>
    <p class="field-start-status">${esc(line)}</p>
    ${observed}
    ${guidance}
    ${viewOnly}
    <div class="actions">${refresh}</div>
    ${override}
    <p class="field-start-msg" role="alert"></p>
  </section>`;
}

export function bindFieldStart(root, handlers) {
  if (!root || !handlers) return;
  const report = (err) => {
    const box = root.querySelector(".field-start-msg");
    if (box) box.textContent = err?.message || "That did not work.";
    if (handlers.onError) handlers.onError(err);
  };
  const refresh = root.querySelector(".field-start-refresh");
  if (refresh) {
    refresh.addEventListener("click", async (event) => {
      event.preventDefault();
      refresh.disabled = true;
      try {
        await handlers.onRefresh();
      } catch (err) {
        report(err);
        refresh.disabled = false;
      }
    });
  }
  const form = root.querySelector(".field-start-override");
  if (form) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const input = root.querySelector(".field-start-date");
      const date = input && "value" in input ? String(input.value || "").trim() : "";
      if (!date) {
        report({ message: "Choose a date, or clear the field start." });
        return;
      }
      const button = form.querySelector('button[type="submit"]');
      if (button) button.disabled = true;
      try {
        await handlers.onOverride(date);
      } catch (err) {
        report(err);
        if (button) button.disabled = false;
      }
    });
  }
  const clear = root.querySelector(".field-start-clear");
  if (clear) {
    clear.addEventListener("click", async (event) => {
      event.preventDefault();
      if (clear.disabled) return;
      clear.disabled = true;
      try {
        await handlers.onOverride(null);
      } catch (err) {
        report(err);
        clear.disabled = false;
      }
    });
  }
}

export function bindFieldRelease(root, handlers) {
  if (!root || !handlers) return;
  const noteValue = () => {
    const field = root.querySelector(".field-release-note");
    return field && "value" in field ? String(field.value || "").trim() : "";
  };
  const report = (err) => {
    const box = root.querySelector(".field-release-msg");
    if (box) box.textContent = err?.message || "That did not work.";
    if (handlers.onError) handlers.onError(err);
  };
  const go = root.querySelector(".field-release-go");
  if (go) {
    go.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      go.disabled = true;
      try {
        await handlers.onRelease(noteValue());
      } catch (err) {
        report(err);
        go.disabled = false;
      }
    });
  }
  const undo = root.querySelector(".field-release-undo");
  if (undo) {
    undo.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (undo.disabled) return;
      const ask = handlers.confirm || ((message) => window.confirm(message));
      if (!ask(UNDO_CONFIRM)) return;
      undo.disabled = true;
      try {
        await handlers.onUndo(noteValue());
      } catch (err) {
        report(err);
        undo.disabled = false;
      }
    });
  }
}
