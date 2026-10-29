/**
 * Owner-only ServiceTitan purchase order backfill.
 * Preview never calls ServiceTitan. Confirm sends one purchase order
 * and only when the server flag is on.
 */

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function money(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return number.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export function stPoSyncHtml(state) {
  if (state?.loading) {
    return `<section class="card" id="st-po-sync-card"><div class="card-h"><h2>ServiceTitan purchase order</h2></div><div class="card-b"><p>Loading purchase orders…</p></div></section>`;
  }
  if (state?.error) {
    return `<section class="card" id="st-po-sync-card"><div class="card-h"><h2>ServiceTitan purchase order</h2></div><div class="card-b"><p class="err">${esc(state.error)}</p></div></section>`;
  }
  const orders = state?.orders ?? [];
  const writes = state?.writesEnabled === true;
  const rows = orders
    .map((order) => {
      const linked = order.st_po_id
        ? `ServiceTitan ${esc(order.st_po_id)}`
        : esc(order.st_po_sync_state || "not sent");
      return `<tr>
        <td>${esc(order.po_number)}<br><small>${esc(order.kind)} · ${esc(order.vendor || "No vendor")}</small></td>
        <td>${money(order.amount)}</td>
        <td>${money(order.bill_amount)}</td>
        <td>${linked}${order.st_po_sync_error ? `<br><small>${esc(order.st_po_sync_error)}</small>` : ""}</td>
        <td><button type="button" class="btn sm" data-st-po-preview="${esc(order.id)}">Preview</button></td>
      </tr>`;
    })
    .join("");
  return `<section class="card" id="st-po-sync-card" aria-label="ServiceTitan purchase order sync">
    <div class="card-h"><h2>ServiceTitan purchase order</h2></div>
    <div class="card-b">
      <p class="note">${
        writes
          ? "Sending is on. Preview the payload, then confirm. A second confirm does not create another ServiceTitan purchase order."
          : "Sending is off (PM_ST_PO_SYNC_ENABLED is not true). Preview does not call ServiceTitan. Confirm will not call ServiceTitan until that setting is turned on. Nothing here runs on deploy or the nightly read."
      }</p>
      <table>
        <thead><tr><th>Purchase order</th><th>Amount</th><th>Bills</th><th>ServiceTitan</th><th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="5">No material or subcontract purchase orders.</td></tr>`}</tbody>
      </table>
      <div id="st-po-preview" hidden>
        <h3 id="st-po-preview-title">Dry run</h3>
        <p id="st-po-preview-note" class="note"></p>
        <pre id="st-po-preview-body"></pre>
        <button type="button" class="btn primary" id="st-po-confirm">Send this purchase order to ServiceTitan</button>
        <p id="st-po-confirm-result" role="status"></p>
      </div>
    </div>
  </section>`;
}

export function bindStPoSync(host, actions) {
  let previewId = null;
  const preview = host.querySelector("#st-po-preview");
  const note = host.querySelector("#st-po-preview-note");
  const body = host.querySelector("#st-po-preview-body");
  const title = host.querySelector("#st-po-preview-title");
  const result = host.querySelector("#st-po-confirm-result");
  host.querySelectorAll("[data-st-po-preview]").forEach((button) => {
    button.addEventListener("click", async () => {
      result.textContent = "";
      const data = await actions.onPreview(button.dataset.stPoPreview);
      previewId = data.po_id;
      preview.hidden = false;
      title.textContent = `Dry run · ${data.po_number}`;
      const missing = data.plan?.missing ?? [];
      note.textContent = data.writes_enabled
        ? missing.length
          ? "These fields have no source in Journeyman, so confirm will not call ServiceTitan."
          : "This is the body that confirm would POST. Nothing has been sent."
        : "Sending is off. This preview was not sent to ServiceTitan.";
      body.textContent = JSON.stringify(
        { payload: data.plan?.payload ?? null, missing },
        null,
        2,
      );
    });
  });
  host.querySelector("#st-po-confirm")?.addEventListener("click", async () => {
    if (!previewId) return;
    const ok = window.confirm(
      "Send this purchase order to ServiceTitan? This is a one-time create. Cancel leaves ServiceTitan unchanged.",
    );
    if (!ok) {
      result.textContent = "Canceled. ServiceTitan was not called.";
      return;
    }
    result.textContent = "Sending…";
    try {
      const sent = await actions.onConfirm(previewId);
      result.textContent = sent.state === "flag_off"
        ? "ServiceTitan purchase order sync is off. Nothing was sent."
        : sent.state === "created"
          ? `Stored ServiceTitan purchase order ${sent.stPoId || sent.st_po_id || ""}.`
          : sent.state === "blocked" || sent.state === "no_job"
            ? sent.error || "Not sent. A required field has no source."
            : sent.error || sent.state || "Finished.";
    } catch (err) {
      result.textContent = err.message || "The send did not finish.";
    }
  });
}
