/**
 * Printable final project report.
 * Same sections for the HTML print view and the PDF download.
 * PDFKit and the Noto Sans files already used by project-record exports.
 * The footer marks the report internal. It is not a customer document.
 */

import path from "node:path";
import PDFDocument from "pdfkit";
import { escapeHtml } from "./documentExport.js";
import {
  showCloseoutDraftBanner,
  type CloseoutSummaryBody,
  type PulledSnapshot,
} from "./closeoutSummary.js";

export interface ReportSource {
  company: string;
  body: CloseoutSummaryBody;
  pulled: PulledSnapshot;
  finalized?: boolean;
  warnings?: string[];
}

export function draftBanner(source: {
  finalized?: boolean;
  warnings?: string[];
}): { title: string; items: string[] } | null {
  if (source.warnings == null && source.finalized == null) return null;
  const items = source.warnings ?? [];
  if (!showCloseoutDraftBanner(source.finalized === true, items)) return null;
  return { title: "Draft, not final", items };
}

type Block =
  | { kind: "h1" | "h2" | "h3"; text: string }
  | { kind: "p" | "note"; text: string }
  | { kind: "table"; headers: string[]; rows: string[][] };

const PULLED = "Pulled from the project. Saved with this report.";

export function buildCloseoutReportBlocks(source: ReportSource): Block[] {
  const { body, pulled } = source;
  const blocks: Block[] = [];
  const heading = (kind: "h1" | "h2" | "h3", text: string) =>
    blocks.push({ kind, text });
  const paragraph = (text: string) =>
    blocks.push({ kind: "p", text: text || "Not recorded." });
  const note = (text: string) => blocks.push({ kind: "note", text });
  const table = (headers: string[], rows: string[][]) =>
    blocks.push({
      kind: "table",
      headers,
      rows: rows.length ? rows : [headers.map(() => "—")],
    });

  heading("h1", "Roles and responsibilities");
  note(PULLED);
  table(
    ["Name", "Role", "Responsibilities"],
    body.roles.map((row) => [row.name, row.role, row.responsibilities]),
  );

  heading("h1", "1. Final project summary");
  heading("h2", "1.1 Content summary");

  heading("h3", "Scope");
  note(PULLED);
  paragraph(pulled.scope.summary || "No project summary is on file.");
  if (pulled.scope.charter_documents.length) {
    paragraph(
      `Charter and scope documents: ${pulled.scope.charter_documents.join("; ")}.`,
    );
  } else {
    paragraph("No documents are filed in the charter and scope folder.");
  }
  if (body.narrative.scope) {
    note("Project manager's summary");
    paragraph(body.narrative.scope);
  }

  heading("h3", "Schedule");
  note(PULLED);
  table(
    ["", "Date"],
    [
      ["Scheduled start", show(pulled.schedule.scheduled_start)],
      ["Scheduled end", show(pulled.schedule.scheduled_end)],
      ["Field start", show(pulled.schedule.field_start)],
      ["Actual start", show(pulled.schedule.actual_start)],
      ["Actual end", show(pulled.schedule.actual_end)],
      ["Plan baseline start", show(pulled.schedule.plan_baseline_start)],
      ["Plan baseline finish", show(pulled.schedule.plan_baseline_finish)],
    ],
  );
  if (pulled.schedule.milestones.length) {
    table(
      ["Milestone", "Due", "Completed", "State"],
      pulled.schedule.milestones.map((row) => [
        row.title,
        show(row.due_on),
        show(row.completed_on),
        label(row.state),
      ]),
    );
  }
  if (pulled.schedule.tasks.length) {
    table(
      ["Task", "Start", "Finish", "Completed", "State"],
      pulled.schedule.tasks.map((row) => [
        row.title,
        show(row.start_on),
        show(row.due_on),
        show(row.completed_on),
        label(row.state),
      ]),
    );
  }
  if (pulled.schedule.items.length) {
    table(
      ["Schedule item", "Window", "Status", "Assigned"],
      pulled.schedule.items.map((row) => [
        row.title,
        [row.window_start, row.window_end].filter(Boolean).join(" – ") || "—",
        label(row.status),
        row.assigned_to || "—",
      ]),
    );
  }
  paragraph(
    `Daily logs: ${pulled.daily_logs.count} ${pulled.daily_logs.count === 1 ? "entry" : "entries"}` +
      (pulled.daily_logs.first_on
        ? `, ${pulled.daily_logs.first_on} through ${pulled.daily_logs.last_on ?? pulled.daily_logs.first_on}`
        : "") +
      ".",
  );
  if (body.narrative.schedule_commentary) {
    note("Project manager's commentary");
    paragraph(body.narrative.schedule_commentary);
  }

  if (pulled.costs) {
    const costs = pulled.costs;
    heading("h3", "Costs and budget");
    note(
      "Pulled from financials, cost position, the change-order log, purchase orders, and vendor bills. Internal. Includes margin.",
    );
    table(
      ["Figure", "Amount"],
      [
        ["Contract", money(costs.contract_value, pulled.currency)],
        ["Budgeted expense", money(costs.budgeted_expense, pulled.currency)],
        ["Actual expense", money(costs.actual_expense, pulled.currency)],
        ["Labor, actual", money(costs.labor_actual, pulled.currency)],
        ["Materials, actual", money(costs.materials_actual, pulled.currency)],
        [
          "Subcontractor, actual",
          money(costs.subcontractor_actual, pulled.currency),
        ],
        ["Budgeted labor", money(costs.budgeted_labor, pulled.currency)],
        [
          "Budgeted materials",
          money(costs.budgeted_materials, pulled.currency),
        ],
        [
          "Budgeted subcontract",
          money(costs.budgeted_subcontractor, pulled.currency),
        ],
        ["Budgeted margin", money(costs.budgeted_margin, pulled.currency)],
        ["Budgeted margin percent", percent(costs.budgeted_margin_percent)],
        ["Actual margin", money(costs.actual_margin, pulled.currency)],
        ["Actual margin percent", percent(costs.actual_margin_percent)],
        ["Open commitments", money(costs.committed_open, pulled.currency)],
        ["Total committed", money(costs.total_committed, pulled.currency)],
        ["Variance", money(costs.variance, pulled.currency)],
        [
          "Approved change orders",
          money(costs.approved_change_orders, pulled.currency),
        ],
        [
          "Purchase orders",
          `${costs.purchase_orders.count} · ${money(costs.purchase_orders.total, pulled.currency)}`,
        ],
        [
          "Vendor bills",
          `${costs.vendor_bills.count} · ${money(costs.vendor_bills.total, pulled.currency)}`,
        ],
      ],
    );
    if (body.narrative.cost_commentary) {
      note("Project manager's commentary");
      paragraph(body.narrative.cost_commentary);
    }
  }

  heading("h3", "Risk");
  note("Report snapshot. The live risk register is not changed.");
  table(
    ["Risk description", "Impact level", "Probability", "Mitigation"],
    body.risks.map((row) => [
      row.description,
      row.impact == null ? "—" : String(row.impact),
      row.probability == null ? "—" : String(row.probability),
      row.roam ? `${row.mitigation} (${label(row.roam)})` : row.mitigation,
    ]),
  );

  heading("h3", "Communication strategy and methods");
  note("Report snapshot. The live communication plan is not changed.");
  table(
    ["Audience", "Channel", "Cadence", "Notes"],
    body.communications.map((row) => [
      row.audience,
      label(row.channel),
      label(row.cadence),
      row.notes,
    ]),
  );

  heading("h2", "1.2 Lessons learned");
  paragraph(body.narrative.lessons_learned);

  heading("h2", "1.3 Learning outcomes");
  note("Optional.");
  paragraph(
    body.narrative.learning_outcomes_summary ||
      "No summary of learning outcomes was written.",
  );
  if (body.learning_outcomes.length) {
    table(
      ["Outcome name", "Detail"],
      body.learning_outcomes.map((row) => [row.name, row.detail]),
    );
  }

  heading("h2", "1.4 Project performance summary");
  note("How the team communicated, collaborated, and performed.");
  paragraph(body.narrative.performance_summary);

  heading("h2", "1.5 Critical thinking review");
  note("Optional. Problem-solving examples from the job.");
  paragraph(body.narrative.critical_thinking);

  heading("h1", "2. Post-mortem report");
  heading("h2", "Initial expectations");
  note("What was expected at the start of the project.");
  paragraph(body.post_mortem.initial_expectations);

  heading("h2", "Milestones");
  note(
    "Important events over the life of the project. Plan milestones are listed. Others can be added here.",
  );
  table(
    ["Event", "Due", "Completed", "State", "Note"],
    body.post_mortem.milestones.map((row) => [
      row.title,
      show(row.due_on),
      show(row.completed_on),
      label(row.state),
      row.note,
    ]),
  );

  heading("h2", "Achievements and obstacles");
  note("What went well and what did not.");
  paragraph(body.post_mortem.achievements_obstacles);

  heading("h2", "Roadblocks, risks and barriers");
  note(
    "Issues that caused delays, added cost, or made the job harder to finish.",
  );
  paragraph(body.post_mortem.roadblocks);

  heading("h2", "Additional resources");
  note("What else would have helped.");
  paragraph(body.post_mortem.additional_resources);

  heading("h2", "Root causes");
  paragraph(body.post_mortem.root_causes);

  heading("h2", "Key takeaways");
  paragraph(body.post_mortem.key_takeaways);

  heading("h2", "Action items");
  paragraph(body.post_mortem.action_items);

  heading("h2", "Next steps");
  paragraph(body.post_mortem.next_steps);

  heading("h1", "Closeout checklist");
  note(PULLED);
  table(
    ["Item", "Record"],
    [
      [
        "Punch list",
        yesNo(pulled.closeout.punch_done, pulled.closeout.punch_note),
      ],
      [
        "Final photos",
        yesNo(pulled.closeout.photos_done, pulled.closeout.photos_note),
      ],
      ["Photos folder", `${pulled.closeout.photo_document_count} documents`],
      [
        "Closeout folder",
        `${pulled.closeout.closeout_document_count} documents`,
      ],
      ["Final draw invoice", show(pulled.closeout.final_draw_invoice_number)],
      ["Warranty start", show(pulled.closeout.warranty_start_on)],
      ["Review request", show(pulled.closeout.review_request_note)],
      ["Gate 4", label(pulled.closeout.gate_4_status || "not opened")],
    ],
  );

  return blocks;
}

