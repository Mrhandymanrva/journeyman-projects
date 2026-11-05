const METHODS = ["phone", "portal", "email", "in_person", "other"];

function day(value) {
  const match = String(value || "").match(/^(\d{4}-\d{2}-\d{2})/);
  if (!match) return "";
  return new Date(match[1] + "T12:00:00").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function safeHref(url) {
  return /^https?:\/\//i.test(String(url || "")) ? String(url) : "";
}

function link(url, label, esc) {
  const href = safeHref(url);
  if (!href) return "";
  return `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
}

function contactHtml(contact, canEdit, esc) {
  const title = contact.title ? esc(contact.title) : "No title";
  const reach = [contact.phone, contact.email].filter(Boolean).map((part) => esc(part)).join(" · ");
  const tools = canEdit
    ? `<div class="actions"><button class="btn sm" type="button" data-contact-edit="${esc(contact.id)}">Edit</button><button class="btn sm" type="button" data-contact-delete="${esc(contact.id)}">Remove</button></div>`
    : "";
  return `<li class="office-contact" data-contact="${esc(contact.id)}">
    <div><strong>${esc(contact.name)}</strong> <span class="office-title">${title}</span>${reach ? `<small>${reach}</small>` : ""}<p>${contact.notes ? esc(contact.notes) : "No notes"}</p></div>
    ${tools}
  </li>`;
}

export function officeDirectoryHtml({ offices, canEdit, esc }) {
  const rows = Array.isArray(offices) ? offices : [];
  const tools = canEdit
    ? `<div class="actions"><button class="btn" type="button" id="office-import">Import CSV or JSON</button><button class="btn primary" type="button" id="office-add">Add office</button></div>`
    : "";
  const cards = rows.length
    ? rows.map((office) => officeCardHtml(office, canEdit, esc)).join("")
    : `<div class="workspace-empty"><strong>No permit offices yet</strong><p>Add an office or import a CSV or JSON file for this company.</p></div>`;
  return `<div class="card"><div class="card-h"><div><span class="lbl">Directory</span><h2>Permit offices</h2></div>${tools}</div><div class="card-b"><p class="hint">Each office can have any number of contacts. Title and notes stay on the contact. An import updates offices for this company and leaves out contacts that the file does not mention.</p><p class="office-msg" role="status"></p>${cards}</div></div>`;
}

export function officeCardHtml(office, canEdit, esc) {
  const contacts = Array.isArray(office.contacts) ? office.contacts : [];
  const address = [
    office.address_line1,
    office.address_line2,
    office.office_city,
    office.state,
    office.postal_code,
  ]
    .filter(Boolean)
    .join(", ");
  const links = [
    link(office.website_url, "Website", esc),
    link(office.portal_url, "Portal", esc),
    link(office.fee_schedule_url, "Fee schedule", esc),
    link(office.inspection_url, "Inspection link", esc),
  ]
    .filter(Boolean)
    .join(" · ");
  const facts = [
    office.contact_phone ? `Main ${office.contact_phone}` : "",
    office.inspection_method
      ? `Inspections by ${String(office.inspection_method).replace(/_/g, " ")}`
      : "",
    office.inspection_phone ? `Inspection phone ${office.inspection_phone}` : "",
    office.typical_review_days != null ? `${office.typical_review_days} day review` : "",
    office.last_verified ? `Verified ${day(office.last_verified)}` : "",
  ].filter(Boolean);
  const criteria = [
    ["Work requiring a permit", office.work_requiring_permit],
    ["Required documents", office.required_documents],
    ["Plan requirements", office.plan_requirements],
    ["Fees", office.fee_notes],
    ["Office notes", office.notes],
  ]
    .filter(([, value]) => value)
    .map(([label, value]) => `<p><span class="lbl">${esc(label)}</span><br>${esc(value)}</p>`)
    .join("");
  const contactTools = canEdit
    ? `<button class="btn sm" type="button" data-contact-add="${esc(office.id)}">Add contact</button>`
    : "";
  const edit = canEdit
    ? `<button class="btn sm" type="button" data-office-edit="${esc(office.id)}">Edit office</button>`
    : "";
  return `<article class="office-card" data-office="${esc(office.id)}">
    <header><div><h3>${esc(office.name)}, ${esc(office.state)}</h3><p>${esc(office.office_name || "Office name not set")}</p></div><div class="actions">${edit}</div></header>
    ${address ? `<p>${esc(address)}</p>` : ""}
    ${facts.length ? `<p class="precon-meta">${esc(facts.join(" · "))}</p>` : ""}
    ${links ? `<p>${links}</p>` : ""}
    ${criteria}
    <div class="office-contacts"><span class="lbl">Contacts</span>${contactTools}<ul>${contacts.length ? contacts.map((contact) => contactHtml(contact, canEdit, esc)).join("") : "<li>No contacts yet.</li>"}</ul></div>
  </article>`;
}

function textOrNull(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed ? trimmed : null;
}

function contactBody(root) {
  return {
    name: root.querySelector("#contact-name").value.trim(),
    title: textOrNull(root.querySelector("#contact-title").value),
    phone: textOrNull(root.querySelector("#contact-phone").value),
    email: textOrNull(root.querySelector("#contact-email").value),
    notes: textOrNull(root.querySelector("#contact-notes").value),
  };
}

function contactForm(contact, esc) {
  const value = contact || {};
  return `<form id="contact-form">
    <label>Name<input id="contact-name" required maxlength="200" value="${esc(value.name || "")}"></label>
    <label>Title<input id="contact-title" maxlength="200" value="${esc(value.title || "")}" placeholder="Plan reviewer"></label>
    <label>Phone<input id="contact-phone" maxlength="80" value="${esc(value.phone || "")}"></label>
    <label>Email<input id="contact-email" type="email" maxlength="200" value="${esc(value.email || "")}"></label>
    <label>Notes<textarea id="contact-notes" maxlength="2000" rows="3" placeholder="handles residential plan review; call before 10am">${esc(value.notes || "")}</textarea></label>
    <p class="err" id="contact-error" role="alert"></p>
    <button class="btn primary" type="submit">Save contact</button>
  </form>`;
}

const OFFICE_FIELDS = [
  ["office_name", "Office name", 200],
  ["address_line1", "Address", 200],
  ["address_line2", "Address line 2", 200],
  ["office_city", "City", 200],
  ["postal_code", "Postal code", 20],
  ["contact_phone", "Main phone", 80],
  ["website_url", "Website", 2000],
  ["portal_url", "Portal", 2000],
  ["fee_schedule_url", "Fee schedule URL", 2000],
  ["inspection_phone", "Inspection phone", 80],
  ["inspection_url", "Inspection URL", 2000],
];

function officeForm(office, esc) {
  const value = office || {};
  const method = `<label>Inspection method<select id="office-inspection_method"><option value="">Not set</option>${METHODS.map((item) => `<option value="${item}"${value.inspection_method === item ? " selected" : ""}>${item.replace(/_/g, " ")}</option>`).join("")}</select></label>`;
  const longs = [
    ["work_requiring_permit", "Work requiring a permit", 4000],
    ["required_documents", "Required documents", 4000],
    ["plan_requirements", "Plan requirements", 4000],
    ["fee_notes", "Fee notes", 4000],
    ["notes", "Office notes", 2000],
  ]
    .map(
      ([key, label, max]) =>
        `<label>${label}<textarea id="office-${key}" maxlength="${max}" rows="2">${esc(value[key] || "")}</textarea></label>`,
    )
    .join("");
  return `<form id="office-form">
    <label>Municipality<input id="office-name" required maxlength="200" value="${esc(value.name || "")}"></label>
    <label>State<input id="office-state" required maxlength="2" value="${esc(value.state || "")}"></label>
    ${OFFICE_FIELDS.map(([key, label, max]) => `<label>${label}<input id="office-${key}" maxlength="${max}" value="${esc(value[key] || "")}"></label>`).join("")}
    ${method}
    <label>Typical review days<input id="office-typical_review_days" type="number" min="0" max="3650" value="${value.typical_review_days ?? ""}"></label>
    <label>Last verified<input id="office-last_verified" type="date" value="${esc(String(value.last_verified || "").slice(0, 10))}"></label>
    ${longs}
    <p class="err" id="office-error" role="alert"></p>
    <button class="btn primary" type="submit">Save office</button>
  </form>`;
}

function officeBody(root) {
  const body = {
    name: root.querySelector("#office-name").value.trim(),
    state: root.querySelector("#office-state").value.trim().toUpperCase(),
  };
  for (const [key] of OFFICE_FIELDS) body[key] = textOrNull(root.querySelector("#office-" + key).value);
  body.inspection_method = textOrNull(root.querySelector("#office-inspection_method").value);
  const days = root.querySelector("#office-typical_review_days").value.trim();
  body.typical_review_days = days === "" ? null : Number(days);
  body.last_verified = textOrNull(root.querySelector("#office-last_verified").value);
  for (const key of [
    "work_requiring_permit",
    "required_documents",
    "plan_requirements",
    "fee_notes",
    "notes",
  ]) {
    body[key] = textOrNull(root.querySelector("#office-" + key).value);
  }
  return body;
}

function importForm() {
  return `<form id="office-import-form">
    <p>Choose a CSV or JSON file for this company. The CSV uses contact_title and contact_notes. JSON contacts use name, title, phone, email, and notes. Contacts the file leaves out stay on the office.</p>
    <label>File<input id="office-import-file" type="file" accept=".csv,.json,text/csv,text/plain,application/json" required></label>
    <p class="err" id="office-import-error" role="alert"></p>
    <button class="btn primary" type="submit">Import offices</button>
  </form>`;
}

export function createPermitOffices({ api, esc, can, openDrawer, closeDrawer }) {
  let offices = [];
  const editable = () => can("manage_permit_offices");

  async function render(target, still) {
    target.innerHTML = `<div class="card"><div class="card-b">Loading permit offices…</div></div>`;
    try {
      offices = await api("/jurisdictions");
      if (still && !still()) return;
      paint(target, still);
    } catch (error) {
      if (still && !still()) return;
      target.innerHTML = `<div class="card"><div class="card-b">${esc(error.message)}</div></div>`;
    }
  }

  function paint(target, still) {
    target.innerHTML = officeDirectoryHtml({
      offices,
      canEdit: editable(),
      esc,
    });
    const message = (text) => {
      const box = target.querySelector(".office-msg");
      if (box) box.textContent = text || "";
    };
    target.querySelector("#office-add")?.addEventListener("click", () => editOffice(null, target, still));
    target.querySelector("#office-import")?.addEventListener("click", () => importOffices(target, still, message));
    target.querySelectorAll("[data-office-edit]").forEach((button) => {
      button.addEventListener("click", () => {
        const office = offices.find((item) => item.id === button.dataset.officeEdit);
        if (office) editOffice(office, target, still);
      });
    });
    target.querySelectorAll("[data-contact-add]").forEach((button) => {
      button.addEventListener("click", () => editContact(button.dataset.contactAdd, null, target, still));
    });
    target.querySelectorAll("[data-contact-edit]").forEach((button) => {
      button.addEventListener("click", () => {
        const office = offices.find((item) =>
          (item.contacts || []).some((contact) => contact.id === button.dataset.contactEdit),
        );
        const contact = office?.contacts?.find((item) => item.id === button.dataset.contactEdit);
        if (office && contact) editContact(office.id, contact, target, still);
      });
    });
    target.querySelectorAll("[data-contact-delete]").forEach((button) => {
      button.addEventListener("click", async () => {
        if (!window.confirm("Remove this contact? The office stays.")) return;
        button.disabled = true;
        try {
          await api("/jurisdiction-contacts/" + button.dataset.contactDelete, { method: "DELETE" });
          await render(target, still);
        } catch (error) {
          message(error.message);
          button.disabled = false;
        }
      });
    });
  }

  function editOffice(office, target, still) {
    openDrawer(office ? "Edit permit office" : "Add permit office", officeForm(office, esc), () => {
      const form = document.getElementById("office-form");
      form.onsubmit = async (event) => {
        event.preventDefault();
        const error = document.getElementById("office-error");
        error.textContent = "";
        const body = officeBody(form);
        if (!/^[A-Z]{2}$/.test(body.state)) {
          error.textContent = "Use a two-letter state.";
          return;
        }
        if (body.typical_review_days != null && !Number.isInteger(body.typical_review_days)) {
          error.textContent = "Review days must be a whole number.";
          return;
        }
        form.querySelector("button").disabled = true;
        try {
          await api(office ? "/jurisdictions/" + office.id : "/jurisdictions", {
            method: office ? "PATCH" : "POST",
            body: JSON.stringify(body),
          });
          closeDrawer();
          await render(target, still);
        } catch (err) {
          error.textContent = err.message;
          form.querySelector("button").disabled = false;
        }
      };
    });
  }

  function editContact(officeId, contact, target, still) {
    openDrawer(contact ? "Edit contact" : "Add contact", contactForm(contact, esc), () => {
      const form = document.getElementById("contact-form");
      form.onsubmit = async (event) => {
        event.preventDefault();
        const error = document.getElementById("contact-error");
        error.textContent = "";
        const body = contactBody(form);
        if (!body.name) {
          error.textContent = "A contact needs a name.";
          return;
        }
        form.querySelector("button").disabled = true;
        try {
          await api(
            contact ? "/jurisdiction-contacts/" + contact.id : "/jurisdictions/" + officeId + "/contacts",
            {
              method: contact ? "PATCH" : "POST",
              body: JSON.stringify(body),
            },
          );
          closeDrawer();
          await render(target, still);
        } catch (err) {
          error.textContent = err.message;
          form.querySelector("button").disabled = false;
        }
      };
    });
  }

  function importOffices(target, still, message) {
    openDrawer("Import permit offices", importForm(), () => {
      const form = document.getElementById("office-import-form");
      form.onsubmit = async (event) => {
        event.preventDefault();
        const error = document.getElementById("office-import-error");
        error.textContent = "";
        const file = document.getElementById("office-import-file").files?.[0];
        if (!file) {
          error.textContent = "Choose a CSV or JSON file.";
          return;
        }
        form.querySelector("button").disabled = true;
        try {
          const text = await file.text();
          const json = /\.json$/i.test(file.name) || file.type.includes("json");
          const result = await api("/jurisdictions/import", {
            method: "POST",
            body: text,
            headers: { "content-type": json ? "application/json" : "text/csv" },
          });
          closeDrawer();
          await render(target, still);
          const box = target.querySelector(".office-msg");
          if (box) {
            box.textContent = `Import finished. ${result.created} created, ${result.updated} updated, ${result.contacts_upserted} contacts saved, ${result.unchanged} unchanged.`;
          }
        } catch (err) {
          error.textContent = err.message;
          form.querySelector("button").disabled = false;
          message("");
        }
      };
    });
  }

  return { render };
}
