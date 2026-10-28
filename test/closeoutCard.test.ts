import { describe, expect, it } from "vitest";
import {
  closeoutCardHtml,
  closeoutDoneCount,
  closeoutDoneLabel,
  closeoutSavePayload,
} from "../client/closeoutCard.js";

const esc = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );

describe("closeout card", () => {
  it("counts finished items out of five", () => {
    expect(
      closeoutDoneCount({
        punch_done_at: "2026-10-01T00:00:00Z",
        photos_done_at: "2026-10-02T00:00:00Z",
        final_draw_invoice_number: "  ",
        warranty_start_on: null,
        review_request_note: "   ",
      }),
    ).toBe(2);
    expect(closeoutDoneLabel(2)).toBe("2 of 5");
    expect(
      closeoutDoneCount({
        punch_done_at: "2026-10-01T00:00:00Z",
        photos_done_at: "2026-10-02T00:00:00Z",
        final_draw_invoice_number: "1184",
        warranty_start_on: "2026-11-01",
        review_request_note: "Ask after the walkthrough",
      }),
    ).toBe(5);
  });

  it("saves the same payload the closeout card sent before the layout change", () => {
    expect(
      closeoutSavePayload({
        punch_done: true,
        punch_note: "  keep spaces  ",
        photos_done: false,
        photos_note: "",
        final_draw_invoice_number: "  1184  ",
        warranty_start_on: "",
        review_request_note: "Ask after the walkthrough",
      }),
    ).toEqual({
      punch_done: true,
      punch_note: "  keep spaces  ",
      photos_done: false,
      photos_note: "",
      final_draw_invoice_number: "1184",
      warranty_start_on: null,
      review_request_note: "Ask after the walkthrough",
    });
  });

  it("lays the checklist out as one row per item with Save at the end", () => {
    const html = closeoutCardHtml(
      {
        punch_done_at: "2026-10-01T00:00:00Z",
        punch_note: "Tile edge",
        photos_done_at: "2026-10-02T00:00:00Z",
        photos_note: "Filed",
      },
      { esc, canEdit: true },
    );
    expect(html).toContain('data-done="2 of 5"');
    expect(html).toContain("form-row");
    expect(html).toContain("Punch list complete");
    expect(html).toContain("Final photos filed");
    expect(html).toContain("Final draw invoice #");
    expect(html).toContain("Warranty start");
    expect(html).toContain("Review request");
    expect(html).toContain('id="cl-punch"');
    expect(html).toContain('id="cl-save"');
    expect(html).toContain("form-actions");
    expect(html).toContain("Nothing here emails the customer");
    expect(html).toContain("Nobody is emailed.");
    expect(html.indexOf("Punch list complete")).toBeLessThan(html.indexOf('id="cl-punch-note"'));
    expect(html.indexOf("Review request")).toBeLessThan(html.indexOf('id="cl-save"'));
  });
});
