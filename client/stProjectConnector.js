export function createSTProjectConnector({
  api,
  el,
  esc,
  can,
  openDrawer,
  current,
  onChanged,
}) {
  async function open(importing = false) {
    const pm = importing ? null : current();
    if (!importing && !pm) return;
    openDrawer(
      importing ? "Add project from ServiceTitan" : "ServiceTitan project",
      '<div id="st-project-body">Reading ServiceTitan…</div>',
    );
    try {
      const state = importing
        ? { configured: true }
        : await api("/projects/" + pm.id + "/servicetitan");
      const linked = state.connection?.snapshot;
      const units = importing ? await api("/business-units") : [];
      el("st-project-body").innerHTML =
        `<p>ServiceTitan supplies the project number, name, customer, service address, status, dates and jobs. Permits, subcontractors and the PM work plan stay here.</p><p id="st-project-message" role="status"></p>${linked ? `<h3>${esc(linked.number)} — ${esc(linked.name || "ST project")}</h3><p>${esc(linked.customer?.name || "")}<br>${esc(linked.summary?.replace(/<[^>]*>/g," ")||"")}<br>Start: ${esc(linked.startDate?.slice(0,10)||"Not set")} · Target: ${esc(linked.targetCompletionDate?.slice(0,10)||"Not set")}<br>Status: ${esc(linked.status || "Not set")} · ${linked.jobIds.length} jobs<br>Last refreshed ${esc(new Date(state.connection.observed_at).toLocaleString())}</p><button class="btn primary" id="st-project-refresh" ${state.configured && state.connectionMatches && can("advance_stage") ? "" : "disabled"}>Refresh from ServiceTitan</button>${!state.connectionMatches ? "<p>The source connection changed. Refresh is blocked.</p>" : ""}` : `${importing && units.length ? `<label>PM business unit<select id="st-project-unit"><option value="">Choose if applicable…</option>${units.map((u) => `<option value="${esc(u.id)}">${esc(u.name)}</option>`).join("")}</select></label>` : ""}<label>Exact ST project number<input id="st-project-number" placeholder="Leave blank to browse recent projects"></label><button class="btn" id="st-project-search">Find projects</button><div id="st-project-picker"></div>`}`;
      async function sync(id) {
        const body = { external_project_id: id };
        if (importing)
          body.business_unit_id = el("st-project-unit")?.value || null;
        const r = await api(
          importing
            ? "/servicetitan/projects/import"
            : "/projects/" + pm.id + "/servicetitan",
          { method: "POST", body: JSON.stringify(body) },
        );
        await onChanged(r.id || pm.id);
      }
      el("st-project-refresh")?.addEventListener("click", async (e) => {
        e.target.disabled = true;
        try {
          await sync(linked.id);
        } catch (error) {
          el("st-project-message").textContent = error.message;
          e.target.disabled = false;
        }
      });
      let page = 1,
        number = "";
      async function load() {
        el("st-project-picker").textContent = "Reading ServiceTitan projects…";
        try {
          const r = await api(
            "/servicetitan/projects?page=" +
              page +
              "&number=" +
              encodeURIComponent(number),
          );
          el("st-project-picker").innerHTML =
            `<p>Page ${page}</p><label>ServiceTitan project<select id="st-project-choice"><option value="">Select a project…</option>${r.data.map((p) => `<option value="${esc(p.id)}">${esc(p.number)} — ${esc(p.name || "Untitled")} (${esc(p.status || "No status")})</option>`).join("")}</select></label><div id="st-project-preview"></div><div class="actions"><button class="btn" id="st-project-prev" ${page === 1 ? "disabled" : ""}>Previous</button><button class="btn" id="st-project-next" ${r.hasMore ? "" : "disabled"}>Next</button><button class="btn primary" id="st-project-connect" disabled>${importing ? "Add selected project" : "Use selected ST project"}</button></div>${r.data.length ? "" : "<p>No matching projects.</p>"}`;
          el("st-project-choice").addEventListener("change", () => {
            const p = r.data.find(
              (p) => p.id === el("st-project-choice").value,
            );
            el("st-project-connect").disabled = !p;
            el("st-project-preview").textContent = p
              ? `${p.jobIds.length} jobs will be pulled from ST.${importing ? "" : " This replaces the PM project number, name, address and dates with ST information."}`
              : "";
          });
          el("st-project-prev").onclick = () => {
            page--;
            void load();
          };
          el("st-project-next").onclick = () => {
            page++;
            void load();
          };
          el("st-project-connect").onclick = async (e) => {
            e.target.disabled = true;
            try {
              await sync(el("st-project-choice").value);
            } catch (error) {
              el("st-project-message").textContent = error.message;
              e.target.disabled = false;
            }
          };
        } catch (error) {
          el("st-project-picker").textContent = error.message;
        }
      }
      el("st-project-search")?.addEventListener("click", () => {
        page = 1;
        number = el("st-project-number").value.trim();
        void load();
      });
      if (!linked) await load();
    } catch (error) {
      if (el("st-project-body"))
        el("st-project-body").textContent = error.message;
    }
  }
  return { open: () => open(false), openImport: () => open(true) };
}
