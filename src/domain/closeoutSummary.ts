/**
 * Final project report stored on project_closeout.summary.
 *
 * Pulled figures are a snapshot taken when the report is saved or finalized.
 * A later budget change does not rewrite a saved report. The live risk
 * register, communication plan, and milestone plan are not updated from here.
 * Nothing in this module emails the customer or writes to ServiceTitan.
 */

import { z } from "zod";
import type { SqlClient } from "../db/database.js";
import { readFinancialsDashboard } from "./financialsDashboardStore.js";
import { roundMoney } from "./projectFinancials.js";

const text = z.string().trim().max(20000);
const day = z.string().date();

const roleSchema = z
  .object({
    name: z.string().trim().max(200),
    role: z.string().trim().max(200),
    responsibilities: z.string().trim().max(2000),
    source: z.string().trim().max(40).optional(),
  })
  .strict();

const riskSchema = z
  .object({
    description: z.string().trim().max(2000),
    impact: z.number().int().min(1).max(5).nullable(),
    probability: z.number().int().min(1).max(5).nullable(),
    mitigation: z.string().trim().max(4000),
    roam: z.string().trim().max(40).optional(),
  })
  .strict();

const communicationSchema = z
  .object({
    audience: z.string().trim().max(1000),
    channel: z.string().trim().max(80),
    cadence: z.string().trim().max(80),
    notes: z.string().trim().max(4000),
  })
  .strict();

const outcomeSchema = z
  .object({
    name: z.string().trim().max(200),
    detail: z.string().trim().max(4000),
  })
  .strict();

const eventSchema = z
  .object({
    title: z.string().trim().max(200),
    due_on: day.nullable(),
    completed_on: day.nullable(),
    state: z.string().trim().max(40),
    note: z.string().trim().max(2000),
  })
  .strict();

const narrativeSchema = z
  .object({
    scope: text,
    schedule_commentary: text,
    cost_commentary: text,
    lessons_learned: text,
    learning_outcomes_summary: text,
    performance_summary: text,
    critical_thinking: text,
  })
  .strict();

const postMortemSchema = z
  .object({
    initial_expectations: text,
    milestones: z.array(eventSchema).max(80),
    achievements_obstacles: text,
    roadblocks: text,
    additional_resources: text,
    root_causes: text,
    key_takeaways: text,
    action_items: text,
    next_steps: text,
  })
  .strict();

const money = z.number().finite().nullable();
const countTotal = z
  .object({
    count: z.number().int().nonnegative(),
    total: z.number().finite(),
  })
  .strict();

export const costSnapshotSchema = z
  .object({
    contract_value: money,
    budgeted_expense: money,
    actual_expense: money,
    labor_actual: money,
    materials_actual: money,
    subcontractor_actual: money,
    budgeted_labor: money,
    budgeted_materials: money,
    budgeted_subcontractor: money,
    budgeted_margin: money,
    budgeted_margin_percent: money,
    actual_margin: money,
    actual_margin_percent: money,
    committed_open: money,
    total_committed: money,
    variance: money,
    approved_change_orders: z.number().finite(),
    purchase_orders: countTotal,
    vendor_bills: countTotal,
  })
  .strict();

const taskSchema = z
  .object({
    title: z.string(),
    start_on: z.string().nullable(),
    due_on: z.string().nullable(),
    completed_on: z.string().nullable(),
    state: z.string(),
  })
  .strict();

const milestoneSchema = z
  .object({
    title: z.string(),
    due_on: z.string().nullable(),
    completed_on: z.string().nullable(),
    state: z.string(),
  })
  .strict();

const scheduleItemSchema = z
  .object({
    title: z.string(),
    window_start: z.string().nullable(),
    window_end: z.string().nullable(),
    status: z.string(),
    assigned_to: z.string().nullable(),
  })
  .strict();

