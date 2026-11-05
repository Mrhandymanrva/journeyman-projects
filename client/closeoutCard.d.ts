export function closeoutDoneCount(row: {
  punch_done_at?: string | null;
  photos_done_at?: string | null;
  final_draw_invoice_number?: string | null;
  warranty_start_on?: string | null;
  review_request_note?: string | null;
  punch_note?: string | null;
  photos_note?: string | null;
} | null | undefined): number;

export function closeoutDoneLabel(count: number): string;

export function closeoutSavePayload(fields: {
  punch_done: boolean;
  punch_note: string;
  photos_done: boolean;
  photos_note: string;
  final_draw_invoice_number: string | null;
  warranty_start_on: string | null;
  review_request_note: string;
}): {
  punch_done: boolean;
  punch_note: string;
  photos_done: boolean;
  photos_note: string;
  final_draw_invoice_number: string | null;
  warranty_start_on: string | null;
  review_request_note: string;
};

export function closeoutCardHtml(
  row: {
    punch_done_at?: string | null;
    punch_note?: string | null;
    photos_done_at?: string | null;
    photos_note?: string | null;
    final_draw_invoice_number?: string | null;
    warranty_start_on?: string | null;
    review_request_note?: string | null;
  } | null | undefined,
  helpers: { esc: (value: unknown) => string; canEdit: boolean },
): string;
