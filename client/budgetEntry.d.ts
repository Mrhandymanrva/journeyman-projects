export function formatBudgetMoney(value: number | null | undefined): string;

export function budgetEntryTotal(fields: {
  labor?: number | string | null;
  materials?: number | string | null;
  subcontractor?: number | string | null;
  other?: number | string | null;
} | null | undefined): number | null;

export function budgetEntryMargin(fields: {
  contract_value?: number | string | null;
  labor?: number | string | null;
  materials?: number | string | null;
  subcontractor?: number | string | null;
  other?: number | string | null;
} | null | undefined): { amount: number | null; percent: number | null };

export function formatBudgetMargin(
  margin: { amount: number | null; percent: number | null } | null | undefined,
): string;

export function refreshBudgetEntryFigures(root?: {
  getElementById(id: string): {
    value?: string;
    textContent?: string | null;
    classList?: { toggle(token: string, force?: boolean): void };
  } | null;
} | null): void;

export function bindBudgetEntryFigures(root?: {
  getElementById(id: string): {
    dataset?: { marginBound?: string };
    addEventListener(type: string, listener: () => void): void;
  } | null;
} | null): void;

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

export type SoldEstimateFigures = {
  contractValue?: number | null;
  totalBudgetedExpense?: number | null;
  budgetedLaborExpense?: number | null;
  budgetedLaborHours?: number | null;
  budgetedMaterials?: number | null;
};

export function budgetFormEditable(input: {
  canEdit: boolean;
  frozen: boolean;
  entered: boolean;
}): boolean;

export function soldEstimateHasFigures(sold: SoldEstimateFigures | null | undefined): boolean;

export function budgetEntryHtml(
  entry: {
    contract_value?: number | null;
    labor?: number | null;
    labor_hours?: number | null;
    materials?: number | null;
    subcontractor?: number | null;
    other?: number | null;
  } | null | undefined,
  options?: { editable?: boolean; frozen?: boolean; soldEstimate?: SoldEstimateFigures | null },
): string;

export function applySoldEstimateFromButton(button: {
  dataset?: { contract?: string; labor?: string; hours?: string; materials?: string };
  ownerDocument?: {
    getElementById(id: string): {
      disabled?: boolean;
      readOnly?: boolean;
      value?: string;
      dispatchEvent?: (event: unknown) => void;
    } | null;
    defaultView?: { Event?: new (type: string, init?: { bubbles?: boolean }) => unknown } | null;
  } | null;
} | null): void;

export function bindSoldEstimateButton(root?: {
  querySelector?(selector: string): {
    dataset: { bound?: string };
    addEventListener(type: string, listener: (event: { preventDefault(): void }) => void): void;
  } | null;
  getElementById?(id: string): {
    dataset: { bound?: string };
    addEventListener(type: string, listener: (event: { preventDefault(): void }) => void): void;
  } | null;
} | null): void;
