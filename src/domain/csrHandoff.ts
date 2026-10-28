import { z } from "zod";
import type { SqlClient } from "../db/database.js";
import { ApiError, validationFailed } from "../http/errors.js";

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * CSR hand-off. The form lives on a project in the Handoff stage.
 * Submit, with the required fields, marks Gate 0 approved.
 * Acknowledge is a Project Coordinator action on Home. No email is sent
 * and Command Center is not called. ServiceTitan is not written.
 */

export const OFFICES = ["richmond", "hampton_newport_news"] as const;
export type HandoffOffice = (typeof OFFICES)[number];

export const OFFICE_LABELS: Record<HandoffOffice, string> = {
  richmond: "Richmond",
  hampton_newport_news: "Hampton-Newport News",
};

export const PERMITS = ["yes", "no", "unknown"] as const;
export type PermitsLikely = (typeof PERMITS)[number];

const emptyOrOffice = z.union([z.literal(""), z.enum(OFFICES)]);
const emptyOrPermits = z.union([z.literal(""), z.enum(PERMITS)]);

export const NOT_IN_SERVICETITAN = "Not in ServiceTitan";

/**
 * What the CSR may type. Customer, phone, email, address, estimate, and sold
 * amount are not here: they are read from ServiceTitan data already stored
 * on the project, and a missing value is not an editable box.
 */
export const handoffWriteSchema = z
  .object({
    office: emptyOrOffice,
    lead_source: z.string().trim().max(200),
    scope_summary: z.string().trim().max(8000),
    handoff_project_ref: z.string().trim().max(200),
    target_start_window: z.string().trim().max(200),
    access_notes: z.string().trim().max(4000),
    decision_maker_notes: z.string().trim().max(4000),
    permits_likely: emptyOrPermits,
    submit: z.boolean(),
  })
  .strict();

export type HandoffWrite = z.infer<typeof handoffWriteSchema>;

export interface HandoffFields {
  customer_name: string;
  phone: string;
  email: string;
  service_address: string;
  office: "" | HandoffOffice;
  lead_source: string;
  scope_summary: string;
  handoff_project_ref: string;
  handoff_estimate_amount: number | null;
  sold_amount: number | null;
  target_start_window: string;
  access_notes: string;
  decision_maker_notes: string;
  permits_likely: "" | PermitsLikely;
}

export const EMPTY_FIELDS: HandoffFields = {
  customer_name: "",
  phone: "",
  email: "",
  service_address: "",
  office: "",
  lead_source: "",
  scope_summary: "",
  handoff_project_ref: "",
  handoff_estimate_amount: null,
  sold_amount: null,
  target_start_window: "",
  access_notes: "",
  decision_maker_notes: "",
  permits_likely: "",
};

const REQUIRED_GAPS = [
  "customer_name",
  "phone_or_email",
  "service_address",
  "office",
  "scope_summary",
] as const;

export type RequiredGap = (typeof REQUIRED_GAPS)[number];

const GAP_MESSAGE: Record<RequiredGap, string> = {
  customer_name: "Customer name is not in ServiceTitan.",
  phone_or_email: "A phone number or an email is not in ServiceTitan.",
  service_address: "Service address is not in ServiceTitan.",
  office: "Office is required.",
  scope_summary: "Scope summary is required.",
};

/** Required to submit: name, phone or email, address, office, scope. */
export function submitGaps(fields: HandoffFields): RequiredGap[] {
  const gaps: RequiredGap[] = [];
  if (!fields.customer_name.trim()) gaps.push("customer_name");
  if (!fields.phone.trim() && !fields.email.trim()) gaps.push("phone_or_email");
  if (!fields.service_address.trim()) gaps.push("service_address");
  if (!fields.office) gaps.push("office");
  if (!fields.scope_summary.trim()) gaps.push("scope_summary");
  return gaps;
}