function show(value: string | null | undefined): string {
  const text = (value ?? "").trim();
  return text || "—";
}

function label(value: string): string {
  return value.replaceAll("_", " ");
}

function yesNo(done: boolean, note: string | null): string {
  const base = done ? "Done" : "Open";
  return note ? `${base}. ${note}` : base;
}

export function money(
  value: number | null | undefined,
  currency: string,
): string {
  if (value == null || !Number.isFinite(value)) return "Not recorded";
  try {
    return value.toLocaleString("en-US", {
      style: "currency",
      currency: currency || "USD",
    });
  } catch {
    return value.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
    });
  }
}

export function percent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "Not recorded";
  return `${value.toFixed(2)}%`;
}

export function formatReportDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return iso;
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

export function closeoutReportFooter(projectNumber: string): string {
  return `Internal closeout report · not for the customer · ${projectNumber}`;
}

export function closeoutReportHtml(source: ReportSource): string {
  const e = escapeHtml;
  const pulled = source.pulled;
  const footer = closeoutReportFooter(pulled.cover.project_number);
  const blocks = buildCloseoutReportBlocks(source)
    .map((block) => {
      if (block.kind === "h1") return `<h2>${e(block.text)}</h2>`;
      if (block.kind === "h2") return `<h3>${e(block.text)}</h3>`;
      if (block.kind === "h3") return `<h4>${e(block.text)}</h4>`;
      if (block.kind === "table") {
        const head = `<tr>${block.headers.map((cell) => `<th>${e(cell)}</th>`).join("")}</tr>`;
        const body = block.rows
          .map(
            (row) =>
              `<tr>${row.map((cell) => `<td>${e(cell)}</td>`).join("")}</tr>`,
          )
          .join("");
        return `<div class="document-table"><table>${head}${body}</table></div>`;
      }
      return `<p class="${block.kind === "note" ? "document-note" : ""}">${e(block.text)}</p>`;
    })
    .join("");
  const cover = pulled.cover;
  const banner = draftBanner(source);
  const bannerHtml = banner
    ? `<div class="draft-banner" role="status"><strong>${e(banner.title)}</strong>${
        banner.items.length
          ? `<ul>${banner.items.map((item) => `<li>${e(item)}</li>`).join("")}</ul>`
          : ""
      }</div>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${e(`Final project report — ${cover.name}`)}</title>
<style>
  body { margin: 24px; background: #eef2f5; color: #24364b; }
  .document-page { background: #fff; border: 1px solid #d8e1e8; border-top: 8px solid #193d59; padding: 36px; max-width: 800px; margin: auto; font: 14px/1.7 system-ui, sans-serif; overflow-wrap: anywhere; }
  .document-brand { display: flex; justify-content: space-between; gap: 20px; font-size: 11px; letter-spacing: 0.08em; }
  .document-brand span { color: #687b89; font-size: 9px; }
  h1 { font-size: 30px; line-height: 1.2; margin: 10px 0 8px; }
  .document-kicker { margin: 0 0 18px; letter-spacing: 0.12em; font-size: 12px; color: #687b89; }
  .document-meta { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding: 22px; background: #f7f9fb; margin: 0 0 30px; }
  .document-meta dt { font-size: 9px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #687b89; }
  .document-meta dd { margin: 4px 0 0; font-size: 12px; }
  h2 { font-size: 21px; margin: 30px 0 14px; }
  h3 { font-size: 16px; margin: 26px 0 10px; border-bottom: 1px solid #d8e1e8; padding-bottom: 8px; }
  h4 { font-size: 14px; margin: 18px 0 8px; }
  p { margin: 10px 0 16px; }
  .document-note { color: #687b89; font-size: 12px; margin: 0 0 8px; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; margin: 0 0 16px; }
  th, td { border: 1px solid #d8e1e8; padding: 8px; text-align: left; vertical-align: top; }
  th { background: #eaf0f5; }
  footer { margin-top: 38px; border-top: 1px solid #d8e1e8; padding-top: 14px; font-size: 10px; color: #687b89; }
  .draft-banner { background: #fff6e8; border: 1px solid #e6c48a; border-left: 4px solid #b86e00; padding: 10px 12px; margin: 0 0 18px; }
  .draft-banner strong { display: block; margin-bottom: 6px; }
  .draft-banner ul { margin: 0; padding-left: 18px; }
  @media print {
    body { margin: 0; background: #fff; }
    .document-page { border: none; max-width: none; }
  }
</style>
</head>
<body>
<article class="document-page">
  ${bannerHtml}
  <header class="document-brand"><strong>${e(source.company)}</strong><span>INTERNAL</span></header>
  <p class="document-kicker">${e(cover.project_number)} · ${e(label(cover.stage))}</p>
  <h1>${e(cover.name)}</h1>
  <p class="document-kicker">FINAL PROJECT REPORT</p>
  <p>${e(formatReportDate(source.body.report_date))}</p>
  <dl class="document-meta">
    <div><dt>Project</dt><dd>${e(cover.project_number)} · ${e(cover.name)}</dd></div>
    <div><dt>Customer</dt><dd>${e(cover.customer || "Not recorded")}</dd></div>
    <div><dt>Site</dt><dd>${e(cover.address || "Not recorded")}</dd></div>
    <div><dt>Project manager</dt><dd>${e(cover.pm_name || "Unassigned")}</dd></div>
  </dl>
  <div class="document-body">${blocks}</div>
  <footer>${e(footer)}</footer>
</article>
</body>
</html>`;
}

