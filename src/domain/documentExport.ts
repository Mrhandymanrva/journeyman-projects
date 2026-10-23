import PDFDocument from "pdfkit";
import path from "node:path";
import type { ControlRecord } from "./projectControls.js";

export type DocumentBlock = {
  kind: "heading" | "paragraph" | "item" | "table";
  text: string;
  level?: number;
  rows?: string[][];
};
const clean = (s: unknown) =>
  String(s ?? "")
    .replace(/\r/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
export const escapeHtml = (s: unknown) =>
  clean(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const plain = (s: string) =>
  s.replace(/\*\*(.*?)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1");
const pretty = (s: string) => s.replaceAll("_", " ");
export function documentBlocks(content: string): DocumentBlock[] {
  const lines = clean(content).split("\n"),
    blocks: DocumentBlock[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length)
      blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) {
      flush();
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({
        kind: "heading",
        level: heading[1]!.length,
        text: heading[2]!,
      });
      continue;
    }
    if (line.includes("|") && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? "")) {
      flush();
      const cells = (s: string) =>
        s
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((x) => x.trim());
      const rows = [cells(line)];
      i++;
      while (lines[i + 1]?.includes("|")) rows.push(cells(lines[++i]!));
      blocks.push({ kind: "table", text: "", rows });
      continue;
    }
    if (/^([-*]|\d+[.)])\s/.test(line)) {
      flush();
      blocks.push({
        kind: "item",
        text: line
          .replace(/^[-*]\s+/, "• ")
          .replace(/• \[ \]/, "[ ]")
          .replace(/• \[[xX]\]/, "[x]"),
      });
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
}
export function recordContent(record: ControlRecord) {
  if (record.kind === "document")
    return clean(record.data.content || record.data.description);
  return Object.entries(record.data)
    .filter(
      ([key, value]) =>
        !["title", "owner_id"].includes(key) && value !== null && value !== "",
    )
    .map(
      ([key, value]) =>
        `## ${pretty(key)}\n\n${
          Array.isArray(value)
            ? value
                .map((v) =>
                  typeof v === "object"
                    ? Object.entries(v)
                        .map(([k, n]) => `${pretty(k)}: ${n}`)
                        .join(" · ")
                    : String(v),
                )
                .join("\n")
            : typeof value === "object"
              ? JSON.stringify(value)
              : String(value)
        }`,
    )
    .join("\n\n");
}
export interface ExportModel {
  title: string;
  project: string;
  number: string;
  address: string;
  company: string;
  revision: number;
  updated: string;
  owner: string;
  category: string;
  content: string;
}
function contentBlocks(m: ExportModel) {
  const blocks = documentBlocks(
    m.content ||
      "No written content. The original attachment is a separate file.",
  );
  if (
    blocks[0]?.kind === "heading" &&
    blocks[0].level === 1 &&
    blocks[0].text.toLowerCase() === m.title.toLowerCase()
  )
    blocks.shift();
  return blocks;
}
export function documentHtml(m: ExportModel) {
  const e = escapeHtml;
  const body = contentBlocks(m)
    .map((b) =>
      b.kind === "heading"
        ? `<h${Math.min(3, (b.level ?? 2) + 1)}>${e(b.text)}</h${Math.min(3, (b.level ?? 2) + 1)}>`
        : b.kind === "table"
          ? `<div class="document-table"><table>${b.rows!.map((row, i) => `<tr>${row.map((cell) => `<${i ? "td" : "th"}>${e(plain(cell))}</${i ? "td" : "th"}>`).join("")}</tr>`).join("")}</table></div>`
          : `<p class="${b.kind === "item" ? "document-item" : ""}">${e(b.text)
              .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
              .replace(/`([^`]+)`/g, "<code>$1</code>")
              .replaceAll("\n", "<br>")}</p>`,
    )
    .join("");
  return `<article class="document-page"><header class="document-brand"><strong>${e(m.company)}</strong><span>PROJECT RECORD</span></header><p class="document-eyebrow">${e(m.category)} · Revision ${m.revision}</p><h1>${e(m.title)}</h1><dl class="document-meta"><div><dt>Project</dt><dd>${e(m.number)} · ${e(m.project)}</dd></div><div><dt>Site</dt><dd>${e(m.address || "Not recorded")}</dd></div><div><dt>Record owner</dt><dd>${e(m.owner || "Unassigned")}</dd></div><div><dt>Last revised</dt><dd>${e(m.updated)}</dd></div></dl><div class="document-body">${body || "<p>No written content. Download the original attachment for this record.</p>"}</div><footer>Working record · Approvals are recorded separately · ${e(m.number)}</footer></article>`;
}
export async function renderDocumentPdf(m: ExportModel): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: 56, bottom: 58, left: 54, right: 54 },
    bufferPages: true,
    info: {
      Title: m.title,
      Author: m.company,
      Subject: `${m.number} · revision ${m.revision}`,
    },
  });
  const chunks: Buffer[] = [];
  const output = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  doc.registerFont("body", path.resolve("assets/fonts/NotoSans-Regular.ttf"));
  doc.registerFont("bold", path.resolve("assets/fonts/NotoSans-Bold.ttf"));
  const width = 504,
    bottom = 724;
  const fit = (height: number) => {
    if (doc.y + height > bottom) {
      doc.addPage();
      doc.y = 64;
    }
  };
  const text = (s: string, size = 10, bold = false, color = "#24364B") => {
    doc
      .font(bold ? "bold" : "body")
      .fontSize(size)
      .fillColor(color);
    doc.text(plain(s), 54, doc.y, { width, lineGap: 2 });
  };
  doc.rect(0, 0, 612, 12).fill("#193D59");
  doc.y = 38;
  text(m.company.toUpperCase(), 10, true);
  doc.moveDown(1.8);
  text(
    `${m.category.toUpperCase()}   /   REVISION ${m.revision}`,
    9,
    true,
    "#687B89",
  );
  doc.moveDown(0.6);
  text(m.title, 25, true);
  doc.moveDown(0.8);
  const meta = [
    ["PROJECT", `${m.number} · ${m.project}`],
    ["SITE", m.address || "Not recorded"],
    ["RECORD OWNER", m.owner || "Unassigned"],
    ["LAST REVISED", m.updated],
  ];
  for (let i = 0; i < meta.length; i += 2) {
    doc.font("body").fontSize(10);
    const height =
      Math.max(
        ...meta
          .slice(i, i + 2)
          .map(([, value]) =>
            doc.heightOfString(value!, { width: 238, lineGap: 3 }),
          ),
      ) + 28;
    fit(height);
    const y = doc.y;
    meta.slice(i, i + 2).forEach(([key, value], column) => {
      const x = 54 + column * 266;
      doc
        .font("bold")
        .fontSize(8)
        .fillColor("#687B89")
        .text(key!, x, y, { width: 238 });
      doc
        .font("body")
        .fontSize(10)
        .fillColor("#24364B")
        .text(value!, x, y + 15, { width: 238, lineGap: 3 });
    });
    doc.y = y + height;
    doc.x = 54;
  }
  doc.moveDown(0.6);
  doc.moveTo(54, doc.y).lineTo(558, doc.y).strokeColor("#D8E1E8").stroke();
  doc.moveDown(1);
  for (const b of contentBlocks(m)) {
    if (b.kind === "heading") {
      fit(85);
      doc.moveDown(0.45);
      text(b.text, b.level === 1 ? 17 : 12, true);
      doc.moveDown(0.4);
    } else if (b.kind === "table") {
      const columns = Math.max(...b.rows!.map((r) => r.length));
      // Wide tables become labeled rows rather than unreadable tiny columns.
      if (columns > 5) {
        for (const row of b.rows!.slice(1))
          for (let i = 0; i < row.length; i++) {
            fit(45);
            text(`${b.rows![0]![i] ?? "Value"}: ${row[i]}`);
          }
        continue;
      }
      const cellWidth = width / columns;
      const rowHeight = (row: string[]) => {
        doc.font("body").fontSize(9);
        return Math.max(
          28,
          ...row.map(
            (c) =>
              doc.heightOfString(plain(c), {
                width: cellWidth - 16,
                lineGap: 2,
              }) + 16,
          ),
        );
      };
      const drawRow = (row: string[], head: boolean) => {
        const height = rowHeight(row);
        if (height > bottom - 64) {
          for (let j = 0; j < row.length; j++) {
            fit(45);
            text(`${b.rows![0]![j] ?? "Value"}: ${row[j]}`);
          }
          return;
        }
        fit(height);
        const y = doc.y;
        doc.rect(54, y, width, height).fill(head ? "#EAF0F5" : "#F7F9FB");
        row.forEach((cell, i) => {
          doc
            .font(head ? "bold" : "body")
            .fontSize(9)
            .fillColor("#24364B")
            .text(plain(cell), 54 + i * cellWidth + 8, y + 8, {
              width: cellWidth - 16,
              lineGap: 2,
            });
        });
        doc.y = y + height + 2;
        doc.x = 54;
      };
      b.rows!.forEach((row, i) => {
        if (i && doc.y + rowHeight(row) > bottom) {
          doc.addPage();
          doc.y = 64;
          drawRow(b.rows![0]!, true);
        }
        drawRow(row, i === 0);
      });
      doc.moveDown(0.4);
    } else {
      fit(35);
      text(b.text);
      doc.moveDown(b.kind === 'item' ? 0.15 : 0.4);
    }
  }
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0;
    if (i) {
      doc
        .font("bold")
        .fontSize(8)
        .fillColor("#687B89")
        .text(`${m.number} / ${m.title}`, 54, 27, {
          width: 504,
          height: 15,
          ellipsis: true,
        });
    }
    doc.moveTo(54, 744).lineTo(558, 744).strokeColor("#D8E1E8").stroke();
    doc
      .font("body")
      .fontSize(8)
      .fillColor("#687B89")
      .text(
        `Revision ${m.revision} · Working record; approvals recorded separately`,
        54,
        754,
        { width: 420, lineBreak: false },
      );
    doc.text(`${i + 1} / ${range.count}`, 506, 754, {
      width: 52,
      align: "right",
      lineBreak: false,
    });
  }
  doc.end();
  return output;
}