export function assertSubmittable(fields: HandoffFields): void {
  const gaps = submitGaps(fields);
  if (gaps.length === 0) return;
  throw validationFailed(
    gaps.map((field) => ({ field, message: GAP_MESSAGE[field] })),
    "The hand-off is missing required fields.",
  );
}

export function officeFromBusinessUnit(
  name: string | null | undefined,
): "" | HandoffOffice {
  const normalized = (name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ");
  if (normalized === "richmond") return "richmond";
  if (normalized === "hampton-newport news") return "hampton_newport_news";
  return "";
}

export function officeLabel(office: string | null | undefined): string {
  if (office === "richmond" || office === "hampton_newport_news") {
    return OFFICE_LABELS[office];
  }
  return "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function textOf(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function joinAddress(
  street: string,
  unit: string,
  city: string,
  region: string,
  postal: string,
): string {
  const line1 = [street, unit].filter(Boolean).join(" ");
  const regionPostal = [region, postal].filter(Boolean).join(" ");
  const line2 = [city, regionPostal].filter(Boolean).join(", ");
  return [line1, line2].filter(Boolean).join(", ");
}

function windowText(start: string | null, end: string | null): string {
  const from = (start ?? "").slice(0, 10);
  const to = (end ?? "").slice(0, 10);
  if (from && to && from !== to) return `${from} to ${to}`;
  return from || to || "";
}

export interface ServiceTitanHandoff {
  customer_name: string | null;
  phone: string | null;
  email: string | null;
  service_address: string | null;
  estimate_amount: number | null;
  sold_amount: number | null;
}

export interface SuggestInput {
  sourceCustomerName: string | null;
  addressLine1: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  businessUnitName: string | null;
  sourceProjectSummary: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  externalProjectId: string | null;
  snapshot: unknown;
  /** True when a ServiceTitan project connection is already stored. */
  linked: boolean;
  estimateAmount: number | null;
  /** Sold estimate total from a ServiceTitan read. Not the Journeyman contract. */
  soldAmount: number | null;
}

function snapshotCustomer(snapshot: Record<string, unknown>): Record<string, unknown> {
  return asRecord(snapshot.customer);
}

function snapshotContact(customer: Record<string, unknown>): Record<string, unknown> | undefined {
  const contacts = Array.isArray(customer.contacts) ? customer.contacts : [];
  return contacts.map(asRecord).find((row) => textOf(row.phone, row.phoneNumber, row.email));
}

function snapshotServiceAddress(snapshot: Record<string, unknown>): string {
  const location = asRecord(snapshot.location);
  const address = asRecord(location.address);
  return joinAddress(
    textOf(address.street, address.line1, address.address_line1),
    textOf(address.unit),
    textOf(address.city),
    textOf(address.state, address.region),
    textOf(address.zip, address.postal_code, address.postalCode),
  );
}

function orNull(value: string): string | null {
  return value.trim() ? value.trim() : null;
}

/**
 * Customer, contact, address, estimate, and sold amount from ServiceTitan
 * data Journeyman already stored. Null when that read did not include the
 * value. This does not call ServiceTitan.
 */
export function serviceTitanHandoff(input: SuggestInput): ServiceTitanHandoff {
  const snapshot = asRecord(input.snapshot);
  const customer = snapshotCustomer(snapshot);
  const contact = snapshotContact(customer);
  const projectAddress = joinAddress(
    textOf(input.addressLine1),
    "",
    textOf(input.city),
    textOf(input.region),
    textOf(input.postalCode),
  );
  const address = snapshotServiceAddress(snapshot) || (input.linked ? projectAddress : "");
  return {
    customer_name: orNull(textOf(input.sourceCustomerName, customer.name)),
    phone: orNull(
      textOf(customer.phone, customer.phoneNumber, contact?.phone, contact?.phoneNumber),
    ),
    email: orNull(textOf(customer.email, contact?.email)),
    service_address: orNull(address),
    estimate_amount: input.estimateAmount,
    sold_amount: input.soldAmount,
  };
}

/**
 * Fields ServiceTitan does not hold, prefilled from the project when a value
 * is already stored. The CSR can still edit these. This does not call ServiceTitan.
 */
export function suggestHandoff(input: SuggestInput): HandoffFields {
  const snapshot = asRecord(input.snapshot);
  const customer = snapshotCustomer(snapshot);
  const st = serviceTitanHandoff(input);
  return {
    customer_name: st.customer_name ?? "",
    phone: st.phone ?? "",
    email: st.email ?? "",
    service_address: st.service_address ?? "",
    office: officeFromBusinessUnit(input.businessUnitName),
    lead_source: textOf(
      snapshot.leadSource,
      snapshot.lead_source,
      customer.leadSource,
      customer.lead_source,
    ),
    scope_summary: textOf(
      input.sourceProjectSummary,
      snapshot.summary,
      asRecord(snapshot.project).summary,
    ),
    handoff_project_ref: textOf(input.externalProjectId, snapshot.id, snapshot.number),
    handoff_estimate_amount: st.estimate_amount,
    sold_amount: st.sold_amount,
    target_start_window: windowText(input.scheduledStart, input.scheduledEnd),
    access_notes: "",
    decision_maker_notes: "",
    permits_likely: "",
  };
}

interface StoredRow {
  customer_name: string;
  phone: string;
  email: string;
  service_address: string;
  office: string | null;
  lead_source: string;
  scope_summary: string;
  handoff_project_ref: string;
  handoff_estimate_amount: string | number | null;
  sold_amount: string | number | null;
  target_start_window: string;
  access_notes: string;
  decision_maker_notes: string;
  permits_likely: string | null;
  status: "draft" | "submitted";
  submitted_at: string | null;
  submitted_by_name: string | null;
  acknowledged_at: string | null;
  acknowledged_by_name: string | null;
}

function storedFields(row: StoredRow): HandoffFields {
  const office = row.office === "richmond" || row.office === "hampton_newport_news"
    ? row.office
    : "";
  const permits =
    row.permits_likely === "yes" ||
    row.permits_likely === "no" ||
    row.permits_likely === "unknown"
      ? row.permits_likely
      : "";
  return {
    customer_name: row.customer_name,
    phone: row.phone,
    email: row.email,
    service_address: row.service_address,
    office,
    lead_source: row.lead_source,
    scope_summary: row.scope_summary,
    handoff_project_ref: row.handoff_project_ref,
    handoff_estimate_amount: num(row.handoff_estimate_amount),
    sold_amount: num(row.sold_amount),
    target_start_window: row.target_start_window,
    access_notes: row.access_notes,
    decision_maker_notes: row.decision_maker_notes,
    permits_likely: permits,
  };
}

export interface HandoffView {
  project_id: string;
  stage: string;
  saved: boolean;
  status: "draft" | "submitted" | null;
  submitted_at: string | null;
  submitted_by_name: string | null;
  acknowledged_at: string | null;
  acknowledged_by_name: string | null;
  fields: HandoffFields;
  suggestions: HandoffFields;
  service_titan: ServiceTitanHandoff;
  gate: { gate_number: number; title: string; status: string } | null;
}

export interface NewHandoffItem {
  project_id: string;
  project_number: string;
  project_name: string;
  customer_name: string;
  office: string | null;
  office_label: string;
  scope_summary: string;
  submitted_at: string;
  href: string;
}

async function loadSuggestions(
  db: SqlClient,
  projectId: string,
): Promise<{ stage: string; suggestions: HandoffFields; serviceTitan: ServiceTitanHandoff }> {
  const project = await db.query<{
    stage: string;
    source_customer_name: string | null;
    address_line1: string | null;
    city: string | null;
    region: string | null;
    postal_code: string | null;
    business_unit_name: string | null;
    source_project_summary: string | null;
    scheduled_start: string | null;
    scheduled_end: string | null;
    external_project_id: string | null;
    snapshot: unknown;
    linked: boolean;
    estimates_read: boolean | null;
    st_sold: string | number | null;
  }>(
    `SELECT p.stage::text AS stage,
            p.source_customer_name,
            p.address_line1, p.city, p.region, p.postal_code,
            bu.name AS business_unit_name,
            p.source_project_summary,
            p.scheduled_start::text AS scheduled_start,
            p.scheduled_end::text AS scheduled_end,
            c.external_project_id,
            c.snapshot,
            c.project_id IS NOT NULL AS linked,
            s.estimates_read,
            s.contract_value AS st_sold
       FROM projects.projects p
       LEFT JOIN projects.business_units bu ON bu.id = p.business_unit_id
       LEFT JOIN projects.st_project_connections c ON c.project_id = p.id
       LEFT JOIN projects.st_project_summary s ON s.project_id = p.id
      WHERE p.id = $1`,
    [projectId],
  );
  const row = project.rows[0];
  if (!row) throw new ApiError("not_found", "Project not found");
  const estimate = await db.query<{ customer_amount: string | number }>(
    `SELECT customer_amount
       FROM projects.st_estimate_observations
      WHERE project_id = $1 AND classification = 'original'
      ORDER BY observed_at DESC
      LIMIT 1`,
    [projectId],
  );
  const soldEstimates = await db.query<{ n: string; amount: string | number | null }>(
    `SELECT count(*)::text AS n, COALESCE(sum(customer_amount), 0) AS amount
       FROM projects.st_estimate_observations
      WHERE project_id = $1
        AND lower(btrim(COALESCE(status, ''))) = 'sold'`,
    [projectId],
  );
  let soldAmount: number | null = null;
  if (row.estimates_read) {
    soldAmount = num(row.st_sold);
  }
  if (soldAmount == null && Number(soldEstimates.rows[0]?.n ?? 0) > 0) {
    soldAmount = num(soldEstimates.rows[0]?.amount);
  }
  const input: SuggestInput = {
    sourceCustomerName: row.source_customer_name,
    addressLine1: row.address_line1,
    city: row.city,
    region: row.region,
    postalCode: row.postal_code,
    businessUnitName: row.business_unit_name,
    sourceProjectSummary: row.source_project_summary,
    scheduledStart: row.scheduled_start,
    scheduledEnd: row.scheduled_end,
    externalProjectId: row.external_project_id,
    snapshot: row.snapshot,
    linked: row.linked,
    estimateAmount: estimate.rows[0] ? num(estimate.rows[0].customer_amount) : null,
    soldAmount,
  };
  return {
    stage: row.stage,
    suggestions: suggestHandoff(input),
    serviceTitan: serviceTitanHandoff(input),
  };
}

async function loadStored(db: SqlClient, projectId: string): Promise<StoredRow | null> {
  const { rows } = await db.query<StoredRow>(
    `SELECT h.customer_name, h.phone, h.email, h.service_address, h.office,
            h.lead_source, h.scope_summary, h.handoff_project_ref,
            h.handoff_estimate_amount, h.sold_amount, h.target_start_window,
            h.access_notes, h.decision_maker_notes, h.permits_likely,
            h.status, h.submitted_at::text AS submitted_at,
            sub.full_name AS submitted_by_name,
            h.acknowledged_at::text AS acknowledged_at,
            ack.full_name AS acknowledged_by_name
       FROM projects.csr_handoffs h
       LEFT JOIN projects.staff sub ON sub.id = h.submitted_by
       LEFT JOIN projects.staff ack ON ack.id = h.acknowledged_by
      WHERE h.project_id = $1`,
    [projectId],
  );
  return rows[0] ?? null;
}

async function loadGate(db: SqlClient, projectId: string) {
  const { rows } = await db.query<{
    gate_number: number;
    title: string;
    status: string;
  }>(
    `SELECT gate_number, title, status::text AS status
       FROM projects.stage_gates
      WHERE project_id = $1 AND gate_number = 0`,
    [projectId],
  );
  return rows[0] ?? null;
}

export async function presentHandoff(
  db: SqlClient,
  projectId: string,
): Promise<HandoffView> {
  const [{ stage, suggestions, serviceTitan }, stored, gate] = await Promise.all([
    loadSuggestions(db, projectId),
    loadStored(db, projectId),
    loadGate(db, projectId),
  ]);
  const editable = stored ? storedFields(stored) : suggestions;
  return {
    project_id: projectId,
    stage,
    saved: stored != null,
    status: stored?.status ?? null,
    submitted_at: stored?.submitted_at ?? null,
    submitted_by_name: stored?.submitted_by_name ?? null,
    acknowledged_at: stored?.acknowledged_at ?? null,
    acknowledged_by_name: stored?.acknowledged_by_name ?? null,
    fields: applyServiceTitan(editable, serviceTitan),
    suggestions,
    service_titan: serviceTitan,
    gate,
  };
}

function applyServiceTitan(fields: HandoffFields, st: ServiceTitanHandoff): HandoffFields {
  return {
    ...fields,
    customer_name: st.customer_name ?? "",
    phone: st.phone ?? "",
    email: st.email ?? "",
    service_address: st.service_address ?? "",
    handoff_estimate_amount: st.estimate_amount,
    sold_amount: st.sold_amount,
  };
}

function fieldsOf(body: HandoffWrite, st: ServiceTitanHandoff): HandoffFields {
  return applyServiceTitan(
    {
      customer_name: "",
      phone: "",
      email: "",
      service_address: "",
      office: body.office,
      lead_source: body.lead_source,
      scope_summary: body.scope_summary,
      handoff_project_ref: body.handoff_project_ref,
      handoff_estimate_amount: null,
      sold_amount: null,
      target_start_window: body.target_start_window,
      access_notes: body.access_notes,
      decision_maker_notes: body.decision_maker_notes,
      permits_likely: body.permits_likely,
    },
    st,
  );
}

export async function saveHandoff(
  db: SqlClient,
  projectId: string,
  tenantId: string,
  staffId: string,
  body: HandoffWrite,
): Promise<HandoffView> {
  const existing = await loadStored(db, projectId);
  const { serviceTitan } = await loadSuggestions(db, projectId);
  const fields = fieldsOf(body, serviceTitan);
  const submitting = body.submit || existing?.status === "submitted";
  if (submitting) assertSubmittable(fields);
  const status = submitting ? "submitted" : "draft";
  const submittedAt = status === "submitted" ? new Date().toISOString() : null;
  const submittedBy = status === "submitted" ? staffId : null;
  await db.query(
    `INSERT INTO projects.csr_handoffs (
       project_id, tenant_id, customer_name, phone, email, service_address, office,
       lead_source, scope_summary, handoff_project_ref, handoff_estimate_amount,
       sold_amount, target_start_window, access_notes, decision_maker_notes,
       permits_likely, status, submitted_at, submitted_by
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
     )
     ON CONFLICT (project_id) DO UPDATE SET
       customer_name = EXCLUDED.customer_name,
       phone = EXCLUDED.phone,
       email = EXCLUDED.email,
       service_address = EXCLUDED.service_address,
       office = EXCLUDED.office,
       lead_source = EXCLUDED.lead_source,
       scope_summary = EXCLUDED.scope_summary,
       handoff_project_ref = EXCLUDED.handoff_project_ref,
       handoff_estimate_amount = EXCLUDED.handoff_estimate_amount,
       sold_amount = EXCLUDED.sold_amount,
       target_start_window = EXCLUDED.target_start_window,
       access_notes = EXCLUDED.access_notes,
       decision_maker_notes = EXCLUDED.decision_maker_notes,
       permits_likely = EXCLUDED.permits_likely,
       status = CASE
         WHEN csr_handoffs.status = 'submitted' THEN 'submitted'
         ELSE EXCLUDED.status
       END,
       submitted_at = COALESCE(csr_handoffs.submitted_at, EXCLUDED.submitted_at),
       submitted_by = COALESCE(csr_handoffs.submitted_by, EXCLUDED.submitted_by),
       updated_at = now()`,
    [
      projectId,
      tenantId,
      fields.customer_name,
      fields.phone,
      fields.email,
      fields.service_address,
      fields.office || null,
      fields.lead_source,
      fields.scope_summary,
      fields.handoff_project_ref,
      fields.handoff_estimate_amount,
      fields.sold_amount,
      fields.target_start_window,
      fields.access_notes,
      fields.decision_maker_notes,
      fields.permits_likely || null,
      status,
      submittedAt,
      submittedBy,
    ],
  );
  if (body.submit) await completeGate0(db, projectId, staffId);
  return presentHandoff(db, projectId);
}

/**
 * Gate 0 is Qualification and handoff. A submitted form with the required
 * fields completes it. Checklist ticks are not required. An approval that is
 * already recorded is left as it is, including who approved it.
 */
export async function completeGate0(
  db: SqlClient,
  projectId: string,
  staffId: string,
): Promise<void> {
  await db.query(
    `UPDATE projects.stage_gates
        SET status = 'approved',
            approved_by = $2,
            approved_at = now(),
            rejected_note = NULL
      WHERE project_id = $1
        AND gate_number = 0
        AND status IS DISTINCT FROM 'approved'`,
    [projectId, staffId],
  );
}

export async function acknowledgeHandoff(
  db: SqlClient,
  projectId: string,
  staffId: string,
): Promise<HandoffView> {
  const existing = await loadStored(db, projectId);
  if (!existing || existing.status !== "submitted") {
    throw new ApiError(
      "conflict",
      "This hand-off has not been submitted.",
      { project_id: projectId },
    );
  }
  if (!existing.acknowledged_at) {
    await db.query(
      `UPDATE projects.csr_handoffs
          SET acknowledged_at = now(), acknowledged_by = $2, updated_at = now()
        WHERE project_id = $1 AND acknowledged_at IS NULL`,
      [projectId, staffId],
    );
  }
  return presentHandoff(db, projectId);
}

export async function loadNewHandoffs(
  db: SqlClient,
  scope: string | null,
): Promise<{ count: number; items: NewHandoffItem[] }> {
  const { rows } = await db.query<{
    project_id: string;
    project_number: string;
    project_name: string;
    customer_name: string;
    office: string | null;
    scope_summary: string;
    submitted_at: string;
  }>(
    `SELECT p.id AS project_id, p.project_number, p.name AS project_name,
            COALESCE(
              NULLIF(btrim(p.source_customer_name), ''),
              NULLIF(btrim(c.snapshot #>> '{customer,name}'), ''),
              NULLIF(btrim(h.customer_name), ''),
              ''
            ) AS customer_name,
            h.office, h.scope_summary,
            h.submitted_at::text AS submitted_at
       FROM projects.csr_handoffs h
       JOIN projects.projects p ON p.id = h.project_id
       LEFT JOIN projects.st_project_connections c ON c.project_id = p.id
      WHERE h.status = 'submitted'
        AND h.acknowledged_at IS NULL
        AND ($1::uuid IS NULL OR p.business_unit_id IS NULL OR p.business_unit_id = $1::uuid)
      ORDER BY h.submitted_at ASC, p.project_number ASC`,
    [scope],
  );
  const items = rows.map((row) => ({
    project_id: row.project_id,
    project_number: row.project_number,
    project_name: row.project_name,
    customer_name: row.customer_name,
    office: row.office,
    office_label: officeLabel(row.office),
    scope_summary: row.scope_summary,
    submitted_at: row.submitted_at,
    href: `/?project=${encodeURIComponent(row.project_id)}#dashboard`,
  }));
  return { count: items.length, items };
}