export const pulledSnapshotSchema = z
  .object({
    pulled_at: z.string(),
    currency: z.string().length(3),
    cover: z
      .object({
        name: z.string(),
        project_number: z.string(),
        address: z.string(),
        customer: z.string().nullable(),
        stage: z.string(),
        pm_name: z.string().nullable(),
      })
      .strict(),
    scope: z
      .object({
        summary: z.string().nullable(),
        charter_documents: z.array(z.string()),
      })
      .strict(),
    schedule: z
      .object({
        scheduled_start: z.string().nullable(),
        scheduled_end: z.string().nullable(),
        field_start: z.string().nullable(),
        actual_start: z.string().nullable(),
        actual_end: z.string().nullable(),
        plan_baseline_start: z.string().nullable(),
        plan_baseline_finish: z.string().nullable(),
        milestones: z.array(milestoneSchema),
        tasks: z.array(taskSchema),
        items: z.array(scheduleItemSchema),
      })
      .strict(),
    costs: costSnapshotSchema.nullable(),
    risks: z.array(riskSchema),
    communications: z.array(communicationSchema),
    suggested_roles: z.array(roleSchema),
    closeout: z
      .object({
        punch_done: z.boolean(),
        punch_note: z.string().nullable(),
        photos_done: z.boolean(),
        photos_note: z.string().nullable(),
        final_draw_invoice_number: z.string().nullable(),
        warranty_start_on: z.string().nullable(),
        review_request_note: z.string().nullable(),
        photo_document_count: z.number().int().nonnegative(),
        closeout_document_count: z.number().int().nonnegative(),
        gate_4_status: z.string().nullable(),
      })
      .strict(),
    daily_logs: z
      .object({
        count: z.number().int().nonnegative(),
        first_on: z.string().nullable(),
        last_on: z.string().nullable(),
      })
      .strict(),
  })
  .strict();

export const closeoutSummaryBodySchema = z
  .object({
    version: z.literal(1).default(1),
    report_date: day,
    roles: z.array(roleSchema).max(40),
    narrative: narrativeSchema,
    risks: z.array(riskSchema).max(40),
    communications: z.array(communicationSchema).max(40),
    learning_outcomes: z.array(outcomeSchema).max(20),
    post_mortem: postMortemSchema,
  })
  .strict();

export const savedSummarySchema = closeoutSummaryBodySchema.extend({
  pulled_snapshot: pulledSnapshotSchema.nullable(),
});

export type CloseoutSummaryBody = z.infer<typeof closeoutSummaryBodySchema>;
export type SavedCloseoutSummary = z.infer<typeof savedSummarySchema>;
export type PulledSnapshot = z.infer<typeof pulledSnapshotSchema>;
export type CostSnapshot = z.infer<typeof costSnapshotSchema>;

export const FINAL_REQUIRED: Array<{
  path: string;
  label: string;
  read: (body: CloseoutSummaryBody) => string;
}> = [
  {
    path: "narrative.lessons_learned",
    label: "Lessons learned",
    read: (body) => body.narrative.lessons_learned,
  },
  {
    path: "post_mortem.achievements_obstacles",
    label: "Achievements and obstacles",
    read: (body) => body.post_mortem.achievements_obstacles,
  },
  {
    path: "post_mortem.root_causes",
    label: "Root causes",
    read: (body) => body.post_mortem.root_causes,
  },
  {
    path: "post_mortem.key_takeaways",
    label: "Key takeaways",
    read: (body) => body.post_mortem.key_takeaways,
  },
  {
    path: "post_mortem.action_items",
    label: "Action items",
    read: (body) => body.post_mortem.action_items,
  },
  {
    path: "post_mortem.next_steps",
    label: "Next steps",
    read: (body) => body.post_mortem.next_steps,
  },
];

/** Learning outcomes and critical thinking stay optional. */
export function missingFinalFields(
  body: CloseoutSummaryBody,
): Record<string, string> {
  const missing: Record<string, string> = {};
  for (const field of FINAL_REQUIRED) {
    if (!field.read(body).trim()) {
      missing[field.path] =
        `Write ${field.label.toLowerCase()} before finalizing.`;
    }
  }
  return missing;
}

export function todayEt(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function formatStampEt(
  value: Date | string | null | undefined,
): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  return `${formatted} ET`;
}

/**
 * The form opens at closeout or complete, or once Gate 4 has started
 * (status other than open, or any Gate 4 checklist item ticked).
 */
