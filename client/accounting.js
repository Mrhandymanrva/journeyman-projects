export function createAccounting({
  api,
  el,
  esc,
  can,
  current,
  openDrawer,
  closeDrawer,
}) {
  const money = (n) =>
    Number(n ?? 0).toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
    });
  const date = (v) => (v ? String(v).slice(0, 10) : "—");
  const options = (rows, value) =>
    rows
      .map(
        (a) =>
          `<option value="${esc(a.id)}" ${a.id === value ? "selected" : ""}>${esc(a.name)}</option>`,
      )
      .join("");
  const error = (e) =>
    window.alert(e.message || "The request could not be completed.");
  async function render() {
    const project = current();
    if (!project) return;
    const [catalog, data, pos] = await Promise.all([
      api("/accounting/catalog"),
      api(`/projects/${project.id}/vendor-bills`),
      api(`/projects/${project.id}/purchase-orders`),
    ]);
    if (current()?.id !== project.id) return;
    const bills = data.bills,
      live = bills.filter((b) => b.status !== "rejected"),
      received = live.filter((b) => b.status === "received"),
      confirmed = live.filter((b) => b.qbo_id);
    el("project-payables").innerHTML =
      `<div class="card"><div class="card-h"><div><h2>Vendor bills & payments</h2><p>Enter invoices, compare them with contracted work, approve them here, and pay in QuickBooks.</p></div><button class="btn" id="ap-reload">Refresh</button></div><div class="card-b"><div class="two"><p><strong>${money(live.reduce((s, b) => s + Number(b.amount), 0))}</strong> billed · <strong>${money(received.reduce((s, b) => s + Number(b.amount), 0))}</strong> awaiting approval</p><p><strong>${confirmed.length ? money(confirmed.reduce((s, b) => s + Number(b.qbo_balance ?? b.amount), 0)) : "Not yet synced"}</strong> remaining in QBO <small>(last recorded balances; payments and credits are managed there)</small></p></div><p class="note">${catalog.connected ? "Connected to the existing QuickBooks service. Approved bills are queued automatically; confirmed bills show a QBO number." : "QuickBooks connector is not configured. Bills can be entered, but cannot be sent."}</p>${can("approve_vendor_bill") ? `<div class="actions"><button class="btn" id="ap-catalog">Refresh QuickBooks lists</button><button class="btn" id="ap-vendors">Vendor setup & W-9 review</button></div><label>QuickBooks customer / job for this project<select id="ap-customer"><option value="">No QBO customer mapping — project recorded in bill description</option>${options(catalog.customers || [], data.qbo_customer_id)}</select></label><button class="btn sm" id="ap-map">Save customer mapping</button>` : ""}<div class="actions">${can("issue_purchase_order") ? '<button class="btn primary" id="ap-add">Enter vendor invoice</button>' : ""}</div><div class="sub-table"><table><thead><tr><th>Invoice / vendor</th><th>Contract & billed</th><th>Amount / due</th><th>Approval & QBO</th><th>Remaining</th><th>Actions</th></tr></thead><tbody>${bills.map((b) => `<tr><td><strong>${esc(b.vendor_invoice_number)}</strong><small>${esc(b.vendor)}</small><small>${esc(b.po_number)}</small></td><td>${money(b.contracted)} contracted<small>${money(b.billed_to_date)} billed${Number(b.billed_to_date) > Number(b.contracted) ? " · OVER CONTRACT" : ""}</small></td><td>${money(b.amount)}<small>Due ${date(b.due_date)}</small>${Number(b.retention_held) > 0 ? `<small>${money(b.retention_held)} held</small>` : ""}</td><td>${b.status === "paid" ? "Settled in QBO" : esc(b.status)}<small>${esc(b.sync_state || "Not sent")}${b.qbo_id ? " · QBO #" + esc(b.qbo_id) : ""}</small><small>${esc(b.sync_message || "")}</small><small>${esc(b.qbo_message || "")}</small></td><td>${b.qbo_id ? money(b.qbo_balance) : "—"}<small>${b.qbo_checked_at ? "Checked " + date(b.qbo_checked_at) : ""}</small></td><td>${(b.status === "received" || (b.status === "approved" && !b.sync_state)) && can("approve_vendor_bill") ? `<button class="btn sm" data-ap-approve="${b.id}">Review & approve</button><button class="btn sm danger" data-ap-reject="${b.id}">Reject</button>` : ""}${can("approve_vendor_bill") && ["failed", "uncertain"].includes(b.sync_state) ? `<button class="btn sm" data-ap-sync="${b.id}">${b.sync_state === "uncertain" ? "Check QBO receipt" : "Retry sync"}</button>` : ""}${b.qbo_id && can("approve_vendor_bill") ? `<button class="btn sm" data-ap-sync="${b.id}">Refresh balance</button>` : ""}</td></tr>`).join("") || '<tr><td colspan="6">No vendor bills for this project yet.</td></tr>'}</tbody></table></div></div></div>`;
    el("ap-reload").onclick = () => render().catch(error);
    if (el("ap-catalog"))
      el("ap-catalog").onclick = async () => {
        try {
          await api("/accounting/catalog/refresh", { method: "POST" });
          await render();
        } catch (e) {
          error(e);
        }
      };
    if (el("ap-map"))
      el("ap-map").onclick = async () => {
        try {
          await api(`/projects/${project.id}/accounting`, {
            method: "PATCH",
            body: JSON.stringify({
              qbo_customer_id: el("ap-customer").value || null,
            }),
          });
          await render();
        } catch (e) {
          error(e);
        }
      };
    if (el("ap-vendors"))
      el("ap-vendors").onclick = () => vendors().catch(error);
    if (el("ap-add")) el("ap-add").onclick = () => entry(pos, project.id);
    el("project-payables")
      .querySelectorAll("[data-ap-approve]")
      .forEach(
        (btn) =>
          (btn.onclick = () =>
            approve(
              bills.find((b) => b.id === btn.dataset.apApprove),
              catalog,
            )),
      );
    el("project-payables")
      .querySelectorAll("[data-ap-reject]")
      .forEach(
        (btn) =>
          (btn.onclick = async () => {
            if (!confirm("Reject this invoice?")) return;
            try {
              await api(`/bills/${btn.dataset.apReject}/reject`, {
                method: "POST",
              });
              await render();
            } catch (e) {
              error(e);
            }
          }),
      );
    el("project-payables")
      .querySelectorAll("[data-ap-sync]")
      .forEach(
        (btn) =>
          (btn.onclick = async () => {
            try {
              await api(`/bills/${btn.dataset.apSync}/accounting-sync`, {
                method: "POST",
              });
              btn.textContent = "Queued — refresh shortly";
              btn.disabled = true;
            } catch (e) {
              error(e);
            }
          }),
      );
  }
  function entry(pos, projectId) {
    const eligible = pos.filter((p) => p.status !== "void");
    openDrawer(
      "Enter vendor invoice",
      `<p>Choose the purchase order or subcontract for this invoice. Create the contracted scope in Purchase orders first if it is missing.</p><label>Contract / purchase order<select id="ap-po">${eligible.map((p) => `<option value="${p.id}">${esc(p.po_number)} · ${esc(p.vendor)} · ${money(p.amount)}</option>`).join("")}</select></label><label>Vendor invoice number<input id="ap-number" maxlength="21" required></label><div class="two"><label>Invoice date<input id="ap-date" type="date" value="${new Date().toISOString().slice(0, 10)}"></label><label>Due date<input id="ap-due" type="date" value="${new Date().toISOString().slice(0, 10)}"></label></div><div class="two"><label>Invoice total<input id="ap-amount" type="number" min="0.01" step="0.01"></label><label>Retention held<input id="ap-retention" type="number" min="0" step="0.01" value="0"></label></div><label>Work / materials billed<textarea id="ap-description"></textarea></label><p class="note">Invoices with retained amounts must be split into payable and held portions before approval.</p><button class="btn primary" id="ap-save" ${eligible.length ? "" : "disabled"}>Save for approval</button>`,
      () => {
        el("ap-save").onclick = async () => {
          const btn = el("ap-save");
          btn.disabled = true;
          try {
            const result = await api(
              `/purchase-orders/${el("ap-po").value}/bills`,
              {
                method: "POST",
                body: JSON.stringify({
                  vendor_invoice_number: el("ap-number").value.trim(),
                  invoice_date: el("ap-date").value,
                  due_date: el("ap-due").value,
                  amount: Number(el("ap-amount").value),
                  retention_held: Number(el("ap-retention").value),
                  description: el("ap-description").value,
                }),
              },
            );
            if (result.warning) alert(result.warning.message);
            closeDrawer();
            if (current()?.id === projectId) await render();
          } catch (e) {
            error(e);
            btn.disabled = false;
          }
        };
      },
    );
  }
  function approve(b, catalog) {
    openDrawer(
      "Approve for payment",
      `<h3>${esc(b.vendor)} · ${esc(b.vendor_invoice_number)}</h3><p>${money(b.amount)} due ${date(b.due_date)}</p><p>Contract: ${money(b.contracted)}<br>Total billed: ${money(b.billed_to_date)}${Number(b.billed_to_date) > Number(b.contracted) ? "<br><strong>Review: total invoices exceed the contracted amount.</strong>" : ""}</p><p>${esc(b.description || "")}</p><label>QuickBooks expense account<select id="ap-account"><option value="">Choose an account</option>${options(catalog.accounts || [], b.qbo_account_id)}</select></label><p>Approval locks this bill and queues it for QuickBooks. Payment is made in QuickBooks.</p><button class="btn primary" id="ap-confirm" ${catalog.connected ? "" : "disabled"}>Approve & send to QuickBooks</button>`,
      () => {
        el("ap-confirm").onclick = async () => {
          const btn = el("ap-confirm");
          btn.disabled = true;
          try {
            await api(`/bills/${b.id}/approve`, {
              method: "POST",
              body: JSON.stringify({ qbo_account_id: el("ap-account").value }),
            });
            closeDrawer();
            await render();
          } catch (e) {
            error(e);
            btn.disabled = false;
          }
        };
      },
    );
  }
  async function vendors() {
    const rows = await api("/accounting/vendors");
    openDrawer(
      "QuickBooks vendor setup",
      `<p>Complete contact person, address and phone in Resources. Upload the W-9 and record its review. New vendors sync automatically when these are ready; existing PM vendors can be queued below.</p><p>After synchronization, review the tax ID and 1099 settings in QuickBooks against the W-9, then confirm below. This does not validate a tax ID with the IRS.</p>${rows.map((v) => `<section class="card-b"><h3>${esc(v.legal_name)}</h3><p>${v.w9_reviewed ? "Reviewed W-9 on file" : "W-9 upload / review required"} · ${v.primary_contact && v.phone && v.address ? "Contact information complete" : "Complete contact information in Resources"}<br>${esc(v.state || "Not queued")} · ${esc(v.message || "")}${v.qbo_id ? "<br>QBO vendor #" + esc(v.qbo_id) : ""}${v.qbo_w9_id ? " · W-9 attached" : ""}<br>${v.qbo_tax_reviewed_at ? "Tax information review recorded" : "QBO tax information review required"}</p>${!v.qbo_id && can("manage_vendors") ? `<button class="btn sm" data-vendor-sync="${v.id}">${v.state === "uncertain" ? "Check existing QBO record" : "Queue / retry vendor setup"}</button>` : ""}${v.qbo_id && v.qbo_w9_id && !v.qbo_tax_reviewed_at ? `<button class="btn sm" data-tax-enter="${v.id}">Enter W-9 tax information</button><button class="btn sm" data-tax-review="${v.id}">Already correct in QB — confirm review</button>` : ""}</section>`).join("") || "<p>Add a vendor in Resources first.</p>"}`,
      () => {
        document.querySelectorAll("[data-vendor-sync]").forEach(
          (b) =>
            (b.onclick = async () => {
              try {
                await api(`/vendors/${b.dataset.vendorSync}/accounting-sync`, {
                  method: "POST",
                });
                b.textContent = "Queued — reopen shortly";
                b.disabled = true;
              } catch (e) {
                error(e);
              }
            }),
        );
        document
          .querySelectorAll("[data-tax-enter]")
          .forEach((b) => (b.onclick = () => taxEntry(b.dataset.taxEnter)));
        document.querySelectorAll("[data-tax-review]").forEach(
          (b) =>
            (b.onclick = async () => {
              if (
                !confirm(
                  "I reviewed this vendor in QuickBooks and confirmed its legal name, address, tax ID and 1099 settings against the W-9.",
                )
              )
                return;
              try {
                await api(`/vendors/${b.dataset.taxReview}/accounting-review`, {
                  method: "POST",
                  body: JSON.stringify({ confirmed: true }),
                });
                await vendors();
              } catch (e) {
                error(e);
              }
            }),
        );
      },
    );
  }
  function taxEntry(id) {
    openDrawer(
      "W-9 tax information",
      `<p>Enter the tax ID from the reviewed W-9. It will be sent to this vendor in QuickBooks and will not be stored as a separate tax-ID field in PM.</p><label>Tax ID (EIN or SSN)<input id="ap-tax-id" type="password" autocomplete="off" inputmode="numeric" maxlength="11"></label><label>Track payments for 1099 in QuickBooks<select id="ap-1099"><option value="">Choose based on the reviewed W-9</option><option value="true">Yes</option><option value="false">No</option></select></label><label><input id="ap-tax-confirm" type="checkbox"> I checked these details against the reviewed W-9.</label><button class="btn primary" id="ap-tax-save">Save tax information to QuickBooks</button>`,
      () => {
        el("ap-tax-save").onclick = async () => {
          if (!el("ap-tax-confirm").checked || !el("ap-1099").value) {
            alert("Choose the 1099 setting and confirm your review.");
            return;
          }
          const btn = el("ap-tax-save");
          btn.disabled = true;
          try {
            await api(`/vendors/${id}/accounting-tax`, {
              method: "POST",
              body: JSON.stringify({
                tax_id: el("ap-tax-id").value,
                vendor_1099: el("ap-1099").value === "true",
                confirmed: true,
              }),
            });
            el("ap-tax-id").value = "";
            await vendors();
          } catch (e) {
            error(e);
            btn.disabled = false;
          }
        };
      },
    );
  }
  return { render };
}
