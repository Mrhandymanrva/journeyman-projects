import { formRow } from "./formRows.js";

/** Five closeout items. A blank note or invoice is not done. */
export function closeoutDoneCount(row) {
  const current = row || {};
  const invoice = String(current.final_draw_invoice_number || "").trim();
  const review = String(current.review_request_note || "").trim();
  return [
    Boolean(current.punch_done_at),
    Boolean(current.photos_done_at),
    invoice.length > 0,
    Boolean(current.warranty_start_on),
    review.length > 0,
  ].filter(Boolean).length;
}

export function closeoutDoneLabel(count) {
  return `${count} of 5`;
}

/**
 * Same JSON the closeout card has always saved.
 * Punch and photo notes stay as typed. The invoice number is trimmed.
 * An empty invoice or warranty date is null. Nothing here emails anyone.
 */
export function closeoutSavePayload(fields) {
  const invoice = String(fields.final_draw_invoice_number ?? "").trim();
  return {
    punch_done: Boolean(fields.punch_done),
    punch_note: fields.punch_note,
    photos_done: Boolean(fields.photos_done),
    photos_note: fields.photos_note,
    final_draw_invoice_number: invoice || null,
    warranty_start_on: fields.warranty_start_on || null,
    review_request_note: fields.review_request_note,
  };
}

export function closeoutCardHtml(row, helpers) {
  const current = row || {};
  const esc = helpers.esc;
  const may = helpers.canEdit === true;
  const disabled = may ? "" : "disabled";
  const done = closeoutDoneLabel(closeoutDoneCount(current));
  const check = (id, checked, label) =>
    `<input id="${id}" type="checkbox" aria-label="${label}" ${checked ? "checked" : ""} ${disabled}>`;
  const note = (id, value, label) =>
    `<input id="${id}" type="text" value="${esc(value || "")}" maxlength="2000" aria-label="${label}" placeholder="${label}" ${disabled}>`;
  return `<div class="closeout-form" data-done="${done}">
    <p class="note">Punch, photos, the final draw invoice, the warranty date, and the review request live on this card. Nothing here emails the customer or writes to ServiceTitan. Photos stay in the photos folder. Gate 4 is still ticked by a person.</p>
    ${formRow(
      "Punch list complete",
      `<div class="form-row-split">${check("cl-punch", current.punch_done_at, "Punch list complete")}${note("cl-punch-note", current.punch_note, "Punch note")}</div>`,
      "cl-punch-note",
    )}
    ${formRow(
      "Final photos filed",
      `<div class="form-row-split">${check("cl-photos", current.photos_done_at, "Final photos filed")}${note("cl-photos-note", current.photos_note, "Photo note")}</div>`,
      "cl-photos-note",
    )}
    ${formRow(
      "Final draw invoice #",
      `<input id="cl-invoice" type="text" value="${esc(current.final_draw_invoice_number || "")}" maxlength="80" ${disabled}>`,
      "cl-invoice",
    )}
    ${formRow(
      "Warranty start",
      `<input id="cl-warranty" type="date" value="${esc(current.warranty_start_on || "")}" ${disabled}>`,
      "cl-warranty",
    )}
    ${formRow(
      "Review request",
      `<textarea id="cl-review" maxlength="2000" ${disabled}>${esc(current.review_request_note || "")}</textarea>`,
      "cl-review",
    )}
    <p class="note">The review request is a note on this project. Nobody is emailed.</p>
    ${
      may
        ? `<div class="form-actions"><button class="btn sm primary" id="cl-save" type="button">Save</button></div>`
        : `<p class="note">Owner, manager, or the project coordinator records closeout.</p>`
    }
  </div>`;
}
