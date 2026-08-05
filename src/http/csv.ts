/**
 * CSV for the accounting handoff.
 *
 * Two things this does that a `rows.map(r => r.join(','))` does not:
 *
 * 1. RFC 4180 quoting. A cost code description containing a comma — "Testing —
 *    radon, lead, asbestos" is in the shipped library — silently shifts every
 *    column after it otherwise, and a bookkeeper finds out by reconciling.
 *
 * 2. Formula injection defence. A leading =, +, -, or @ makes Excel treat the
 *    cell as a formula, and these files are opened in Excel by definition.
 *    Vendor names and invoice numbers are attacker-controllable through the
 *    portal, so a cell starting with one is prefixed with a tab.
 */
export function toCsv(columns: string[], rows: Array<Record<string, unknown>>): string {
  const lines = [columns.map(escape).join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => escape(row[c])).join(','));
  }
  // Trailing newline: some importers drop the last record without one.
  return lines.join('\r\n') + '\r\n';
}

function escape(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = value instanceof Date ? value.toISOString() : String(value);

  if (/^[=+\-@\t\r]/.test(text)) text = `\t${text}`;

  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}
