export function formatBudgetMoney(value: number | null | undefined): string;

export function budgetEntryTotal(fields: {
  labor?: number | string | null;
  materials?: number | string | null;
  subcontractor?: number | string | null;
  other?: number | string | null;
} | null | undefined): number | null;

export function budgetEntryPayload(fields: {
  contract_value?: number | string | null;
  labor?: number | string | null;
  labor_hours?: number | string | null;
  materials?: number | string | null;
  subcontractor?: number | string | null;
  other?: number | string | null;
} | null | undefined): { error: string } | {
  body: {
    contract_value: number | null;
    labor: number | null;
    labor_hours: number | null;
    materials: number | null;
    subcontractor: number | null;
    other: number | null;
  };
};

export function budgetEntryHtml(
  entry: {
    contract_value?: number | null;
    labor?: number | null;
    labor_hours?: number | null;
    materials?: number | null;
    subcontractor?: number | null;
    other?: number | null;
  } | null | undefined,
  options?: { editable?: boolean; frozen?: boolean },
): string;
