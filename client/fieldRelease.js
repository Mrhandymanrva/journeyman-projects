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
        ${form}
        <span class="lbl">History</span>
        ${historyHtml}
        <p class="field-release-msg"></p>
      </div>
    </div>
  </section>`;
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
