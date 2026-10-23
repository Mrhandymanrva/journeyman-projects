export function createQuickBooksVendors({
  api,
  el,
  esc,
  open,
  profile,
  directory,
}) {
  const fields = {
    legal_name: "Company name",
    primary_contact: "Contact person",
    email: "Email",
    phone: "Phone",
    address: "Address",
    notes: "Notes",
  };
  const showError = (e) => {
    if (el("qb-message")) el("qb-message").textContent = e.message;
  };
  async function browse(pmId = null, start = 1, name = "") {
    open("QuickBooks vendors", "<p>Checking QuickBooks…</p>");
    try {
      const data = await api(
        "/accounting/quickbooks-vendors?start=" +
          start +
          "&name=" +
          encodeURIComponent(name),
      );
      open(
        pmId
          ? "Choose matching QuickBooks vendor"
          : "Import vendors from QuickBooks",
        `<p>${pmId ? "Choose the existing QuickBooks vendor that represents this PM company." : "Select the vendors you want to bring into PM. Complete contact information means company name, valid email, phone and address. W-9, tax and insurance review remain separate."}</p><label>Search QuickBooks name<input id="qb-search" value="${esc(name)}"></label><button class="btn" id="qb-find">Search</button><p id="qb-message" role="status"></p><div class="sub-table"><table><thead><tr><th>Select</th><th>Company</th><th>Contact details</th><th>Status</th></tr></thead><tbody>${data.vendors.map((v) => `<tr><td>${pmId ? `<button class="btn sm" data-qb-choose="${esc(v.qbo_id)}">Compare</button>` : `<input type="checkbox" name="qb-select" value="${esc(v.qbo_id)}" aria-label="Import ${esc(v.legal_name)}" ${v.pm_id || v.missing.length ? "disabled" : ""}>`}</td><td>${esc(v.legal_name)}<small>QB #${esc(v.qbo_id)}</small></td><td>${esc(v.email)}<small>${esc(v.phone)}</small><small>${esc(v.address)}</small></td><td>${v.pm_id ? (v.archived ? "Archived in PM" : "Already in PM") : v.missing.length ? "Missing: " + esc(v.missing.join(", ")) : "Ready to import"}</td></tr>`).join("") || '<tr><td colspan="4">No matching active vendors in QuickBooks.</td></tr>'}</tbody></table></div>${!pmId ? '<button class="btn primary" id="qb-import">Import selected vendors</button>' : ""} ${start > 1 ? '<button class="btn" id="qb-prev">Previous page</button>' : ""} ${data.nextStart ? '<button class="btn" id="qb-next">Next page</button>' : ""} <button class="btn" id="qb-back">Back</button>`,
        () => {
          el("qb-back").onclick = () => (pmId ? profile(pmId) : directory());
          el("qb-find").onclick = () =>
            browse(pmId, 1, el("qb-search").value.trim());
          if (el("qb-prev"))
            el("qb-prev").onclick = () =>
              browse(pmId, Math.max(1, start - 100), name);
          if (el("qb-next"))
            el("qb-next").onclick = () => browse(pmId, data.nextStart, name);
          document.querySelectorAll("[data-qb-choose]").forEach(
            (b) =>
              (b.onclick = () =>
                inspect(
                  pmId,
                  data.vendors.find((v) => v.qbo_id === b.dataset.qbChoose),
                )),
          );
          if (el("qb-import"))
            el("qb-import").onclick = async () => {
              const ids = [
                ...document.querySelectorAll('[name="qb-select"]:checked'),
              ].map((i) => i.value);
              if (!ids.length) {
                el("qb-message").textContent = "Select at least one vendor.";
                return;
              }
              el("qb-import").disabled = true;
              let imported = 0;
              try {
                for (const id of ids) {
                  await api("/accounting/quickbooks-vendors/import", {
                    method: "POST",
                    body: JSON.stringify({ qbo_id: id }),
                  });
                  imported++;
                  const box = document.querySelector(
                    `[name="qb-select"][value="${id}"]`,
                  );
                  box.checked = false;
                  box.disabled = true;
                  box.closest("tr").lastElementChild.textContent =
                    "Imported into PM";
                }
                el("qb-message").textContent =
                  `${imported} vendor(s) imported. Open them in Resources to review compliance.`;
              } catch (e) {
                el("qb-message").textContent =
                  `${imported} imported. ${e.message}`;
              } finally {
                el("qb-import").disabled = false;
              }
            };
        },
      );
    } catch (e) {
      open(
        "QuickBooks vendors",
        `<p role="alert">${esc(e.message)}</p><button class="btn" id="qb-back">Back</button>`,
        () =>
          (el("qb-back").onclick = () => (pmId ? profile(pmId) : directory())),
      );
    }
  }
  async function inspect(id, chosen = null) {
    open("Check QuickBooks", "<p>Checking existing vendor details…</p>");
    try {
      const data = await api("/vendors/" + id + "/quickbooks");
      const qb = chosen || (data.matches.length === 1 ? data.matches[0] : null);
      const pm = data.pm;
      open(
        "Check QuickBooks — " + pm.legal_name,
        `<p>The most recently updated record supplies shared vendor details. Populated older values fill missing fields; blanks never erase existing information. W-9 attachments and tax ID/1099 review use Vendor setup & W-9 review.</p><p id="qb-message" role="status"></p>${
          qb
            ? `<p>QuickBooks vendor: <strong>${esc(qb.display_name || qb.legal_name)}</strong> (#${esc(qb.qbo_id)})${!qb.active ? " — INACTIVE" : ""}</p><div class="sub-table"><table><thead><tr><th>Field</th><th>PM value</th><th>QuickBooks value</th></tr></thead><tbody>${Object.entries(
                fields,
              )
                .map(
                  ([key, label]) =>
                    `<tr><td>${label}</td><td>${esc(pm[key] || "—")}</td><td>${esc(qb[key] || "—")}</td></tr>`,
                )
                .join(
                  "",
                )}</tbody></table></div><label><input type="checkbox" id="qb-confirm"> I confirm these are the same vendor and want the latest details synchronized.</label><button class="btn primary" id="qb-sync" ${qb.active ? "" : "disabled"}>Sync latest details</button>`
            : `<p>${data.matches.length ? "Multiple matches found. Choose the correct vendor." : "No exact-name match found. Browse QuickBooks to match a vendor with a different name, or use Vendor setup & W-9 review to create a new vendor."}</p>`
        } ${!pm.qbo_id ? '<button class="btn" id="qb-browse">Find existing QuickBooks vendor</button>' : ""} <button class="btn" id="qb-back">Back to PM vendor</button>`,
        () => {
          el("qb-back").onclick = () => profile(id);
          if (el("qb-browse")) el("qb-browse").onclick = () => browse(id);
          if (el("qb-sync"))
            el("qb-sync").onclick = async () => {
              if (!el("qb-confirm").checked) {
                el("qb-message").textContent =
                  "Confirm the vendor match first.";
                return;
              }
              el("qb-sync").disabled = true;
              el("qb-message").textContent = "Syncing with QuickBooks…";
              try {
                const result = await api(
                  "/vendors/" + id + "/quickbooks-sync",
                  {
                    method: "POST",
                    body: JSON.stringify({
                      qbo_id: qb.qbo_id,
                      confirmed: true,
                    }),
                  },
                );
                el("qb-message").textContent = result.message;
                el("qb-sync").textContent = "Synced";
              } catch (e) {
                showError(e);
                el("qb-message").textContent +=
                  " Reopen Check QuickBooks to inspect current values before retrying.";
              }
            };
        },
      );
    } catch (e) {
      open(
        "Check QuickBooks",
        `<p role="alert">${esc(e.message)}</p><button class="btn" id="qb-back">Back</button>`,
        () => (el("qb-back").onclick = () => profile(id)),
      );
    }
  }
  return { browse, inspect };
}
