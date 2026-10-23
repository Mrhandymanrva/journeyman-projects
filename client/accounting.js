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
    const canReclassify = can("issue_purchase_order") || can("approve_vendor_bill");
    const bills = data.bills,
      live = bills.filter((b) => b.status !== "rejected"),
      received = live.filter((b) => b.status === "received" && b.po_kind !== "material"),
      materialOpen = live.filter((b) => b.status === "received" && b.po_kind === "material"),
      confirmed = live.filter((b) => b.qbo_id);
    el("project-payables").innerHTML =
      `<div class="card"><div class="card-h"><div><h2>Vendor bills & payments</h2><p>Enter invoices, compare them with contracted work, approve them here, and pay in QuickBooks.</p></div><button class="btn" id="ap-reload">Refresh</button></div><div class="card-b"><div class="two"><p><strong>${money(live.reduce((s, b) => s + Number(b.amount), 0))}</strong> billed · <strong>${money(received.reduce((s, b) => s + Number(b.amount), 0))}</strong> awaiting approval</p><p><strong>${confirmed.length ? money(confirmed.reduce((s, b) => s + Number(b.qbo_balance ?? b.amount), 0)) : "Not yet synced"}</strong> remaining in QBO <small>(last recorded balances; payments and credits are managed there)</small></p></div><p class="note">${catalog.connected ? "Connected to the existing QuickBooks service. Approved subcontract bills are queued for their full amount." : "QuickBooks connector is not configured, so card charges cannot be looked up yet. Material orders still show as awaiting card charge and stay on the project cost."} ${materialOpen.length ? money(materialOpen.reduce((s, b) => s + Number(b.amount), 0)) + " awaiting card charge. That cost is on the project and is not in the approval queue." : ""}</p>${can("approve_vendor_bill") ? `<div class="actions"><button class="btn" id="ap-catalog">Refresh QuickBooks lists</button><button class="btn" id="ap-vendors">Vendor setup & W-9 review</button></div><label>QuickBooks customer / job for this project<select id="ap-customer"><option value="">No QBO customer mapping — project recorded in bill description</option>${options(catalog.customers || [], data.qbo_customer_id)}</select></label><button class="btn sm" id="ap-map">Save customer mapping</button>` : ""}<div class="actions">${can("issue_purchase_order") ? '<button class="btn primary" id="ap-material">Enter material order</button><button class="btn" id="ap-add">Enter vendor invoice</button>' : ""}</div>${canReclassify ? `<p class="note">A material bill that is already in QuickBooks is linked, not approved. Linking records the existing Bill or Purchase and does not queue a new one.</p>` : ""}<div class="sub-table"><table><thead><tr><th>Invoice / vendor</th><th>Contract & billed</th><th>Amount / due</th><th>Approval & QBO</th><th>Remaining</th><th>Actions</th></tr></thead><tbody>${bills.map((b) => `<tr><td><strong>${esc(b.vendor_invoice_number)}</strong><small>${esc(b.vendor)}</small><small>${esc(b.po_number)} · ${esc(b.po_kind || "subcontract")}</small></td><td>${money(b.contracted)} contracted<small>${money(b.billed_to_date)} billed${b.po_kind === "material" ? "" : Number(b.billed_to_date) > Number(b.contracted) ? " · OVER CONTRACT" : ""}</small></td><td>${money(b.amount)}<small>Due ${date(b.due_date)}</small>${Number(b.retention_held) ? `<small>${money(b.retention_held)} held, not approved for payment</small>` : ""}</td><td>${awaitingCard(b) ? "Awaiting card charge" : b.status === "paid" ? "Settled in QBO" : esc(b.status)}<small>${awaitingCard(b) ? "Recorded on the project. Nothing is sent to QuickBooks." : (esc(b.sync_state || "Not sent") + (b.qbo_id ? " · QBO #" + esc(b.qbo_id) : ""))}</small><small>${esc(b.sync_message || "")}</small><small>${esc(b.qbo_message || "")}</small></td><td>${b.qbo_id ? money(b.qbo_balance) : "—"}<small>${b.qbo_checked_at ? "Checked " + date(b.qbo_checked_at) : ""}</small></td><td>${(b.status === "received" || (b.status === "approved" && !b.sync_state)) && can("approve_vendor_bill") ? `${b.po_kind === "material" ? "" : `<button class="btn sm" type="button" data-ap-approve="${b.id}">Review & approve</button>`}<button class="btn sm danger" type="button" data-ap-reject="${b.id}">Reject</button>` : ""}${can("approve_vendor_bill") && ["failed", "uncertain"].includes(b.sync_state) ? `<button class="btn sm" data-ap-sync="${b.id}">${b.sync_state === "uncertain" ? "Check QBO receipt" : "Retry sync"}</button>` : ""}${b.qbo_id && can("approve_vendor_bill") ? `<button class="btn sm" data-ap-sync="${b.id}">Refresh balance</button>` : ""}${b.po_kind === "material" && b.status === "received" && can("link_material_purchase") ? `<button class="btn sm" type="button" data-ap-link="${b.id}">Link QuickBooks transaction</button>` : ""}${canReclassify && b.po_kind !== "material" && b.status !== "paid" ? `<button class="btn sm" data-ap-material="${b.po_id}">Mark as material purchase</button>` : ""}${canReclassify && b.status !== "rejected" ? `<button class="btn sm" data-ap-move="${b.po_id}">Move to another project</button>` : ""}</td></tr>`).join("") || '<tr><td colspan="6">No vendor bills for this project yet.</td></tr>'}</tbody></table></div></div></div>`;
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
    if (el("ap-material")) el("ap-material").onclick = () => entryMaterial(project.id).catch(error);
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
      .querySelectorAll("[data-ap-link]")
      .forEach((btn) => {
        btn.onclick = () => {
          const bill = bills.find((b) => b.id === btn.dataset.apLink);
          linkExisting(bill, project.id).catch((e) => error(e));
        };
      });
    el("project-payables")
      .querySelectorAll("[data-ap-material]")
      .forEach(
        (btn) =>
          (btn.onclick = async () => {
            if (
              !confirm(
                "Mark this purchase order as a material purchase? Its received bills leave the subcontract approval queue. Nothing is sent to QuickBooks.",
              )
            )
              return;
            try {
              await api(`/purchase-orders/${btn.dataset.apMaterial}`, {
                method: "PATCH",
                body: JSON.stringify({ kind: "material" }),
              });
              await render();
            } catch (e) {
              error(e);
            }
          }),
      );
    el("project-payables")
      .querySelectorAll("[data-ap-move]")
      .forEach((btn) => (btn.onclick = () => movePurchaseOrder(btn.dataset.apMove)));
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
  function awaitingCard(b) {
    if (b.card_charge_state === "awaiting_card_charge") return true;
    if (b.card_charge_state === "matched") return false;
    return b.po_kind === "material" && b.status === "received" && !b.qbo_id;
  }
  async function entryMaterial(projectId) {
    const [codes, vendors] = await Promise.all([
      api("/cost-codes"),
      api("/vendors?per_page=200"),
    ]);
    const codeList = Array.isArray(codes) ? codes : [];
    const vendorList = Array.isArray(vendors) ? vendors : [];
    openDrawer(
      "Enter material order",
      `<p>Record the online order now so the material cost shows on this project. It stays Awaiting card charge until the card charge is linked. Nothing is sent to QuickBooks.</p>
       <label>Vendor<select id="ap-mat-vendor"><option value="">Supplier name below</option>${vendorList.map((v) => `<option value="${esc(v.id)}">${esc(v.legal_name)}</option>`).join("")}</select></label>
       <label>Supplier name, if the vendor is not in the list<input id="ap-mat-supplier" maxlength="200"></label>
       <label>Cost code<select id="ap-mat-code">${codeList.map((c) => `<option value="${esc(c.id)}">${esc(c.code)} ${esc(c.description || "")}</option>`).join("")}</select></label>
       <label>Order number<input id="ap-mat-order" maxlength="21" required></label>
       <label>Amount<input id="ap-mat-amount" type="number" min="0.01" step="0.01"></label>
       <label>Order date<input id="ap-mat-date" type="date" value="${new Date().toISOString().slice(0, 10)}"></label>
       <label>What was ordered<textarea id="ap-mat-description"></textarea></label>
       <p class="note">This does not ask anyone to approve the order, and it does not create a QuickBooks bill.</p>
       <button class="btn primary" id="ap-mat-save" type="button" ${codeList.length ? "" : "disabled"}>Record order</button>`,
      () => {
        el("ap-mat-save").onclick = async () => {
          const btn = el("ap-mat-save");
          btn.disabled = true;
          try {
            const result = await api(`/projects/${projectId}/material-bills`, {
              method: "POST",
              body: JSON.stringify({
                vendor_id: el("ap-mat-vendor").value || null,
                supplier_name: el("ap-mat-supplier").value.trim() || null,
                cost_code_id: el("ap-mat-code").value,
                order_number: el("ap-mat-order").value.trim(),
                amount: Number(el("ap-mat-amount").value),
                invoice_date: el("ap-mat-date").value,
                description: el("ap-mat-description").value,
              }),
            });
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
  function entry(pos, projectId) {
    const eligible = pos.filter((p) => p.status !== "void");
    openDrawer(
      "Enter vendor invoice",
      `<p>Choose the purchase order or subcontract for this invoice. Create the contracted scope in Purchase orders first if it is missing.</p><label>Contract / purchase order<select id="ap-po">${eligible.map((p) => `<option value="${p.id}">${esc(p.po_number)} · ${esc(p.vendor)} · ${money(p.amount)}</option>`).join("")}</select></label><label>Vendor invoice number<input id="ap-number" maxlength="21" required></label><div class="two"><label>Invoice date<input id="ap-date" type="date" value="${new Date().toISOString().slice(0, 10)}"></label><label>Due date<input id="ap-due" type="date" value="${new Date().toISOString().slice(0, 10)}"></label></div><label>Invoice total<input id="ap-amount" type="number" min="0.01" step="0.01"></label><label>Work / materials billed<textarea id="ap-description"></textarea></label><p class="note">Approved bills are queued for their full amount. Material purchases stay unmatched until they are linked to a QuickBooks transaction.</p><button class="btn primary" id="ap-save" ${eligible.length ? "" : "disabled"}>Save for approval</button>`,
      () => {
        const labelSave = () => {
          const po = eligible.find((p) => p.id === el("ap-po")?.value);
          const save = el("ap-save");
          if (save) save.textContent = po?.kind === "material" ? "Record — awaiting card charge" : "Save for approval";
        };
        if (el("ap-po")) el("ap-po").onchange = labelSave;
        labelSave();
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
      `<h3>${esc(b.vendor)} · ${esc(b.vendor_invoice_number)}</h3><p>${money(b.amount)} due ${date(b.due_date)}</p><p>Contract: ${money(b.contracted)}<br>Total billed: ${money(b.billed_to_date)}${b.po_kind !== "material" && Number(b.billed_to_date) > Number(b.contracted) ? "<br><strong>Review: total invoices exceed the contracted amount.</strong>" : ""}</p><p>${esc(b.description || "")}</p><label>QuickBooks expense account<select id="ap-account"><option value="">Choose an account</option>${options(catalog.accounts || [], b.qbo_account_id)}</select></label><p>Approval locks this bill and queues it for QuickBooks. Payment is made in QuickBooks. If this invoice is already paid or categorized there, close this and use Link QuickBooks transaction instead. Approving would send it again.</p><button class="btn primary" id="ap-confirm" ${catalog.connected ? "" : "disabled"}>Approve & send to QuickBooks</button>`,
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
  function accountMappingCard(settings, catalog) {
    if (!can("manage_company_settings")) return "";
    const accounts = catalog.accounts || settings.catalog || [];
    const select = (type, label) => {
      const saved = settings.accounts?.[type] || "";
      const suggested = settings.suggestions?.[type] || "";
      const suggestedName = accounts.find((account) => account.id === suggested)?.name;
      return `<label>${label}<select id="ap-acct-${type}"><option value="">Use the account chosen on each bill</option>${options(accounts, saved)}</select></label><small>${saved ? "Saved for this cost type." : suggestedName ? `Suggested “${esc(suggestedName)}”. It is not selected and nothing is saved until you choose it and click Save.` : "No suggestion from the stored chart of accounts."}</small>`;
    };
    return `<div class="card" style="margin:12px 0"><div class="card-h"><div><h3>Cost type accounts</h3><p>Map labor, material, subcontract, and other to QuickBooks expense accounts from the stored chart. An unmapped type uses the account chosen when that bill is approved. Suggestions use only the leaf name of a plausible expense or cost-of-goods account. Advertising, directories, income, and balance-sheet accounts are not suggested. Nothing is saved until you confirm it.</p></div></div><div class="card-b"><div class="two">${select("L", "Labor (L)")}${select("M", "Material (M)")}${select("S", "Subcontract (S)")}${select("O", "Other (O)")}</div><label>Days a subcontract may be issued with no signed agreement<input id="ap-grace" type="number" min="0" max="365" value="${Number(settings.agreement_grace_days)}"></label><p class="note">The default is 14 days from when the purchase order was created. Inside that window, issue is allowed and shows a warning. After it, issue is blocked until a signed vendor master agreement is attached. A per-PO subcontract is optional. Certificates of insurance and W-9 checks are unchanged.</p><button class="btn" id="ap-save-accounts" type="button">Save account mapping</button></div></div>`;
  }
  async function movePurchaseOrder(poId) {
    openDrawer(
      "Move purchase order",
      `<p>The purchase order and every bill on it move to the project you choose. Links from its lines to the old project's budget are cleared. Nothing is sent to QuickBooks.</p><label>Find a project<input id="ap-find" placeholder="Blanton"></label><label>Project<select id="ap-dest"></select></label><p class="note" id="ap-find-note"></p><button class="btn primary" id="ap-move-save" type="button">Move</button>`,
      () => {
        const project = current();
        const load = async () => {
          const q = el("ap-find").value.trim();
          const rows = await api(
            `/projects?per_page=200${q ? `&q=${encodeURIComponent(q)}` : ""}`,
          );
          const choices = (rows || []).filter((row) => row.id !== project?.id);
          el("ap-dest").innerHTML = choices.length
            ? choices
                .map(
                  (row) =>
                    `<option value="${esc(row.id)}">${esc(row.project_number)} · ${esc(row.name)}</option>`,
                )
                .join("")
            : `<option value="">No matching project</option>`;
          el("ap-find-note").textContent = choices.length
            ? `${choices.length} project(s). Search if the right one is not listed.`
            : "No other project matches that search.";
          el("ap-move-save").disabled = choices.length === 0;
        };
        el("ap-find").addEventListener("input", () => load().catch(error));
        load().catch(error);
        el("ap-move-save").onclick = async () => {
          const dest = el("ap-dest").value;
          if (!dest) return;
          const btn = el("ap-move-save");
          btn.disabled = true;
          try {
            await api(`/purchase-orders/${poId}`, {
              method: "PATCH",
              body: JSON.stringify({ project_id: dest }),
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
  function round2(n) {
    return Math.round(Number(n) * 100) / 100;
  }
  function varianceText(variance) {
    if (!Number.isFinite(variance) || Math.abs(variance) <= 0.005) return "matches the order";
    const sign = variance > 0 ? "+" : "−";
    return `${sign}${money(Math.abs(variance))} variance (tax, shipping, or price)`;
  }
  function rankCharges(txns, bill) {
    const vendor = String(bill.vendor || "").toLowerCase();
    const billDate = Date.parse(String(bill.invoice_date || bill.due_date || ""));
    const scored = txns.map((txn) => {
      const total = Number(txn.total);
      const variance = Number.isFinite(Number(txn.variance)) ? Number(txn.variance) : round2(total - Number(bill.amount));
      const txnDate = Date.parse(String(txn.txn_date || ""));
      const dayDelta = Number.isFinite(billDate) && Number.isFinite(txnDate) ? Math.abs(txnDate - billDate) / 86400000 : 365;
      const txnVendor = String(txn.vendor_name || "").toLowerCase();
      const vendorMatch = Boolean(vendor && txnVendor && (vendor.includes(txnVendor) || txnVendor.includes(vendor)));
      return { txn, variance, amountDelta: Math.abs(variance), dayDelta, vendorMatch };
    });
    scored.sort((a, b) => {
      if (a.vendorMatch !== b.vendorMatch) return a.vendorMatch ? -1 : 1;
      if (a.amountDelta !== b.amountDelta) return a.amountDelta - b.amountDelta;
      return a.dayDelta - b.dayDelta;
    });
    return scored;
  }
  function linkBlockReason(bill) {
    if (!bill?.po_id)
      return "This bill is not on a purchase order, so there is nowhere to attach a QuickBooks transaction.";
    if (bill.po_kind !== "material")
      return "Linking is for a material purchase. Mark the purchase order as a material purchase first. Nothing was sent to QuickBooks.";
    if (bill.status !== "received")
      return `This bill is ${bill.status}. Only a received material bill can be linked here.`;
    return "";
  }
  function showLinkMessage(message, bad = false) {
    const box = el("drawer-msg");
    if (!box) {
      error(new Error(message));
      return;
    }
    box.className = bad ? "msg bad" : "msg";
    box.textContent = message;
  }
  async function linkExisting(bill, projectId) {
    if (!bill) {
      error(new Error("That bill is no longer on this page. Refresh Financials and try again."));
      return;
    }
    const blocked = linkBlockReason(bill);
    openDrawer(
      "Link QuickBooks transaction",
      `<p>${esc(bill.vendor_invoice_number)} · ${money(bill.amount)}</p><p class="note">This records a Bill or Purchase that already exists in QuickBooks. It does not create a bill and does not queue one. The lookup does not depend on the purchase order amount, whether that order is a draft or issued, a project QuickBooks customer, a vendor QuickBooks id, or a refreshed chart of accounts.</p><p class="msg" id="drawer-msg"></p><div id="ap-link-body"></div>`,
    );
    if (blocked) {
      showLinkMessage(blocked, true);
      return;
    }
    showLinkMessage("Looking up Bills and Purchases in QuickBooks…");
    try {
      const found = await api(`/purchase-orders/${bill.po_id}/qbo-candidates`);
      const txns = (found?.transactions || []).filter((txn) => txn && txn.id);
      const body = el("ap-link-body");
      if (!body) {
        showLinkMessage("The link dialog is not on this page.", true);
        return;
      }
      if (!txns.length) {
        showLinkMessage(
          "QuickBooks returned no Bill or Purchase. Nothing was linked and nothing was queued. This lookup does not use the stored chart of accounts.",
        );
        body.innerHTML = `<button class="btn primary" id="ap-link-save" type="button" disabled>Link and do not send again</button>`;
        return;
      }
      showLinkMessage("A difference for tax or shipping can be linked. The project keeps the order amount, and the variance is shown.");
      const ranked = rankCharges(txns, bill);
      body.innerHTML = `<label>Transaction<select id="ap-txn">${ranked
        .map(
          (item, index) =>
            `<option value="${esc(item.txn.txn_type)}:${esc(item.txn.id)}">${index === 0 ? "Suggested · " : ""}${esc(item.txn.txn_type)} ${esc(item.txn.doc_number || item.txn.id)} · ${money(item.txn.total)} · ${esc(item.txn.txn_date || "")}${item.txn.vendor_name ? " · " + esc(item.txn.vendor_name) : ""} · ${esc(varianceText(item.variance))}</option>`,
        )
        .join("")}</select></label><button class="btn primary" id="ap-link-save" type="button">Link and do not send again</button>`;
      el("ap-link-save").onclick = async () => {
        const select = el("ap-txn");
        const value = select?.value || "";
        const splitAt = value.indexOf(":");
        if (!value || splitAt <= 0) {
          showLinkMessage("Choose a QuickBooks Bill or Purchase first.", true);
          return;
        }
        const btn = el("ap-link-save");
        btn.disabled = true;
        try {
          await api(`/bills/${bill.id}/link-qbo`, {
            method: "POST",
            body: JSON.stringify({
              qbo_txn_type: value.slice(0, splitAt),
              qbo_id: value.slice(splitAt + 1),
            }),
          });
          closeDrawer();
          if (current()?.id === projectId) await render();
        } catch (e) {
          showLinkMessage(e.message || "The link failed.", true);
          btn.disabled = false;
        }
      };
    } catch (e) {
      showLinkMessage(
        e.message || "The QuickBooks lookup failed. Nothing was linked and nothing was queued.",
        true,
      );
    }
  }
  async function renderSettings() {
    const host = el("company-settings");
    if (!host) return;
    if (!can("manage_company_settings")) {
      host.innerHTML = "<p>Company settings are available to an owner or a manager.</p>";
      return;
    }
    const [catalog, settings] = await Promise.all([
      api("/accounting/catalog"),
      api("/accounting/cost-type-accounts"),
    ]);
    host.innerHTML = accountMappingCard(settings, catalog);
    if (!el("ap-save-accounts")) return;
    el("ap-save-accounts").onclick = async () => {
      try {
        await api("/accounting/cost-type-accounts", {
          method: "PATCH",
          body: JSON.stringify({
            agreement_grace_days: Number(el("ap-grace").value),
            accounts: {
              L: el("ap-acct-L").value || null,
              M: el("ap-acct-M").value || null,
              S: el("ap-acct-S").value || null,
              O: el("ap-acct-O").value || null,
            },
          }),
        });
        await renderSettings();
      } catch (e) {
        error(e);
      }
    };
  }
  return { render, renderSettings };
}
