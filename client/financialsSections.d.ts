export function budgetSummary(
  cost: Array<{ baseline?: number | null }> | null | undefined,
  entry?: { entered?: boolean } | null,
): string;
export function purchaseOrderSummary(
  orders: Array<{ amount?: number | null }> | null | undefined,
): string;
export function changeOrderSummary(
  data:
    | { change_orders?: Array<{ customer_amount?: number | null }> }
    | Array<{ customer_amount?: number | null }>
    | null
    | undefined,
): string;
export function drawSummary(
  drawData: { draws?: Array<{ amount?: number | null }> } | null | undefined,
): string;
export function laborSummary(
  row:
    | { hours?: number | null; total?: number | null; labor_burden?: number | null }
    | null
    | undefined,
): string;
export function stDetailSummary(
  money:
    | {
        observed_at?: string | null;
        billed?: number | null;
        expenses?: number | null;
        margin?: number | null;
        materials_expense_read?: boolean;
      }
    | null
    | undefined,
): string;
export function billsSummary(
  bills: Array<{ status?: string; amount?: number | string | null }> | null | undefined,
): string;
export function reservesSummary(
  rows:
    | Array<{ active?: boolean; data?: { allocated?: number; drawn?: number } }>
    | null
    | undefined,
): string;
export function collapsedCard(input: {
  id: string;
  title: string;
  summary: string;
  actions?: string;
  body: string;
}): string;
export function nextSectionExpanded(expanded: boolean | string): boolean;
type SectionButton = {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
};
type SectionRoot = {
  dataset: { finSectionsBound?: string };
  contains(node: unknown): boolean;
  addEventListener(
    type: string,
    listener: (event: {
      target?: { closest?: (selector: string) => SectionButton | null } | null;
    }) => void,
  ): void;
};
export function setSectionExpanded(button: SectionButton | null, expanded: boolean): void;
export function bindFinancialSections(root: SectionRoot | null): void;

type BudgetDomNode = {
  id?: string;
  hidden?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  parentElement?: BudgetDomNode | null;
  focus?: (options?: { preventScroll?: boolean }) => void;
  scrollIntoView?: (options?: { block?: string; inline?: string }) => void;
};
type BudgetDocument = {
  documentElement?: { dataset: { enterBudgetBound?: string } } | null;
  activeElement?: BudgetDomNode | null;
  contains?: (node: unknown) => boolean;
  getElementById(id: string): BudgetDomNode | null;
  querySelector(selector: string): SectionButton | null;
  addEventListener?: (
    type: string,
    listener: (event: {
      target?: { closest?: (selector: string) => unknown } | null;
    }) => void,
  ) => void;
};
export function openBudgetEntry(doc?: BudgetDocument): boolean;
export function bindEnterBudget(doc?: BudgetDocument): void;
