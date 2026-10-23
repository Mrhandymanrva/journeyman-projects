import { createQuickBooksVendors } from "./quickbooksVendors.js";
export function createSubcontractors({
  api,
  el,
  esc,
  can,
  openDrawer,
  field,
  current,
  projectScoped = false,
}) {
  const names = {
    tax_form: "W-9",
    gl_insurance: "General liability COI",
    wc_insurance: "Workers compensation COI",
    auto_insurance: "Auto insurance",
    license: "Trade license",
    master_agreement: "Subcontractor agreement",
    other: "Other",
  };
  const insurance = {
    gl_insurance: "General liability",
    wc_insurance: "Workers compensation",
    auto_insurance: "Auto insurance",
  };
  const coverageFields = (selected = []) =>
    `<fieldset id="doc-coverages"><legend>Coverage categories — select all that apply</legend>${Object.entries(
      insurance,
    )
      .map(
        ([kind, label]) =>
          `<label style="display:flex;align-items:center;gap:8px"><input style="width:auto" type="checkbox" name="doc-coverage" value="${kind}" ${selected.includes(kind) ? "checked" : ""}>${label}</label>`,
      )
      .join(
        "",
      )}<p>Select only coverage shown on this COI. If policy expiration dates differ, use the earliest expiration date.</p></fieldset>`;
  const selectedCoverage = () =>
    [...document.querySelectorAll('[name="doc-coverage"]:checked')].map(
      (input) => input.value,
    );
  const documentLabel = (doc) =>
    doc.coverage_kinds?.length
      ? "COI: " +
        doc.coverage_kinds.map((kind) => insurance[kind] ?? kind).join(" · ")
      : (names[doc.kind] ?? doc.kind);
  const selected = new Set();
  let vendors = [],
    catalog,
    totals = [],
    showArchived = false;
  const tradeName = (t) =>
    catalog?.trades.find((c) => c.toLowerCase() === t.toLowerCase()) ?? t;
  const money = (v, c = "USD") =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: c }).format(
      Number(v),
    );
  const date = (v) => (v ? String(v).slice(0, 10) : "—");
  const open = (title, body, mount) =>
    openDrawer(
      title,
      '<section class="sub-app"><p class="msg" id="sub-message" role="status"></p>' +
        body +
        "</section>",
      mount,
    );
  const button = (id, label, primary = false) =>
    `<button class="btn ${primary ? "primary" : ""}" id="${id}">${label}</button>`;
  const input = (id, value = "", type = "text") =>
    `<input id="${id}" type="${type}" value="${esc(value ?? "")}">`;
  const action = (id, fn) =>
    el(id)?.addEventListener("click", async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      try {
        await fn();
      } catch (error) {
        if (el("sub-message")) el("sub-message").textContent = error.message;
      } finally {
        b.disabled = false;
      }
    });
  const fetchAll = async (path) => {
    const rows = [];
    for (let page = 1; ; page++) {
      const batch = await api(
        path + (path.includes("?") ? "&" : "?") + "per_page=200&page=" + page,
      );
      rows.push(...batch);
      if (batch.length < 200) return rows;
    }
  };
  const vendorTotal = (id) =>
    totals
      .filter((t) => t.vendor_id === id)
      .map((t) => money(t.contracted_total, t.currency))
      .join(" / ") || "—";
  async function directory() {
    open("Subcontractors", "<p>Loading directory…</p>");
    try {
      [vendors, catalog, totals] = await Promise.all([
        fetchAll(
          "/vendors?sort=trade" +
            (showArchived ? "&include_archived=true" : ""),
        ),
        api("/planning-catalog"),
        api("/vendor-work-totals"),
      ]);
      vendors = vendors.map((v) => ({ ...v, trades: v.trades.map(tradeName) }));
      for (const id of selected)
        if (!vendors.some((v) => v.id === id)) selected.delete(id);
      open(
        "Subcontractors",
        `<div class="sub-heading"><div><h3>Subcontractors & vendors</h3><p>Contacts, qualifications, availability and contracted work.</p></div><div>${can("manage_vendors") ? button("sub-add", "Add subcontractor / vendor", true) : ""}${can("manage_vendors") ? button("sub-qb-import", "Import from QuickBooks") : ""}${button("sub-bids", "Bid requests")}</div></div><label><input type="checkbox" id="sub-archived" ${showArchived ? "checked" : ""}> Show archived companies</label><div class="sub-filters">${field("Search", input("sub-search"))}${field(
          "Trade",
          `<select id="sub-trade"><option value="">All trades</option>${[
            ...new Set([
              ...catalog.trades,
              ...vendors.flatMap((v) => v.trades),
            ]),
          ]
            .sort()
            .map((t) => `<option>${esc(t)}</option>`)
            .join("")}</select>`,
        )}${field("Availability", `<select id="sub-availability"><option value="">Any availability</option>${["available", "limited", "booked", "unavailable", "unknown"].map((s) => `<option value="${s}">${s}</option>`).join("")}</select>`)}${field("Sort by", `<select id="sub-sort"><option value="trade">Trade, then company</option><option value="name">Company</option><option value="availability">Available from</option><option value="expiry">Next document expiration</option></select>`)}</div><div class="sub-selection"><span id="sub-count"></span>${can("send_change_order") ? button("sub-request", "Request bids from selected") : ""}${button("sub-select-visible", "Select matching")}${button("sub-clear", "Clear selection")}</div><div class="sub-table" id="sub-results"></div><p class="hint">Remove archives a company and its scheduling crews; existing work and documents remain. Restore companies with Show archived companies. Contracted totals include issued, partially billed and closed PM purchase/work orders; drafts and voids are excluded. Currencies remain separate. No lifetime total is inferred from QBO.</p>`,
        () => {
          action("sub-qb-import", () => qboVendors.browse());
          el("sub-archived").onchange = (e) => {
            showArchived = e.target.checked;
            void directory();
          };
          let visible = [];
          function render() {
            const q = el("sub-search").value.toLowerCase(),
              trade = el("sub-trade").value,
              availability = el("sub-availability").value,
              sort = el("sub-sort").value;
            visible = vendors
              .filter(
                (v) =>
                  (!q ||
                    [
                      v.legal_name,
                      v.primary_contact,
                      v.email,
                      v.phone,
                      ...v.specialties,
                      ...v.trades,
                    ]
                      .join(" ")
                      .toLowerCase()
                      .includes(q)) &&
                  (!trade || v.trades.includes(trade)) &&
                  (!availability || v.availability_status === availability),
              )
              .sort((a, b) => {
                const key = (v) =>
                  sort === "trade"
                    ? [...v.trades].sort().join(",")
                    : sort === "availability"
                      ? v.available_from || "9999"
                      : sort === "expiry"
                        ? v.next_expiry || "9999"
                        : v.legal_name;
                return (
                  key(a).localeCompare(key(b)) ||
                  a.legal_name.localeCompare(b.legal_name)
                );
              });
            el("sub-count").textContent =
              `${visible.length} matching · ${selected.size} selected`;
            el("sub-results").innerHTML =
              `<table><thead><tr><th>Select</th><th>Company / contact</th><th>Trades / specialties</th><th>Availability</th><th>Compliance</th><th>Contracted work</th><th></th></tr></thead><tbody>${visible.map((v) => `<tr><td><input type="checkbox" aria-label="Select ${esc(v.legal_name)}" data-select="${v.id}" ${v.archived ? "disabled" : ""} ${selected.has(v.id) ? "checked" : ""}></td><td><strong>${esc(v.legal_name)}</strong>${v.archived ? "<small>Archived</small>" : ""}<small>${esc(v.primary_contact ?? "")}</small><small>${esc(v.email)}<br>${esc(v.phone ?? "")}</small></td><td>${esc(v.trades.join(", "))}<small>${esc(v.specialties.join(", "))}</small></td><td><span class="sub-pill">${esc(v.availability_status)}</span><small>${v.available_from ? "From " + date(v.available_from) : ""}</small></td><td>${v.archived ? "Archived" : !v.active ? "Pending activation" : v.schedulable ? "Ready to schedule" : "Needs review"}<small>${v.expired_count} expired · ${v.missing_count} missing<br>Next expiry: ${date(v.next_expiry)}</small></td><td>${vendorTotal(v.id)}</td><td><button class="btn sm" data-open="${v.id}">Open</button>${can("manage_vendors") ? `<button class="btn sm" data-edit-vendor="${v.id}">Edit</button><button class="btn sm" data-archive-vendor="${v.id}">${v.archived ? "Restore" : "Remove"}</button>` : ""}</td></tr>`).join("") || '<tr><td colspan="7">No matching subcontractors.</td></tr>'}</tbody></table>`;
            document.querySelectorAll("[data-select]").forEach((c) =>
              c.addEventListener("change", () => {
                c.checked
                  ? selected.add(c.dataset.select)
                  : selected.delete(c.dataset.select);
                el("sub-count").textContent =
                  `${visible.length} matching · ${selected.size} selected`;
              }),
            );
            document.querySelectorAll("[data-edit-vendor]").forEach(
              (b) =>
                (b.onclick = async () => {
                  try {
                    const v = await api("/vendors/" + b.dataset.editVendor);
                    v.trades = v.trades.map(tradeName);
                    edit(v);
                  } catch (e) {
                    showError(e);
                  }
                }),
            );
            document.querySelectorAll("[data-archive-vendor]").forEach(
              (b) =>
                (b.onclick = async () => {
                  const v = vendors.find(
                    (v) => v.id === b.dataset.archiveVendor,
                  );
                  try {
                    await api("/vendors/" + v.id, {
                      method: "PATCH",
                      body: JSON.stringify({ archived: !v.archived }),
                    });
                    selected.delete(v.id);
                    await directory();
                  } catch (e) {
                    showError(e);
                  }
                }),
            );
            document
              .querySelectorAll("[data-open]")
              .forEach((b) =>
                b.addEventListener("click", () =>
                  profile(b.dataset.open).catch(showError),
                ),
              );
          }
          ["sub-search", "sub-trade", "sub-availability", "sub-sort"].forEach(
            (id) =>
              el(id).addEventListener(
                id === "sub-search" ? "input" : "change",
                render,
              ),
          );
          action("sub-add", () => edit());
          action("sub-bids", bidList);
          action("sub-select-visible", () => {
            visible
              .filter((v) => !v.archived)
              .forEach((v) => selected.add(v.id));
            render();
          });
          action("sub-clear", () => {
            selected.clear();
            render();
          });
          action("sub-request", () => {
            if (!selected.size)
              throw Error("Select at least one subcontractor.");
            return compose();
          });
          render();
        },
      );
    } catch (error) {
      showError(error);
    }
  }
  const showError = (e) => {
    if (el("sub-message")) el("sub-message").textContent = e.message;
  };
  const qboVendors = createQuickBooksVendors({api,el,esc,open,profile,directory});
  async function profile(id, notice = "") {
    const [v, work] = await Promise.all([
      api("/vendors/" + id),
      api("/vendors/" + id + "/work"),
    ]);
    v.trades = v.trades.map(tradeName);
    const committed = work.filter((w) =>
      ["issued", "partially_billed", "closed"].includes(w.status),
    );
    const byCurrency = {};
    for (const w of committed)
      byCurrency[w.currency] = (byCurrency[w.currency] || 0) + Number(w.amount);
    open(
      v.legal_name,
      `<div class="sub-heading"><div><p>${esc(v.trades.join(" · "))}</p><h3>${esc(v.specialties.join(", ") || "Specialties not recorded")}</h3></div><div>${button("sub-back", "Directory")}${can("manage_vendors") ? button("sub-edit", "Edit intake", true) + button("sub-qb-check", "Check QuickBooks") : ""}</div></div><div class="sub-grid"><section><h3>Contact</h3><p>${esc(v.primary_contact ?? "No contact person")}<br>${esc(v.email)}<br>${esc(v.phone ?? "No phone")}</p><p class="sub-pre">${esc(v.address ?? "No address")}</p><p>Service area: ${esc(v.service_area ?? "Not set")}</p></section><section><h3>Availability & licensing</h3><p>${esc(v.availability_status)} · Available from ${date(v.available_from)}</p><p>${esc(v.availability_notes ?? "")}</p><p>License: <strong>${esc(v.license_number ?? "Not recorded")}</strong><br>${esc(v.license_authority ?? "")} · ${esc(v.license_class ?? "")}<br>Expires: ${date(v.license_expires_on)}</p></section></div><section><h3>General notes</h3><p class="sub-pre">${esc(v.notes || "No notes yet.")}</p></section><section><h3>COIs, W-9 & documents</h3><p><strong>Company status: ${v.active ? "Active" : "Inactive"}</strong></p><div class="sub-compliance">${v.compliance.map((c) => `<span class="sub-pill">${esc(names[c.kind] ?? c.kind)}: ${esc(c.state)} · ${date(c.expires_on)}</span>`).join("")}</div>${can("manage_vendors") ? button("sub-upload", "Upload document") : ""}<div class="sub-table"><table><thead><tr><th>Type / file</th><th>Issued</th><th>Expires</th><th>Review</th><th></th></tr></thead><tbody>${v.documents.map((d) => `<tr><td>${esc(documentLabel(d))}<small>${esc(d.file_name ?? "Record only; no uploaded file")}</small></td><td>${date(d.issued_on)}</td><td>${date(d.expires_on)}</td><td>${d.verified_at ? "Reviewed" : "Awaiting review"}<small>${esc(d.verify_method ?? "")}</small></td><td>${can("manage_vendors") && d.has_file ? `<button class="btn sm" data-file="${d.id}">Download</button>` : ""}${can("manage_vendors") && insurance[d.kind] ? `<button class="btn sm" data-coverage="${d.id}">Edit coverage</button>` : ""}${can("manage_vendors") && !d.verified_at ? `<button class="btn sm" data-review="${d.id}">Record review</button>` : ""}</td></tr>`).join("") || '<tr><td colspan="5">Upload a COI, W-9 or license to start the intake.</td></tr>'}</tbody></table></div>${can("manage_vendors") ? button("sub-activate", v.active ? "Check compliance" : "Check compliance and activate") : ""}<p id="sub-compliance-result" role="status">${esc(notice)}</p></section><section><h3>Contracted work</h3><p class="sub-total">${
        Object.entries(byCurrency)
          .map(([c, n]) => money(n, c))
          .join(" · ") || "No issued work yet"
      }</p><p>${committed.length} issued work orders across ${new Set(committed.map((w) => w.project_id)).size} projects. Drafts and voids do not count.</p><div class="sub-table"><table><thead><tr><th>Project / order</th><th>Scope</th><th>Status</th><th>Amount</th></tr></thead><tbody>${work.map((w) => `<tr><td>${esc(w.project_name)}<small>${esc(w.po_number)}</small></td><td>${esc(w.scope_text)}</td><td>${esc(w.status)}</td><td>${money(w.amount, w.currency)}</td></tr>`).join("") || '<tr><td colspan="4">No work orders.</td></tr>'}</tbody></table></div></section>`,
      () => {
        action("sub-back", directory);
        action("sub-edit", () => edit(v));
        action("sub-qb-check", () => qboVendors.inspect(id));
        action("sub-upload", () => upload(id));
        action("sub-activate", async () => {
          el("sub-compliance-result").textContent = "Checking compliance…";
          try {
            await api("/vendors/" + id + "/activate", { method: "POST" });
            await profile(id, v.active ? "Compliance check passed. This company is active." : "Compliance check passed. This company is now active.");
          } catch (error) {
            let message = error.message;
            for (const [kind, label] of Object.entries(names)) message = message.replaceAll(kind, label);
            el("sub-compliance-result").textContent = message;
          }
          el("sub-compliance-result")?.scrollIntoView?.({block:"nearest"});
        });
        document.querySelectorAll("[data-coverage]").forEach((b) =>
          b.addEventListener("click", () => {
            try {
              editCoverage(id, v.documents.find((d) => d.id === b.dataset.coverage));
            } catch (error) { showError(error); }
          }),
        );
        document.querySelectorAll("[data-file]").forEach((b) =>
          b.addEventListener("click", async () => {
            try {
              const f = await api(
                "/vendors/" + id + "/documents/" + b.dataset.file + "/file",
              );
              download(
                f.file_name,
                Uint8Array.from(atob(f.content), (c) => c.charCodeAt(0)),
                f.media_type,
              );
            } catch (e) {
              showError(e);
            }
          }),
        );
        document
          .querySelectorAll("[data-review]")
          .forEach((b) =>
            b.addEventListener("click", () => review(id, b.dataset.review)),
          );
      },
    );
  }
  function edit(v) {
    const text = (label, id, key, type = "text") =>
      field(
        label,
        input(
          id,
          type === "date" && v?.[key] ? String(v[key]).slice(0, 10) : v?.[key],
          type,
        ),
      );
    open(
      v ? "Edit subcontractor / vendor" : "New subcontractor / vendor",
      `<p>Capture the company and qualifications first. Upload COIs, W-9s and licenses on the saved profile.</p><h3>Company & primary contact</h3><div class="sub-grid">${text("Legal company name", "v-name", "legal_name")}${text("DBA / trading name", "v-dba", "dba_name")}${text("Contact person", "v-contact", "primary_contact")}${text("Email", "v-email", "email", "email")}${text("Phone", "v-phone", "phone")}${field("Address", `<textarea id="v-address">${esc(v?.address ?? "")}</textarea>`)}</div><h3>Trades & specialties</h3><div class="sub-grid">${field(
        "Trades — select all that apply",
        `<select id="v-trades" multiple size="8">${[
          ...new Set([...catalog.trades, ...(v?.trades ?? [])]),
        ]
          .sort()
          .map(
            (t) =>
              `<option ${v?.trades?.includes(t) ? "selected" : ""}>${esc(t)}</option>`,
          )
          .join("")}</select>`,
      )}<div>${field("Specialties — comma separated", input("v-specialties", v?.specialties?.join(", ")))}${text("Service area", "v-area", "service_area")}</div></div><h3>Availability</h3><div class="sub-grid">${field("Current availability", `<select id="v-availability">${["unknown", "available", "limited", "booked", "unavailable"].map((a) => `<option ${a === (v?.availability_status ?? "unknown") ? "selected" : ""}>${a}</option>`).join("")}</select>`)}${text("Available from", "v-from", "available_from", "date")}${field("Availability details / typical lead time", `<textarea id="v-availability-notes">${esc(v?.availability_notes ?? "")}</textarea>`)}</div><h3>Trade license</h3><div class="sub-grid">${text("License number", "v-license", "license_number")}${text("License class", "v-class", "license_class")}${text("Issuing authority", "v-authority", "license_authority")}${text("License expiration", "v-license-expiry", "license_expires_on", "date")}</div>${field("General notes", `<textarea id="v-notes">${esc(v?.notes ?? "")}</textarea>`)}${button("v-save", "Save intake", true)} ${button("v-cancel", "Cancel")}`,
      () => {
        action("v-cancel", () => (v ? profile(v.id) : directory()));
        action("v-save", async () => {
          const value = (id) => el(id).value.trim() || null;
          const body = {
            legal_name: value("v-name"),
            dba_name: value("v-dba"),
            primary_contact: value("v-contact"),
            email: value("v-email"),
            phone: value("v-phone"),
            address: value("v-address"),
            trades: Array.from(el("v-trades").selectedOptions, (o) => o.value),
            specialties: [
              ...new Set(
                (value("v-specialties") || "")
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              ),
            ],
            service_area: value("v-area"),
            availability_status: value("v-availability"),
            available_from: value("v-from"),
            availability_notes: value("v-availability-notes"),
            license_number: value("v-license"),
            license_class: value("v-class"),
            license_authority: value("v-authority"),
            license_expires_on: value("v-license-expiry"),
            notes: value("v-notes"),
          };
          if (!body.legal_name || !body.email)
            throw Error(
              "Company name and email are required. Trades are optional for suppliers.",
            );
          const saved = await api("/vendors" + (v ? "/" + v.id : ""), {
            method: v ? "PATCH" : "POST",
            body: JSON.stringify(body),
          });
          await profile(saved.id);
        });
      },
    );
  }
  function upload(id) {
    open(
      "Upload subcontractor document",
      `<p>Private documents are available only to staff who manage subcontractors. PDF, PNG or JPEG; up to 8 MB.</p>${field(
        "Document type",
        `<select id="doc-kind"><option value="coi">Insurance certificate (COI)</option>${Object.entries(
          names,
        )
          .filter(([k]) => !insurance[k])
          .map(([k, v]) => `<option value="${k}">${v}</option>`)
          .join("")}</select>`,
      )}${coverageFields()}${field("File", '<input id="doc-file" type="file" accept="application/pdf,image/png,image/jpeg">')}<div class="sub-grid">${field("Issued on", input("doc-issued", "", "date"))}${field("Expires on — required for insurance", input("doc-expiry", "", "date"))}</div>${button("doc-save", "Upload document", true)} ${button("doc-cancel", "Cancel")}`,
      () => {
        el("doc-kind").onchange = () => {
          el("doc-coverages").hidden = el("doc-kind").value !== "coi";
        };
        action("doc-cancel", () => profile(id));
        action("doc-save", async () => {
          const isCOI = el("doc-kind").value === "coi";
          const coverage = isCOI ? selectedCoverage() : [];
          if (isCOI && !coverage.length)
            throw Error("Select at least one coverage category.");
          if (isCOI && !el("doc-expiry").value)
            throw Error("Enter the COI expiration date.");
          const file = el("doc-file").files[0];
          if (!file || file.size > 8388608)
            throw Error("Choose a PDF, PNG or JPEG up to 8 MB.");
          const content = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(",")[1]);
            reader.onerror = () => reject(Error("File could not be read"));
            reader.readAsDataURL(file);
          });
          await api("/vendors/" + id + "/documents/upload", {
            method: "POST",
            body: JSON.stringify({
              kind: isCOI ? coverage[0] : el("doc-kind").value,
              ...(isCOI ? { coverage_kinds: coverage } : {}),
              file_name: file.name,
              media_type: file.type,
              content,
              issued_on: el("doc-issued").value || null,
              expires_on: el("doc-expiry").value || null,
            }),
          });
          await profile(id);
        });
      },
    );
  }
  function editCoverage(id, doc) {
    open(
      "Edit COI coverage",
      `<p>${esc(doc.file_name ?? "Insurance document")} · Expires ${date(doc.expires_on)}</p><p>Use this uploaded COI for every category it covers. Saving clears the previous review so the updated coverage can be reviewed.</p>${coverageFields(doc.coverage_kinds?.length ? doc.coverage_kinds : [doc.kind])}${button("coverage-save", "Save coverage", true)} ${button("coverage-cancel", "Cancel")}`,
      () => {
        action("coverage-cancel", () => profile(id));
        action("coverage-save", async () => {
          const coverage = selectedCoverage();
          if (!coverage.length)
            throw Error("Select at least one coverage category.");
          await api("/vendors/" + id + "/documents/" + doc.id + "/coverage", {
            method: "PATCH",
            body: JSON.stringify({ coverage_kinds: coverage }),
          });
          await profile(id);
        });
      },
    );
  }
  function review(id, doc) {
    open(
      "Record document review",
      field(
        "How was the document verified?",
        `<textarea id="doc-method" placeholder="Reviewed signed W-9; confirmed coverage and expiration with carrier…"></textarea>`,
      ) + button("doc-review", "Save review", true),
      () =>
        action("doc-review", async () => {
          const method = el("doc-method").value.trim();
          if (!method) throw Error("Describe your review.");
          await api("/vendors/" + id + "/documents/" + doc, {
            method: "PATCH",
            body: JSON.stringify({ verify_method: method }),
          });
          await profile(id);
        }),
    );
  }
  function download(name, content, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  async function compose() {
    const projects = (await fetchAll("/projects")).filter(
      (p) => !projectScoped || p.id === current()?.id,
    );
    const chosen = vendors.filter((v) => selected.has(v.id));
    if (chosen.length > 50)
      throw Error("Select up to 50 subcontractors per request.");
    open(
      "Request quotes / bids",
      `<p>${chosen.length} recipients: ${esc(chosen.map((v) => v.legal_name).join(", "))}. Each receives an individual response link.</p>${field("Project", `<select id="bid-project">${projects.map((p) => `<option value="${p.id}" ${p.id === current()?.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select>`)}${field("Subject", input("bid-subject", "Request for quote — " + (current()?.name ?? "")))}${field("Scope of work / bid instructions", `<textarea id="bid-scope" rows="8" placeholder="Describe the work, location, quantities, site visit arrangements and required inclusions."></textarea>`)}<div class="sub-grid">${field("Quote due", input("bid-due", "", "date"))}${field("Planned start", input("bid-start", "", "date"))}${field("Planned finish", input("bid-end", "", "date"))}</div>${button("bid-save", "Create bid request", true)} ${button("bid-cancel", "Cancel")}`,
      () => {
        action("bid-cancel", directory);
        action("bid-save", async () => {
          const r = await api("/bid-requests", {
            method: "POST",
            body: JSON.stringify({
              project_id: el("bid-project").value,
              subject: el("bid-subject").value.trim(),
              scope: el("bid-scope").value.trim(),
              due_on: el("bid-due").value || null,
              window_start: el("bid-start").value || null,
              window_end: el("bid-end").value || null,
              vendor_ids: chosen.map((v) => v.id),
            }),
          });
          await bidDetail(r.id);
        });
      },
    );
  }
  async function bidList() {
    const r = await api("/bid-requests");
    if (projectScoped)
      r.requests = r.requests.filter((b) => b.project_id === current()?.id);
    open(
      "Bid requests",
      button(
        "bid-directory",
        projectScoped ? "New bid request" : "Subcontractor directory",
        projectScoped,
      ) +
        `<div class="sub-table"><table><thead><tr><th>Request / project</th><th>Due</th><th>Responses</th><th>Status</th><th></th></tr></thead><tbody>${r.requests.map((b) => `<tr><td>${esc(b.subject)}<small>${esc(b.project_name)}</small></td><td>${date(b.due_on)}</td><td>${b.response_count} / ${b.recipient_count}</td><td>${b.closed_at ? "Closed" : "Open"}</td><td><button class="btn" data-bid="${b.id}">View</button></td></tr>`).join("") || '<tr><td colspan="5">Select subcontractors in the directory to start a bid request.</td></tr>'}</tbody></table></div>`,
      () => {
        action("bid-directory", directory);
        document
          .querySelectorAll("[data-bid]")
          .forEach((b) =>
            b.addEventListener("click", () =>
              bidDetail(b.dataset.bid).catch(showError),
            ),
          );
      },
    );
  }
  async function bidDetail(id) {
    const b = await api("/bid-requests/" + id);
    open(
      b.subject,
      `<p class="sub-pre">${esc(b.scope)}</p><p>Quote due: ${date(b.due_on)} · Work: ${date(b.window_start)} → ${date(b.window_end)}</p><div class="sub-selection">${button("bid-back", "All bid requests")}${!b.closed_at && can("send_change_order") ? button("bid-outlook", "Prepare Outlook emails", true) + button("bid-close", "Close bidding") : ""}${button("bid-refresh", "Refresh responses")}</div><p>Outlook sends from the default mailbox on this machine. Mark each request sent after using Outlook. Responses submitted through the private link appear here; ordinary email replies can be recorded manually. Award creates a draft subcontract purchase order from the quote. It does not issue the purchase order.</p><div class="sub-table"><table><thead><tr><th>Subcontractor</th><th>Delivery</th><th>Response</th><th>Quote</th><th>Available</th><th></th></tr></thead><tbody>${b.recipients.map((r) => `<tr><td>${esc(r.legal_name)}<small>${esc(r.email)}</small></td><td>${esc(r.delivery_status)}<small>${date(r.sent_at)}</small></td><td>${esc(r.response_status)}<small>${date(r.responded_at)}</small><small>${esc(r.response_notes ?? "")}</small></td><td>${r.quote_amount == null ? "—" : money(r.quote_amount, b.currency)}</td><td>${date(r.available_from)}</td><td>${can("send_change_order") ? `<button class="btn sm" data-response="${r.id}">Record / update</button>` : ""}${can("issue_purchase_order") && !b.closed_at && r.response_status !== "awarded" ? `<button class="btn sm" data-award="${r.id}">Award</button>` : ""}${r.awarded_po_id ? `<small>Draft PO recorded</small>` : ""}</td></tr>`).join("")}</tbody></table></div>`,
      () => {
        action("bid-back", bidList);
        action("bid-refresh", () => bidDetail(id));
        action("bid-close", async () => {
          await api("/bid-requests/" + id + "/close", { method: "POST" });
          await bidDetail(id);
        });
        action("bid-outlook", () => outlook(id));
        document.querySelectorAll("[data-response]").forEach((btn) =>
          btn.addEventListener("click", () =>
            recordResponse(
              id,
              b.recipients.find((r) => r.id === btn.dataset.response),
            ),
          ),
        );
        document.querySelectorAll("[data-award]").forEach((btn) =>
          btn.addEventListener("click", () =>
            awardRecipient(
              id,
              b.recipients.find((r) => r.id === btn.dataset.award),
            ),
          ),
        );
      },
    );
  }
  function recordResponse(id, r) {
    open(
      "Response — " + r.legal_name,
      field(
        "Response status",
        `<select id="reply-status">${["awaiting", "interested", "declined", "quoted", "not_selected"].map((s) => `<option ${s === r.response_status ? "selected" : ""}>${s}</option>`).join("")}</select>`,
      ) +
        field(
          "Quoted amount",
          input("reply-amount", r.quote_amount, "number"),
        ) +
        field(
          "Available from",
          input(
            "reply-from",
            date(r.available_from) === "—" ? "" : date(r.available_from),
            "date",
          ),
        ) +
        field(
          "Response / general notes",
          `<textarea id="reply-notes">${esc(r.response_notes ?? "")}</textarea>`,
        ) +
        button("reply-save", "Save response", true),
      () =>
        action("reply-save", async () => {
          await api("/bid-requests/" + id + "/recipients/" + r.id, {
            method: "PATCH",
            body: JSON.stringify({
              response_status: el("reply-status").value,
              quote_amount:
                el("reply-amount").value === ""
                  ? null
                  : Number(el("reply-amount").value),
              available_from: el("reply-from").value || null,
              response_notes: el("reply-notes").value,
            }),
          });
          await bidDetail(id);
        }),
    );
  }
  async function awardRecipient(id, r) {
    const codes = await api("/cost-codes");
    open(
      "Award " + r.legal_name,
      `<p class="note">This creates a draft subcontract purchase order. It does not issue it. Pick a cost code only when the bid has no lines.</p>` +
        field("PO number", input("award-po", "", "text")) +
        field(
          "Cost code",
          `<select id="award-code"><option value="">— bid lines, if any —</option>${codes
            .map((c) => `<option value="${c.id}">${esc(c.code)} ${esc(c.description)}</option>`)
            .join("")}</select>`,
        ) +
        button("award-save", "Create draft purchase order", true),
      () =>
        action("award-save", async () => {
          const result = await api(
            "/bid-requests/" + id + "/recipients/" + r.id + "/award",
            {
              method: "POST",
              body: JSON.stringify({
                po_number: el("award-po").value.trim(),
                cost_code_id: el("award-code").value || undefined,
                cost_type: "S",
              }),
            },
          );
          window.alert("Draft purchase order " + (result.po_number || result.id));
          await bidDetail(id);
        }),
    );
  }
  async function outlook(id) {
    const r = await api("/bid-requests/" + id + "/email-drafts", {
      method: "POST",
    });
    open(
      "Send bid requests with Outlook",
      `<p>Open each email in the default Outlook mailbox, review it and send. Then choose <strong>Mark sent</strong>. Download an Outlook email draft if the browser cannot open a long message.</p>${r.messages.map((m, i) => `<section class="sub-email"><strong>${esc(m.to)}</strong><p>${esc(m.subject)}</p><details><summary>Review message</summary><pre>${esc(m.text)}</pre></details><a class="btn primary" href="${esc("mailto:" + encodeURIComponent(m.to) + "?subject=" + encodeURIComponent(m.subject) + "&body=" + encodeURIComponent(m.text))}">Open in Outlook</a> <button class="btn" data-eml="${i}">Download email draft</button> <button class="btn" data-sent="${m.id}">Mark sent</button></section>`).join("") || "<p>No unsent requests. Return to the tracker to review responses.</p>"}${button("outlook-back", "Back to tracker")}`,
      () => {
        action("outlook-back", () => bidDetail(id));
        document.querySelectorAll("[data-eml]").forEach((btn) =>
          btn.addEventListener("click", () => {
            const m = r.messages[Number(btn.dataset.eml)];
            const subject =
              "=?UTF-8?B?" +
              btoa(unescape(encodeURIComponent(m.subject))) +
              "?=";
            const encoded = btoa(unescape(encodeURIComponent(m.text)))
              .match(/.{1,76}/g)
              .join("\r\n");
            download(
              "bid-request.eml",
              "X-Unsent: 1\r\nTo: " +
                m.to +
                "\r\nSubject: " +
                subject +
                "\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n" +
                encoded,
              "message/rfc822",
            );
          }),
        );
        document.querySelectorAll("[data-sent]").forEach((btn) =>
          btn.addEventListener("click", async () => {
            btn.disabled = true;
            try {
              await api(
                "/bid-requests/" +
                  id +
                  "/recipients/" +
                  btn.dataset.sent +
                  "/mark-sent",
                { method: "POST" },
              );
              btn.textContent = "Sent recorded";
            } catch (e) {
              btn.disabled = false;
              showError(e);
            }
          }),
        );
      },
    );
  }
  return { directory, bidList };
}
