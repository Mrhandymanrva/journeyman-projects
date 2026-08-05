import { ApiError } from './errors.js';

export type StaffRole =
  | 'owner'
  | 'manager'
  | 'project_manager'
  | 'estimator'
  | 'office'
  | 'bookkeeper';

/**
 * API Contract §2.1, transcribed. One table, no per-handler role literals —
 * a capability check scattered across twenty handlers is a capability check
 * that disagrees with itself within a quarter.
 *
 * `approve_gate` is absent on purpose. The gate approver is not a fixed role:
 * it comes from gate_templates.approver_role for that tenant and gate number,
 * so it is resolved against the row at approval time. Owner is always allowed.
 */
export const CAPABILITIES = {
  create_project: ['owner', 'manager', 'office'],
  edit_budget_before_freeze: ['owner', 'manager', 'project_manager'],
  issue_purchase_order: ['owner', 'manager', 'project_manager'],
  approve_vendor_bill: ['owner', 'manager', 'bookkeeper'],
  approve_draw: ['owner', 'manager'],
  record_external_invoice: ['owner', 'manager', 'office'],
  send_change_order: ['owner', 'manager', 'project_manager'],
  approve_change_order_over_threshold: ['owner', 'manager'],
  manage_vendors: ['owner', 'manager', 'office'],
  write_daily_log: ['owner', 'manager', 'project_manager'],
  view_margin: ['owner', 'manager', 'project_manager', 'estimator', 'bookkeeper'],
  export_cost_data: ['owner', 'manager', 'estimator', 'bookkeeper'],
  advance_stage: ['owner', 'manager', 'project_manager'],
} as const satisfies Record<string, readonly StaffRole[]>;

export type Capability = keyof typeof CAPABILITIES;

export function can(role: StaffRole, capability: Capability): boolean {
  return (CAPABILITIES[capability] as readonly StaffRole[]).includes(role);
}

export function requireCapability(role: StaffRole, capability: Capability): void {
  if (!can(role, capability)) {
    throw new ApiError('forbidden', `Your role (${role}) cannot ${describe(capability)}.`, {
      capability,
      role,
    });
  }
}

function describe(capability: Capability): string {
  return capability.replace(/_/g, ' ');
}

/**
 * §2.2. Business unit scoping is a visibility preference inside one tenant,
 * not a boundary between tenants, so it is applied here rather than in RLS —
 * putting it in RLS makes cross-unit reporting for an owner needlessly hard.
 *
 * Returns the unit a staff member is confined to, or null for "sees all".
 */
export function unitFilter(
  staffBusinessUnitId: string | null,
  enforceBusinessUnitScoping: boolean,
): string | null {
  if (!enforceBusinessUnitScoping) return null;
  return staffBusinessUnitId ?? null;
}
