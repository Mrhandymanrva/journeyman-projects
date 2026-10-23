export function createUsers({ api, el, esc, openDrawer, closeDrawer, can }) {
  let users = [],
    units = [],
    people = [];
  let statusFilter = "active";
  const roles = [
    "owner",
    "manager",
    "project_manager",
    "estimator",
    "office",
    "bookkeeper",
  ];
  const roleLabel = (r) => r.replaceAll("_", " ");
  function setup(result) {
    const url = location.origin + "/#setup=" + result.setupToken;
    openDrawer(
      "Password setup link",
      `<p>This private, one-time link expires in 24 hours. Share it directly with this user so they can choose their password.</p><label>Setup link<input id="user-setup-link" readonly value="${esc(url)}"></label><p>Creating this link does not send an email. Existing sessions are signed out when the password is changed.</p><p class="hint">To set your own password, open the link in a new tab.</p>`,
    );
  }
  async function render() {
    const target = el("page-users");
    if (!can("manage_users")) {
      target.textContent = "Only an owner can manage users.";
      return;
    }
    target.textContent = "Loading users…";
    try {
      const data = await api("/users");
      users = data.users;
      units = data.units;
      drawUsers();
    } catch (e) {
      target.textContent = e.message;
    }
  }
  function drawUsers() {
    const target = el("page-users");
    const visibleUsers = users.filter(
      (user) => user.active === (statusFilter === "active"),
    );
    target.innerHTML = `<div class="card workspace-records"><div class="workspace-record-title"><h2>Company users</h2><button class="btn primary" id="user-new">Add user</button></div><p>Each user signs in with an email and password. Select a role to control what they can do. Deactivate an account to block access while keeping its project history. You can reactivate it later.</p><label>User status<select id="user-status-filter"><option value="active">Active</option><option value="inactive">Inactive</option></select></label><p id="user-list-empty" role="status" hidden></p><div class="user-list">${visibleUsers.map((u) => `<article class="user-row"><div><strong>${esc(u.full_name)}</strong><p>${esc(u.email)}${u.phone ? " · " + esc(u.phone) : ""}</p><small>${esc(roleLabel(u.role))} · ${u.active ? (u.has_password ? "Active" : "Password setup needed") : "Inactive"}${u.source_person_id ? " · ST " + esc(u.source_person_kind) : ""}</small></div><div><button class="btn" data-user-edit="${u.id}">Edit</button> <button class="btn" data-user-status="${u.id}">${u.active ? "Deactivate" : "Reactivate"}</button> ${u.active ? `<button class="btn" data-user-setup="${u.id}">${u.has_password ? "Reset password" : "Set up password"}</button>` : ""}</div></article>`).join("")}</div></div>`;
    el("user-status-filter").value = statusFilter;
    el("user-status-filter").onchange = (event) => {
      statusFilter = event.target.value;
      drawUsers();
      el("user-status-filter").focus();
    };
    el("user-list-empty").hidden = visibleUsers.length > 0;
    el("user-list-empty").textContent = "No " + statusFilter + " users.";
    el("user-new").onclick = () => form();
    target.querySelectorAll("[data-user-status]").forEach((button) => {
      button.onclick = () =>
        statusForm(users.find((user) => user.id === button.dataset.userStatus));
    });
    target
      .querySelectorAll("[data-user-edit]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            form(users.find((u) => u.id === b.dataset.userEdit))),
      );
    target.querySelectorAll("[data-user-setup]").forEach(
      (b) =>
        (b.onclick = async () => {
          b.disabled = true;
          try {
            setup(
              await api("/users/" + b.dataset.userSetup + "/setup-link", {
                method: "POST",
              }),
            );
          } catch (e) {
            b.textContent = e.message;
          } finally {
            b.disabled = false;
          }
        }),
    );
  }
  function statusForm(user) {
    const action = user.active ? "Deactivate" : "Reactivate";
    openDrawer(
      action + " user",
      `<form id="user-status-form"><p>${action} <strong>${esc(user.full_name)}</strong> (${esc(user.email)})?</p><p>${user.active ? "This user will be signed out and unable to access Journeyman PM. Existing project records and history will be kept. You can reactivate this account later." : "This user will be able to sign in again with their existing password and assigned role. If they have not set a password, create a new setup link after reactivating."}</p><p class="err" id="user-status-error" role="alert"></p><button class="btn primary" id="user-status-save">${action} user</button> <button class="btn" type="button" id="user-status-cancel">Cancel</button></form>`,
    );
    el("user-status-cancel").onclick = closeDrawer;
    el("user-status-form").onsubmit = async (event) => {
      event.preventDefault();
      const save = el("user-status-save");
      const error = el("user-status-error");
      save.disabled = true;
      error.textContent = "";
      try {
        await api("/users/" + user.id, {
          method: "PATCH",
          body: JSON.stringify({
            full_name: user.full_name,
            phone: user.phone ?? "",
            role: user.role,
            business_unit_id: user.business_unit_id,
            active: !user.active,
          }),
        });
        closeDrawer();
        await render();
      } catch (failure) {
        error.textContent = failure.message;
        save.disabled = false;
      }
    };
  }

  function form(user) {
    people = [];
    openDrawer(
      user ? "Edit user" : "Add user",
      `<form id="user-form">${!user ? '<label>Add from<select id="user-source"><option value="manual">Enter details manually</option><option value="st">Active ServiceTitan employee</option></select></label><div id="user-picker" hidden><label>ServiceTitan employee<select id="user-person" required disabled><option value="">Loading…</option></select></label><p id="user-source-status" role="status"></p></div>' : ""}<label>Full name<input id="user-name" required maxlength="150" value="${esc(user?.full_name ?? "")}"></label><label>Email<input id="user-email" type="email" required maxlength="254" ${user ? "readonly" : ""} value="${esc(user?.email ?? "")}"></label><label>Phone<input id="user-phone" type="tel" maxlength="60" value="${esc(user?.phone ?? "")}"></label><label>Role<select id="user-role" required><option value="">Choose a role</option>${roles.map((r) => `<option value="${r}" ${user?.role === r ? "selected" : ""}>${esc(roleLabel(r))}</option>`).join("")}</select></label><p class="hint">Owner: all access and user administration. Manager: project and financial approvals. Project manager: planning, logs and project work. Office: project intake and vendor coordination. Estimator: estimates and cost visibility. Bookkeeper: vendor bills and financial records. All staff roles can read project data within their business-unit scope.</p><label>Business unit<select id="user-unit"><option value="">All business units</option>${units.map((u) => `<option value="${u.id}" ${user?.business_unit_id === u.id ? "selected" : ""}>${esc(u.name)}</option>`).join("")}</select></label><p class="hint">Business-unit visibility applies when enabled for this account.</p>${user ? `<label><input type="checkbox" id="user-active" ${user.active ? "checked" : ""}> Active account</label>` : "<p>After saving, you will receive a private password setup link to share with this user.</p>"}<p class="err" id="user-error" role="alert"></p><button class="btn primary" id="user-save">${user ? "Save changes" : "Create user & setup link"}</button></form>`,
    );
    if (!user) {
      el("user-source").onchange = async () => {
        const isST = el("user-source").value === "st";
        el("user-picker").hidden = !isST;
        el("user-person").disabled = true;
        el("user-save").disabled = isST;
        if (!isST) return;
        el("user-source-status").textContent =
          "Reading active employees and technicians…";
        try {
          people = await api("/users/st-employees");
          if (!el("user-person")) return;
          el("user-person").innerHTML =
            '<option value="">Select employee</option>' +
            people
              .map(
                (p, i) =>
                  `<option value="${i}">${esc(p.name)} · ${esc(p.kind)}${p.email ? " · " + esc(p.email) : ""}</option>`,
              )
              .join("");
          el("user-person").disabled = false;
          el("user-save").disabled = false;
          el("user-source-status").textContent =
            people.length +
            " active people. Enterprise Hub users excluded. Review the email before creating their account.";
        } catch (e) {
          if (el("user-source-status"))
            el("user-source-status").textContent = e.message;
        }
      };
      el("user-person").onchange = () => {
        const p = people[Number(el("user-person").value)];
        if (!p || el("user-person").value === "") return;
        el("user-name").value = p.name;
        el("user-email").value = p.email ?? "";
        el("user-phone").value = p.phone ?? "";
      };
    }
    el("user-form").onsubmit = async (e) => {
      e.preventDefault();
      const b = {
        full_name: el("user-name").value,
        email: el("user-email").value,
        phone: el("user-phone").value,
        role: el("user-role").value,
        business_unit_id: el("user-unit").value || null,
      };
      if (user) {
        delete b.email;
        b.active = el("user-active").checked;
      } else if (el("user-source").value === "st") {
        const p = people[Number(el("user-person").value)];
        if (!p || el("user-person").value === "") return;
        b.source_person_id = p.id;
        b.source_person_kind = p.kind;
      }
      el("user-save").disabled = true;
      try {
        const result = await api("/users" + (user ? "/" + user.id : ""), {
          method: user ? "PATCH" : "POST",
          body: JSON.stringify(b),
        });
        closeDrawer();
        await render();
        if (!user) setup(result);
      } catch (error) {
        el("user-error").textContent = error.message;
        if (el("user-save")) el("user-save").disabled = false;
      }
    };
  }
  return { render };
}
