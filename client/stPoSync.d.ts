export function stPoSyncHtml(state: {
  loading?: boolean;
  error?: string;
  orders?: Array<Record<string, unknown>>;
  writesEnabled?: boolean;
}): string;

export function stPoPreviewMarkup(data: {
  po_number?: string;
  st_po_id?: string | null;
  writes_enabled?: boolean;
  sku_note?: string;
  plan?: { missing?: string[]; payload?: unknown };
  fields?: Array<{ key: string; label: string; suggested?: string | null; options?: Array<{ id: string; label: string }>; lookup_error?: string | null }>;
  lines?: Array<{
    line_id?: string | null;
    description?: string;
    amount?: number;
    needs_sku?: boolean;
    options?: Array<{ id: string; label: string }>;
    lookup_error?: string | null;
  }>;
}): string;

export function bindStPoSync(
  host: { addEventListener: (type: string, listener: (event: Event) => void) => void; querySelector: (selector: string) => any },
  actions: {
    onPreview: (poId: string) => Promise<any>;
    onSave: (poId: string, choices: unknown) => Promise<unknown>;
    onSearchSkus?: (poId: string, query: string) => Promise<{ skus?: Array<{ id: string; label: string }> }>;
    onConfirm: (poId: string, choices: unknown) => Promise<any>;
  },
): void;
