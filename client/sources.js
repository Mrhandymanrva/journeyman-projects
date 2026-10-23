// Read-only source views. External refreshes cannot edit the local project plan.
export function createSourceViews({ api, el, esc, can, current, openDrawer }) {
  const timestamp = (s) => (s ? new Date(s).toLocaleString() : "Never");
  async function dispatch(jobId, title) {
    const url = `/projects/${current().id}/jobs/${jobId}/dispatch`;
    openDrawer(
      `ServiceTitan · ${title}`,
      '<div id="source-body">Loading dispatch…</div>',
    );
    async function load(refresh = false) {
      try {
        const result = await api(
          url + (refresh ? "/refresh" : ""),
          refresh ? { method: "POST" } : undefined,
        );
        const s = result.snapshot;
        const payload = s?.payload;
        el("source-body").innerHTML =
          `<p class="hint">ServiceTitan dispatch is shown as received. Project activity dates remain independently planned.</p>
     <p>Last successful read: ${esc(timestamp(s?.observed_at))}</p>
     ${result.configured ? '<button class="btn" id="source-refresh" type="button">Refresh from ServiceTitan</button>' : "<p>ServiceTitan is not configured for this job link.</p>"}
     <p id="source-error" role="status"></p>
     ${payload ? `<p>Job status: ${esc(payload.job.jobStatus ?? "Unknown")}</p>` : ""}
     ${
       (payload?.appointments ?? [])
         .map((a) => {
           const people =
             (payload.assignments ?? [])
               .filter((x) => x.appointmentId === a.id && x.active)
               .map((x) => `${x.technicianName} (ST ${x.technicianId})`)
               .join(", ") || "Unassigned";
           return `<div class="row"><div><strong>${esc(a.appointmentNumber || a.id)}</strong><div>${esc(timestamp(a.start))} → ${esc(timestamp(a.end))}</div><div>${esc(a.status)}${a.active ? "" : " · inactive"}</div><div>${esc(people)}</div>${can("advance_stage") && a.active && a.status === "Scheduled" ? `<button class="btn sm" data-st-change="${a.id}">Review schedule change</button>` : ""}</div></div>`;
         })
         .join("") || "<p>No imported appointments.</p>"
     }`;
        document.querySelectorAll("[data-st-change]").forEach((button) =>
          button.addEventListener("click", async () => {
            const appointment = payload.appointments.find(
              (a) => a.id === button.dataset.stChange,
            );
            let directory;
            try {
              directory = await api("/technicians");
            } catch (error) {
              el("source-error").textContent = error.message;
              return;
            }
            const current = (payload.assignments ?? []).filter(
              (a) => a.appointmentId === appointment.id && a.active,
            );
            const choices=[...directory.technicians,...current.filter(a=>!directory.technicians.some(t=>t.source_technician_id===a.technicianId)).map(a=>({source_technician_id:a.technicianId,name:a.technicianName+' (inactive — replace before publishing)'}))];
            const options = choices
              .map(
                (t) =>
                  '<option value="' +
                  esc(t.source_technician_id) +
                  '" ' +
                  (current.some(
                    (a) => a.technicianId === t.source_technician_id,
                  )
                    ? "selected"
                    : "") +
                  ">" +
                  esc(t.name) +
                  "</option>",
              )
              .join("");
            const input = (id, label, value) =>
              "<label>" +
              label +
              '<input id="' +
              id +
              '" type="datetime-local" value="' +
              (value ? new Date(value).toISOString().slice(0, 16) : "") +
              '"></label>';
            openDrawer(
              "Publish appointment change to ServiceTitan",
              "<p>Times below are UTC. This updates the selected production appointment and the selected technician assignments. Review the project dependency proposal separately.</p><p>Appointment " +
                esc(appointment.appointmentNumber) +
                " · current " +
                esc(timestamp(appointment.start)) +
                " → " +
                esc(timestamp(appointment.end)) +
                "</p>" +
                input("st-start", "New start (UTC)", appointment.start) +
                input("st-end", "New end (UTC)", appointment.end) +
                input(
                  "st-arrival-start",
                  "Arrival window start (UTC)",
                  appointment.arrivalWindowStart,
                ) +
                input(
                  "st-arrival-end",
                  "Arrival window end (UTC)",
                  appointment.arrivalWindowEnd,
                ) +
                '<label>Active ServiceTitan technicians<select id="st-technicians" multiple size="6">' +
                options +
                "</select></label><p>Current crew: " +
                esc(
                  current.map((a) => a.technicianName).join(", ") ||
                    "Unassigned",
                ) +
                ". Choose all technicians for this appointment.</p>" +
                '<p id="publish-message" role="status"></p><button class="btn primary" id="st-publish">Publish to production ServiceTitan</button>',
              () => {
                const key = crypto.randomUUID();
                el("st-publish").addEventListener("click", async (e) => {
                  e.target.disabled = true;
                  try {
                    const iso = (id) =>
                      el(id).value
                        ? new Date(el(id).value + "Z").toISOString()
                        : null;
                    const r = await api(url + "/publish", {
                      method: "POST",
                      body: JSON.stringify({
                        request_key: key,
                        technician_ids: Array.from(
                          el("st-technicians").selectedOptions,
                          (o) => o.value,
                        ),
                        appointment_id: appointment.id,
                        expected_modified_on: appointment.modifiedOn,
                        start: iso("st-start"),
                        end: iso("st-end"),
                        arrivalWindowStart: iso("st-arrival-start"),
                        arrivalWindowEnd: iso("st-arrival-end"),
                      }),
                    });
                    el("publish-message").textContent = r.message;
                  } catch (error) {
                    el("publish-message").textContent = error.message;
                  }
                });
              },
            );
          }),
        );
        el("source-refresh")?.addEventListener("click", async (e) => {
          e.target.disabled = true;
          await load(true);
        });
      } catch (e) {
        const slot = el("source-error") ?? el("source-body");
        if (slot) slot.textContent = e.message;
        const button = el("source-refresh");
        if (button) button.disabled = false;
      }
    }
    await load();
  }
  async function inbox() {
    openDrawer(
      "Purchase reconciliation inbox",
      '<div id="source-body">Loading purchases…</div>',
    );
    async function load(refresh = false) {
      try {
        const result = await api(
          "/reconciliation-inbox" + (refresh ? "/refresh" : ""),
          refresh ? { method: "POST" } : undefined,
        );
        const s = result.snapshot;
        el("source-body").innerHTML =
          `<p class="hint">Source purchases and PO references awaiting project allocation. These rows do not change project costs. Coverage is the PO app purchase feed, not the full QuickBooks ledger.</p>
     <p>PM read: ${esc(timestamp(s?.observed_at))}<br>PO app last sync: ${esc(timestamp(s?.payload?.lastSync))}</p>
     ${can("export_cost_data") ? '<button class="btn" id="source-refresh" type="button">Refresh from PO app</button>' : ""}<p id="source-error" role="status"></p>
     <label>Search vendor or reference <input id="source-search" type="search"></label><div id="source-records"></div>`;
        const records = s?.payload?.records ?? [];
        function render() {
          const q = el("source-search").value.toLowerCase();
          const filtered = records
            .filter((r) =>
              `${r.vendor} ${r.reference}`.toLowerCase().includes(q),
            )
            .sort((a, b) => b.date.localeCompare(a.date));
          el("source-records").innerHTML =
            `<p>${filtered.length} source records · showing up to 200</p>` +
            filtered
              .slice(0, 200)
              .map(
                (r) =>
                  `<div class="row"><div><strong>${esc(r.vendor)}</strong><div>${esc(r.source.toUpperCase())} · ${esc(r.reference || r.id)} · ${esc(r.date)}</div><div>${esc(r.description)}</div></div><div>${esc(new Intl.NumberFormat("en-US", { style: "currency", currency: r.currency }).format(r.amount / 100))}</div></div>`,
              )
              .join("");
        }
        el("source-search").addEventListener("input", render);
        render();
        el("source-refresh")?.addEventListener("click", async (e) => {
          e.target.disabled = true;
          await load(true);
        });
      } catch (e) {
        const slot = el("source-error") ?? el("source-body");
        if (slot) slot.textContent = e.message;
        const button = el("source-refresh");
        if (button) button.disabled = false;
      }
    }
    await load();
  }
  return { dispatch, inbox };
}