export function closeoutReportAvailable(input: {
  stage: string;
  gate4Status: string | null;
  gate4Progress: boolean;
}): boolean {
  if (input.stage === "closeout" || input.stage === "complete") return true;
  if (input.gate4Status != null && input.gate4Status !== "open") return true;
  return input.gate4Progress;
}

export function tidySummary(body: CloseoutSummaryBody): CloseoutSummaryBody {
  return {
    ...body,
    version: 1,
    roles: body.roles.filter(
      (row) => row.name || row.role || row.responsibilities,
    ),
    risks: body.risks.filter(
      (row) =>
        row.description ||
        row.mitigation ||
        row.impact != null ||
        row.probability != null,
    ),
    communications: body.communications.filter(
      (row) => row.audience || row.channel || row.cadence || row.notes,
    ),
    learning_outcomes: body.learning_outcomes.filter(
      (row) => row.name || row.detail,
    ),
    post_mortem: {
      ...body.post_mortem,
      milestones: body.post_mortem.milestones.filter(
        (row) => row.title || row.note || row.due_on || row.completed_on,
      ),
    },
  };
}

/** Office staff can read the narrative. Cost and margin stay off the payload. */
export function redactCosts<T extends { costs: CostSnapshot | null }>(
  pulled: T,
  canViewCosts: boolean,
): T {
  if (canViewCosts) return pulled;
  return { ...pulled, costs: null };
}

export function presentSavedSummary(
  summary: SavedCloseoutSummary | null,
  canViewCosts: boolean,
): SavedCloseoutSummary | null {
  if (!summary || canViewCosts) return summary;
  return {
    ...summary,
    narrative: { ...summary.narrative, cost_commentary: "" },
    pulled_snapshot: summary.pulled_snapshot
      ? redactCosts(summary.pulled_snapshot, false)
      : null,
  };
}

function calendarDay(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const textValue = String(value);
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(textValue);
  return match ? match[1]! : null;
}

function asNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? roundMoney(parsed) : null;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function checklistStarted(checklist: unknown): boolean {
  if (!Array.isArray(checklist)) return false;
  return checklist.some(
    (item) =>
      !!item &&
      typeof item === "object" &&
      (item as { done?: unknown }).done === true,
  );
}

function addressOf(row: {
  address_line1: string;
  city: string;
  region: string;
  postal_code: string | null;
}): string {
  return [row.address_line1, row.city, row.region, row.postal_code]
    .filter(Boolean)
    .join(", ");
}

function riskDescription(data: Record<string, unknown>): string {
  const title = asText(data.title);
  const description = asText(data.description);
  if (title && description && title !== description)
    return `${title}: ${description}`;
  return title || description;
}

interface ControlRow {
  kind: string;
  data: Record<string, unknown>;
}

export interface CloseoutPull {
  available: boolean;
  stage: string;
  gate_4_status: string | null;
  pulled: PulledSnapshot;
}

