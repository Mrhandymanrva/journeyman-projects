/**
 * ServiceTitan purchase order preview.
 * The preview does not call ServiceTitan. Apply sends one purchase order,
 * and only when the owner switch in Setup is on.
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

function optionsHtml(options, suggested) {
  const rows = (options ?? [])
    .map(
      (option) =>
        `<option value="${esc(option.id)}"${option.id === suggested ? " selected" : ""}>${esc(option.label)}</option>`,
    )
    .join("");
  return `<option value="">Choose</option>${rows}`;
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
          ? "Sending is on. Preview the payload, then Apply. A second Apply does not create another ServiceTitan purchase order."
          : "Sending is off. An owner can turn it on in Setup. Preview does not call ServiceTitan. Apply does not call ServiceTitan until that switch is on."
      }</p>
      <table>
        <thead><tr><th>Purchase order</th><th>Amount</th><th>Bills</th><th>ServiceTitan</th><th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="5">No material or subcontract purchase orders.</td></tr>`}</tbody>
      </table>
      <div id="st-po-preview" hidden></div>
    </div>
  </section>`;
}

export function stPoPreviewMarkup(data) {
  const missing = data?.plan?.missing ?? [];
  const writes = data?.writes_enabled === true;
  const sent = Boolean(data?.st_po_id);
  const ready = missing.length === 0 && !sent;
  const fields = data?.fields ?? [];
  const skuLines = (data?.lines ?? []).filter((line) => line.needs_sku && line.line_id);
  const fieldHtml = fields
    .map(
      (field) => `<label>${esc(field.label)}
        <select data-st-field="${esc(field.key)}">${optionsHtml(field.options, field.suggested)}</select>
        ${field.lookup_error ? `<small class="err">${esc(field.lookup_error)}</small>` : ""}
      </label>`,
    )
    .join("");
  const lineHtml = skuLines
    .map(
      (line) => `<fieldset>
        <legend>${esc(line.description)} · ${money(line.amount)}</legend>
        <label>Search inventory SKUs
          <input data-st-sku-search="${esc(line.line_id)}" value="${esc(line.description || "")}">
        </label>
        <button type="button" class="btn sm" data-st-sku-go="${esc(line.line_id)}">Search</button>
        <label>SKU
          <select data-st-sku data-line-id="${esc(line.line_id)}">${optionsHtml(line.options, null)}</select>
        </label>
        ${line.lookup_error ? `<small class="err">${esc(line.lookup_error)}</small>` : ""}
      </fieldset>`,
    )
    .join("");
  const note = sent
    ? `Stored as ServiceTitan purchase order ${data.st_po_id}. Nothing new is sent.`
    : writes
      ? missing.length
        ? "Choose each required field and save. This preview has not been sent."
        : "This is the body Apply would POST. Nothing has been sent."
      : "Sending is off. An owner turns it on in Setup. This preview has not been sent.";
  const showChoices = fields.length > 0 || skuLines.length > 0;
  const payload =
    missing.length === 0
      ? `<h3>ServiceTitan payload</h3><pre id="st-po-preview-body">${esc(JSON.stringify(data.plan?.payload ?? null, null, 2))}</pre>`
      : `<pre id="st-po-preview-body" hidden></pre>`;
  return `<h3 id="st-po-preview-title">Dry run · ${esc(data?.po_number || "")}</h3>
    <p id="st-po-preview-note" class="note">${esc(note)}</p>
    ${data?.sku_note ? `<p class="note">${esc(data.sku_note)}</p>` : ""}
    ${showChoices ? `<div class="st-po-fields">${fieldHtml}${lineHtml}<button type="button" class="btn" id="st-po-save">Save selections</button></div>` : ""}
    ${payload}
    <button type="button" class="btn primary" id="st-po-confirm"${ready && writes ? "" : " disabled"}>Apply / Send to ServiceTitan</button>
    <p id="st-po-confirm-result" role="status"></p>`;
}

function readChoices(root) {
  const choices = { lines: [] };
  root.querySelectorAll("[data-st-field]").forEach((select) => {
    const value = select.value || null;
    if (select.dataset.stField === "vendorId") choices.vendor_id = value;
    if (select.dataset.stField === "typeId") choices.type_id = value;
    if (select.dataset.stField === "businessUnitId") choices.business_unit_id = value;
    if (select.dataset.stField === "inventoryLocationId") choices.inventory_location_id = value;
    if (select.dataset.stField === "jobId") choices.job_id = value;
  });
  root.querySelectorAll("[data-st-sku]").forEach((select) => {
    const lineId = select.dataset.lineId;
    if (!lineId) return;
    choices.lines.push({ line_id: lineId, sku_id: select.value || null });
  });
  if (choices.lines.length === 0) delete choices.lines;
  return choices;
}

export function bindStPoSync(host, actions) {
  let previewId = null;
  const paint = (data) => {
    const preview = host.querySelector("#st-po-preview");
    if (!preview) return;
    previewId = data.po_id;
    preview.hidden = false;
    preview.innerHTML = stPoPreviewMarkup(data);
  };
  host.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const open = target.closest("[data-st-po-preview]");
    if (open) {
      const data = await actions.onPreview(open.getAttribute("data-st-po-preview"));
      paint(data);
      return;
    }
    const search = target.closest("[data-st-sku-go]");
    if (search && previewId && actions.onSearchSkus) {
      const lineId = search.getAttribute("data-st-sku-go");
      const input = host.querySelector(`[data-st-sku-search="${lineId}"]`);
      const found = await actions.onSearchSkus(previewId, input?.value || "");
      const select = host.querySelector(`[data-st-sku][data-line-id="${lineId}"]`);
      if (select) {
        const current = select.value;
        select.innerHTML = optionsHtml(found.skus || [], current || null);
        if (current) select.value = current;
      }
      return;
    }
    if (target.closest("#st-po-save") && previewId) {
      const result = host.querySelector("#st-po-confirm-result");
      if (result) result.textContent = "Saving…";
      try {
        await actions.onSave(previewId, readChoices(host));
        const data = await actions.onPreview(previewId);
        paint(data);
        const saved = host.querySelector("#st-po-confirm-result");
        if (saved) saved.textContent = "Selections saved. ServiceTitan was not called.";
      } catch (err) {
        if (result) result.textContent = err.message || "The selections were not saved.";
      }
      return;
    }
    if (target.closest("#st-po-confirm") && previewId) {
      const button = host.querySelector("#st-po-confirm");
      if (button?.disabled) return;
      const result = host.querySelector("#st-po-confirm-result");
      const ok = window.confirm(
        "Send this purchase order to ServiceTitan? This is a one-time create. Cancel leaves ServiceTitan unchanged.",
      );
      if (!ok) {
        if (result) result.textContent = "Canceled. ServiceTitan was not called.";
        return;
      }
      if (result) result.textContent = "Sending…";
      try {
        const sent = await actions.onConfirm(previewId, readChoices(host));
        if (result) {
          result.textContent =
            sent.state === "flag_off"
              ? "ServiceTitan purchase order sending is off. Nothing was sent."
              : sent.state === "created"
                ? `Stored ServiceTitan purchase order ${sent.stPoId || sent.st_po_id || ""}.`
                : sent.state === "blocked" || sent.state === "no_job"
                  ? sent.error || "Not sent. A required field is still empty."
                  : sent.error || sent.state || "Finished.";
        }
        const data = await actions.onPreview(previewId);
        const status = result?.textContent || "";
        paint(data);
        const again = host.querySelector("#st-po-confirm-result");
        if (again) again.textContent = status;
      } catch (err) {
        if (result) result.textContent = err.message || "The send did not finish.";
      }
    }
  });
}
