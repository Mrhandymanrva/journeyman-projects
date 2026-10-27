export function laborCardHtml(
  row: {
    hours?: number;
    uncoded_hours?: number;
    source?: string | null;
    hours_source?: string | null;
    observed_at?: string | null;
    labor_wage?: number;
    labor_burden?: number;
    total?: number;
    labor_source?: string | null;
    labor_label?: string | null;
    labor_warning?: string | null;
    commission_label?: string | null;
    burden_label?: string | null;
    billed_labor_plfe?: number | null;
    commission_plfe?: number | null;
    missing?: string[];
    rate_gaps?: Array<{ technician_name?: string; messages?: string[] }>;
    technicians?: Array<{
      technician_name?: string | null;
      hours?: number | string;
      hourly_rate?: number | null;
      burden_rate?: number | null;
      wage?: number | null;
      burden?: number | null;
      pay_basis?: string | null;
      burden_unset?: boolean;
      missing?: string[];
    }>;
    st_labor_code?: { code?: string; name?: string } | null;
    st_labor_code_error?: string | null;
    rates_forbidden?: boolean;
  } | null
    | undefined,
  helpers: {
    esc: (value: unknown) => string;
    stamp: (value: unknown) => string;
  },
): string;
