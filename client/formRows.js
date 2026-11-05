/**
 * One label with its own control.
 * Cards that used to put every label and input on one wrapping line use this.
 */

export function formRow(label, controlHtml, inputId) {
  const name = inputId
    ? `<label class="form-row-label" for="${inputId}">${label}</label>`
    : `<div class="form-row-label">${label}</div>`;
  return `<div class="form-row">${name}<div class="form-row-field">${controlHtml}</div></div>`;
}