export async function pullCloseoutSummary(
  db: SqlClient,
  projectId: string,
): Promise<CloseoutPull> {
  const project = await db.query<{
    name: string;
    project_number: string;
    address_line1: string;
    city: string;
    region: string;
    postal_code: string | null;
    source_customer_name: string | null;
    source_project_summary: string | null;
    stage: string;
    currency: string;
    scheduled_start: unknown;
    scheduled_end: unknown;
    field_start: unknown;
    actual_start: unknown;
    actual_end: unknown;
    pm_name: string | null;
    estimator_name: string | null;
  }>(
    `SELECT p.name, p.project_number, p.address_line1, p.city, p.region, p.postal_code,
            p.source_customer_name, p.source_project_summary, p.stage::text AS stage,
            p.currency, p.scheduled_start, p.scheduled_end, p.field_start,
            p.actual_start, p.actual_end,
            pm.full_name AS pm_name, est.full_name AS estimator_name
       FROM projects.projects p
       LEFT JOIN projects.staff pm ON pm.id = p.pm_id
       LEFT JOIN projects.staff est ON est.id = p.estimator_id
      WHERE p.id = $1`,
    [projectId],
  );
  const row = project.rows[0];
  if (!row)
    throw new Error("Project disappeared before the closeout report was read.");

  const gate = await db.query<{ status: string; checklist: unknown }>(
    `SELECT status::text AS status, checklist
       FROM projects.stage_gates
      WHERE project_id = $1 AND gate_number = 4`,
    [projectId],
  );
  const gateRow = gate.rows[0];
  const gateStatus = gateRow?.status ?? null;
  const gateProgress = checklistStarted(gateRow?.checklist);
  const available = closeoutReportAvailable({
    stage: row.stage,
    gate4Status: gateStatus,
    gate4Progress: gateProgress,
  });

  const controls = await db.query<ControlRow>(
    `SELECT kind, data
       FROM projects.project_controls
      WHERE project_id = $1
        AND active
        AND kind IN ('milestone', 'risk', 'communication', 'document', 'task')
      ORDER BY created_at, id`,
    [projectId],
  );

  const baseline = await db.query<{ start_on: unknown; finish_on: unknown }>(
    `SELECT start_on, finish_on
       FROM projects.project_control_baselines
      WHERE project_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [projectId],
  );

  const scheduleItems = await db.query<{
    title: string;
    window_start: unknown;
    window_end: unknown;
    status: string;
    vendor_name: string | null;
    staff_name: string | null;
  }>(
    `SELECT s.title, s.window_start, s.window_end, s.status::text AS status,
            v.legal_name AS vendor_name, st.full_name AS staff_name
       FROM projects.schedule_items s
       LEFT JOIN projects.vendors v ON v.id = s.vendor_id
       LEFT JOIN projects.staff st ON st.id = s.staff_id
      WHERE s.project_id = $1
      ORDER BY s.window_start, s.title`,
    [projectId],
  );

  const assignments = await db.query<{
    name: string;
    kind: string;
    trade: string | null;
    item_title: string;
  }>(
    `SELECT r.name, r.kind, r.trade, s.title AS item_title
       FROM projects.schedule_assignments a
       JOIN projects.scheduling_resources r ON r.id = a.resource_id
       JOIN projects.schedule_items s ON s.id = a.schedule_item_id
      WHERE a.project_id = $1
      ORDER BY r.name, s.title`,
    [projectId],
  );

  const awarded = await db.query<{
    legal_name: string;
    trades: string[] | null;
  }>(
    `SELECT v.legal_name, v.trades
       FROM projects.bid_recipients br
       JOIN projects.bid_requests q ON q.id = br.request_id
       JOIN projects.vendors v ON v.id = br.vendor_id
      WHERE q.project_id = $1 AND br.response_status = 'awarded'
      ORDER BY v.legal_name`,
    [projectId],
  );

  const closeout = await db.query<{
    punch_done_at: unknown;
    punch_note: string | null;
    photos_done_at: unknown;
    photos_note: string | null;
    final_draw_invoice_number: string | null;
    warranty_start_on: unknown;
    review_request_note: string | null;
  }>(
    `SELECT punch_done_at, punch_note, photos_done_at, photos_note,
            final_draw_invoice_number, warranty_start_on, review_request_note
       FROM projects.project_closeout
      WHERE project_id = $1`,
    [projectId],
  );
  const closeoutRow = closeout.rows[0];

  const logs = await db.query<{
    n: string;
    first_on: unknown;
    last_on: unknown;
  }>(
    `SELECT count(*)::text AS n, min(log_date) AS first_on, max(log_date) AS last_on
       FROM projects.daily_logs
      WHERE project_id = $1`,
    [projectId],
  );

  const position = await db.query<{
    committed_open: string;
    total_committed: string;
    variance: string;
  }>(
    `SELECT COALESCE(SUM(committed_open), 0)::text AS committed_open,
            COALESCE(SUM(total_committed), 0)::text AS total_committed,
            COALESCE(SUM(variance), 0)::text AS variance
       FROM projects.v_cost_position
      WHERE project_id = $1`,
    [projectId],
  );

  const changes = await db.query<{ total: string }>(
    `SELECT COALESCE(SUM(customer_amount), 0)::text AS total
       FROM projects.change_orders
      WHERE project_id = $1 AND status = 'approved'`,
    [projectId],
  );

  const purchaseOrders = await db.query<{ n: string; total: string }>(
    `SELECT count(*)::text AS n, COALESCE(SUM(amount), 0)::text AS total
       FROM projects.purchase_orders
      WHERE project_id = $1 AND status <> 'void'`,
    [projectId],
  );

  const bills = await db.query<{ n: string; total: string }>(
    `SELECT count(*)::text AS n, COALESCE(SUM(vb.amount), 0)::text AS total
       FROM projects.vendor_bills vb
       JOIN projects.purchase_orders po ON po.id = vb.po_id
      WHERE po.project_id = $1 AND vb.status <> 'rejected'`,
    [projectId],
  );

  const financials = await readFinancialsDashboard(db, projectId);
  const figure = (value: { value: number | null } | undefined) =>
    value && value.value != null && Number.isFinite(value.value)
      ? roundMoney(value.value)
      : null;

  const documents = controls.rows.filter(
    (record) => record.kind === "document",
  );
  const charter = documents
    .filter((record) => record.data.folder === "charter_scope")
    .map((record) => asText(record.data.title))
    .filter(Boolean);

  const milestones = controls.rows
    .filter((record) => record.kind === "milestone")
    .map((record) => ({
      title: asText(record.data.title),
      due_on: calendarDay(record.data.due_on),
      completed_on: calendarDay(record.data.completed_on),
      state: asText(record.data.state) || "not_started",
    }))
    .filter((record) => record.title);

  const tasks = controls.rows
    .filter((record) => record.kind === "task")
    .map((record) => ({
      title: asText(record.data.title),
      start_on: calendarDay(record.data.start_on),
      due_on: calendarDay(record.data.due_on),
      completed_on: calendarDay(record.data.completed_on),
      state: asText(record.data.state) || "not_started",
    }))
    .filter((record) => record.title);

  const risks = controls.rows
    .filter((record) => record.kind === "risk")
    .map((record) => ({
      description: riskDescription(record.data),
      impact: numberInRange(record.data.impact),
      probability: numberInRange(record.data.likelihood),
      mitigation: asText(record.data.response),
      roam: asText(record.data.roam) || undefined,
    }))
    .filter((record) => record.description);

  const communications = controls.rows
    .filter((record) => record.kind === "communication")
    .map((record) => ({
      audience: asText(record.data.audience),
      channel: asText(record.data.channel).replaceAll("_", " "),
      cadence: asText(record.data.cadence).replaceAll("_", " "),
      notes: asText(record.data.delivery_notes),
    }))
    .filter((record) => record.audience || record.notes);

  const suggested = suggestedRoles(
    row.pm_name,
    row.estimator_name,
    awarded.rows,
    assignments.rows,
  );
  const costs: CostSnapshot = {
    contract_value: figure(financials.contractValue),
    budgeted_expense: figure(financials.totalBudgetedExpense),
    actual_expense: figure(financials.actualExpense),
    labor_actual: figure(financials.laborExpense),
    materials_actual: figure(financials.materialsExpense),
    subcontractor_actual: figure(financials.subcontractorExpense),
    budgeted_labor: figure(financials.budgetedLaborExpense),
    budgeted_materials: figure(financials.budgetedMaterials),
    budgeted_subcontractor: figure(financials.budgetedSubcontractor),
    budgeted_margin: figure(financials.budgetedMargin),
    budgeted_margin_percent: figure(financials.budgetedMarginPercent),
    actual_margin: figure(financials.actualMargin),
    actual_margin_percent: figure(financials.actualMarginPercent),
    committed_open: asNumber(position.rows[0]?.committed_open) ?? 0,
    total_committed: asNumber(position.rows[0]?.total_committed) ?? 0,
    variance: asNumber(position.rows[0]?.variance) ?? 0,
    approved_change_orders: asNumber(changes.rows[0]?.total) ?? 0,
    purchase_orders: {
      count: Number(purchaseOrders.rows[0]?.n ?? 0),
      total: asNumber(purchaseOrders.rows[0]?.total) ?? 0,
    },
    vendor_bills: {
      count: Number(bills.rows[0]?.n ?? 0),
      total: asNumber(bills.rows[0]?.total) ?? 0,
    },
  };

  const logRow = logs.rows[0];
  const pulled: PulledSnapshot = {
    pulled_at: new Date().toISOString(),
    currency: (row.currency || "USD").trim() || "USD",
    cover: {
      name: row.name,
      project_number: row.project_number,
      address: addressOf(row),
      customer: asText(row.source_customer_name) || null,
      stage: row.stage,
      pm_name: row.pm_name,
    },
    scope: {
      summary: asText(row.source_project_summary) || null,
      charter_documents: charter,
    },
    schedule: {
      scheduled_start: calendarDay(row.scheduled_start),
      scheduled_end: calendarDay(row.scheduled_end),
      field_start: calendarDay(row.field_start),
      actual_start: calendarDay(row.actual_start),
      actual_end: calendarDay(row.actual_end),
      plan_baseline_start: calendarDay(baseline.rows[0]?.start_on),
      plan_baseline_finish: calendarDay(baseline.rows[0]?.finish_on),
      milestones,
      tasks,
      items: scheduleItems.rows.map((item) => ({
        title: item.title,
        window_start: calendarDay(item.window_start),
        window_end: calendarDay(item.window_end),
        status: item.status,
        assigned_to: item.vendor_name || item.staff_name,
      })),
    },
    costs,
    risks,
    communications,
    suggested_roles: suggested,
    closeout: {
      punch_done: closeoutRow?.punch_done_at != null,
      punch_note: closeoutRow?.punch_note ?? null,
      photos_done: closeoutRow?.photos_done_at != null,
      photos_note: closeoutRow?.photos_note ?? null,
      final_draw_invoice_number: closeoutRow?.final_draw_invoice_number ?? null,
      warranty_start_on: calendarDay(closeoutRow?.warranty_start_on),
      review_request_note: closeoutRow?.review_request_note ?? null,
      photo_document_count: documents.filter(
        (record) => record.data.folder === "photos",
      ).length,
      closeout_document_count: documents.filter(
        (record) => record.data.folder === "closeout",
      ).length,
      gate_4_status: gateStatus,
    },
    daily_logs: {
      count: Number(logRow?.n ?? 0),
      first_on: calendarDay(logRow?.first_on),
      last_on: calendarDay(logRow?.last_on),
    },
  };

  return { available, stage: row.stage, gate_4_status: gateStatus, pulled };
}

function numberInRange(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5) return null;
  return parsed;
}

function suggestedRoles(
  pmName: string | null,
  estimatorName: string | null,
  awarded: Array<{ legal_name: string; trades: string[] | null }>,
  assignments: Array<{
    name: string;
    kind: string;
    trade: string | null;
    item_title: string;
  }>,
): PulledSnapshot["suggested_roles"] {
  const roles: PulledSnapshot["suggested_roles"] = [];
  if (pmName) {
    roles.push({
      name: pmName,
      role: "Project manager",
      responsibilities: "Runs the job. Pulled from the project.",
      source: "pm",
    });
  }
  if (estimatorName) {
    roles.push({
      name: estimatorName,
      role: "Estimator",
      responsibilities: "Priced the work. Pulled from the project.",
      source: "estimator",
    });
  }
  for (const vendor of awarded) {
    const trades = (vendor.trades ?? []).filter(Boolean).join(", ");
    roles.push({
      name: vendor.legal_name,
      role: "Awarded subcontractor",
      responsibilities: trades
        ? `Awarded. Trades: ${trades}.`
        : "Awarded subcontractor.",
      source: "sub",
    });
  }
  for (const assignment of assignments) {
    const trade = assignment.trade ? `, ${assignment.trade}` : "";
    roles.push({
      name: assignment.name,
      role: assignment.kind.replaceAll("_", " "),
      responsibilities: `On the schedule: ${assignment.item_title}${trade}.`,
      source: "schedule",
    });
  }
  return roles.slice(0, 40);
}