function xmlText(value: string): string {
  return value
    .replace(/[&<>]/g, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .slice(0, 240);
}

export async function renderCloseoutReportPdf(
  source: ReportSource,
): Promise<Buffer> {
  const pulled = source.pulled;
  const footer = closeoutReportFooter(pulled.cover.project_number);
  const banner = draftBanner(source);
  const doc = new PDFDocument({
    size: "LETTER",
    pdfVersion: "1.4",
    margins: { top: 56, bottom: 58, left: 54, right: 54 },
    bufferPages: true,
    info: {
      Title: xmlText(pulled.cover.name),
      Author: xmlText(source.company),
      Subject: xmlText(footer),
      Keywords: banner
        ? xmlText(["Draft, not final", ...banner.items].join(". "))
        : "internal closeout",
    },
  });
  const chunks: Buffer[] = [];
  const output = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk) => chunks.push(chunk as Buffer));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  doc.registerFont("body", path.resolve("assets/fonts/NotoSans-Regular.ttf"));
  doc.registerFont("bold", path.resolve("assets/fonts/NotoSans-Bold.ttf"));

  const width = 504;
  const left = 54;
  const bottom = 710;
  const fit = (height: number) => {
    if (doc.y + height > bottom) {
      doc.addPage();
      doc.y = 64;
    }
  };
  const text = (value: string, size = 10, bold = false, color = "#24364B") => {
    doc
      .font(bold ? "bold" : "body")
      .fontSize(size)
      .fillColor(color);
    doc.text(value, left, doc.y, { width, lineGap: 2 });
  };

  doc.rect(0, 0, 612, 12).fill("#193D59");
  doc.y = 36;
  if (banner) {
    const lines = [banner.title, ...banner.items.map((item) => `• ${item}`)];
    doc.font("body").fontSize(9);
    const inner = width - 20;
    const textHeight = lines.reduce(
      (sum, line, index) =>
        sum +
        doc
          .font(index === 0 ? "bold" : "body")
          .fontSize(index === 0 ? 11 : 9)
          .heightOfString(line, { width: inner, lineGap: 2 }) +
        3,
      8,
    );
    const y = doc.y;
    doc.save();
    doc.rect(left, y, width, textHeight).fill("#FFF6E8");
    doc.rect(left, y, 4, textHeight).fill("#B86E00");
    doc.restore();
    let cursor = y + 8;
    lines.forEach((line, index) => {
      doc
        .font(index === 0 ? "bold" : "body")
        .fontSize(index === 0 ? 11 : 9)
        .fillColor("#5C3B00")
        .text(line, left + 12, cursor, { width: inner, lineGap: 2 });
      cursor = doc.y + 2;
    });
    doc.y = y + textHeight + 12;
    doc.x = left;
  }
  text(source.company.toUpperCase(), 10, true);
  doc.moveDown(1.2);
  text("FINAL PROJECT REPORT", 11, true, "#687B89");
  doc.moveDown(0.6);
  text(pulled.cover.name, 26, true);
  doc.moveDown(0.5);
  text(formatReportDate(source.body.report_date), 12, false, "#687B89");
  doc.moveDown(1);
  const meta: Array<[string, string]> = [
    ["PROJECT", `${pulled.cover.project_number} · ${pulled.cover.name}`],
    ["CUSTOMER", pulled.cover.customer || "Not recorded"],
    ["SITE", pulled.cover.address || "Not recorded"],
    ["PROJECT MANAGER", pulled.cover.pm_name || "Unassigned"],
    ["STAGE", label(pulled.cover.stage)],
    ["REPORT DATE", formatReportDate(source.body.report_date)],
  ];
  for (let i = 0; i < meta.length; i += 2) {
    doc.font("body").fontSize(10);
    const pair = meta.slice(i, i + 2);
    const height =
      Math.max(
        ...pair.map(([, value]) =>
          doc.heightOfString(value, { width: 238, lineGap: 2 }),
        ),
      ) + 28;
    fit(height);
    const y = doc.y;
    pair.forEach(([key, value], column) => {
      const x = left + column * 266;
      doc
        .font("bold")
        .fontSize(8)
        .fillColor("#687B89")
        .text(key, x, y, { width: 238 });
      doc
        .font("body")
        .fontSize(10)
        .fillColor("#24364B")
        .text(value, x, y + 14, { width: 238, lineGap: 2 });
    });
    doc.y = y + height;
    doc.x = left;
  }

  const drawTable = (headers: string[], rows: string[][]) => {
    const columns = Math.max(headers.length, 1);
    const cellWidth = width / columns;
    const all = [headers, ...rows];
    const rowHeight = (row: string[]) => {
      doc.font("body").fontSize(9);
      return Math.max(
        26,
        ...row.map(
          (cell) =>
            doc.heightOfString(cell || "—", {
              width: cellWidth - 12,
              lineGap: 1,
            }) + 12,
        ),
      );
    };
    const drawRow = (row: string[], head: boolean) => {
      const height = rowHeight(row);
      if (height > bottom - 80) {
        for (let index = 0; index < row.length; index++) {
          fit(36);
          text(`${headers[index] ?? "Value"}: ${row[index] || "—"}`, 9, head);
        }
        return;
      }
      fit(height + 2);
      const y = doc.y;
      doc.rect(left, y, width, height).fill(head ? "#EAF0F5" : "#F7F9FB");
      row.forEach((cell, index) => {
        doc
          .font(head ? "bold" : "body")
          .fontSize(8)
          .fillColor("#24364B")
          .text(cell || "—", left + index * cellWidth + 6, y + 6, {
            width: cellWidth - 12,
            lineGap: 1,
          });
      });
      doc.y = y + height + 2;
      doc.x = left;
    };
    all.forEach((row, index) => {
      const padded = [...row];
      while (padded.length < columns) padded.push("");
      if (index && doc.y + rowHeight(padded) > bottom) {
        doc.addPage();
        doc.y = 64;
        drawRow(headers, true);
      }
      drawRow(padded, index === 0);
    });
    doc.moveDown(0.3);
  };

  for (const block of buildCloseoutReportBlocks(source)) {
    if (block.kind === "h1" || block.kind === "h2" || block.kind === "h3") {
      const size = block.kind === "h1" ? 16 : block.kind === "h2" ? 13 : 11;
      fit(size + 18);
      doc.moveDown(block.kind === "h1" ? 0.7 : 0.35);
      text(block.text, size, true);
      doc.moveDown(0.25);
    } else if (block.kind === "table") {
      drawTable(block.headers, block.rows);
    } else {
      fit(28);
      text(
        block.text,
        block.kind === "note" ? 8 : 10,
        false,
        block.kind === "note" ? "#687B89" : "#24364B",
      );
      doc.moveDown(0.25);
    }
  }

  const range = doc.bufferedPageRange();
  for (let index = 0; index < range.count; index++) {
    doc.switchToPage(index);
    doc.page.margins.bottom = 0;
    doc.moveTo(left, 744).lineTo(558, 744).strokeColor("#D8E1E8").stroke();
    doc.font("body").fontSize(8).fillColor("#687B89").text(footer, left, 754, {
      width: 420,
      lineBreak: false,
    });
    doc.text(`${index + 1} / ${range.count}`, 506, 754, {
      width: 52,
      align: "right",
      lineBreak: false,
    });
  }
  doc.end();
  return output;
}

export function pdfFileName(projectNumber: string): string {
  const safe =
    projectNumber
      .replace(/[^\w.\- ]+/g, "")
      .trim()
      .slice(0, 80) || "project";
  return `closeout-${safe}.pdf`;
}
