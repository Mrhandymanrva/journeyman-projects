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
  delete_project: ['owner'],
  manage_project_controls: ['owner','manager','project_manager'],
  manage_project_documents: ['owner','manager','project_manager','office'],
  manage_project_reserves: ['owner','manager'],
  manage_users: ['owner'],
  create_project: ['owner', 'manager', 'office'],
  edit_budget_before_freeze: ['owner', 'manager', 'project_manager'],
  issue_purchase_order: ['owner', 'manager', 'project_manager'],
  approve_vendor_bill: ['owner', 'manager', 'bookkeeper'],
  // Matching a card charge is not approving a subcontract bill. A project
  // manager records the material order and later links the QuickBooks charge.
  link_material_purchase: ['owner', 'manager', 'bookkeeper', 'project_manager'],
  manage_company_settings: ['owner', 'manager'],
  approve_draw: ['owner', 'manager'],
  record_external_invoice: ['owner', 'manager', 'office'],
  send_change_order: ['owner', 'manager', 'project_manager'],
  approve_change_order_over_threshold: ['owner', 'manager'],
  manage_vendors: ['owner', 'manager', 'office'],
  write_daily_log: ['owner', 'manager', 'project_manager'],
  view_margin: ['owner', 'manager', 'project_manager', 'estimator', 'bookkeeper'],
  export_cost_data: ['owner', 'manager', 'estimator', 'bookkeeper'],
  advance_stage: ['owner', 'manager', 'project_manager'],
  // A flag that field capacity was confirmed. It does not block scheduling,
  // gates, or any other write. Owner and manager may set or clear it.
  // There is no Office GM or Project Coordinator role: manager is the
  // leadership seat next to owner, and office is the view-only office seat.
  record_field_release: ['owner', 'manager'],
  // Preconstruction checklist. Project Coordinator is project_manager.
  // Estimator, office, and bookkeeper can read tasks and cannot edit them.
  manage_precon_tasks: ['owner', 'manager', 'project_manager'],
  // Recompute field start from ServiceTitan appointments. The call is a read.
  // A manual field start is left as it is.
  refresh_field_start: ['owner', 'manager', 'project_manager'],
  // Set or clear a manual field start. Clearing does not recompute it.
  set_field_start: ['owner', 'manager'],
  // Permit office directory. Project Coordinator is project_manager.
  // Office can read the directory and cannot create or import offices.
  manage_permit_offices: ['owner', 'manager', 'project_manager'],
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
