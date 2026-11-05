import { z } from "zod";
import type { SqlClient } from "../db/database.js";
import { ApiError } from "../http/errors.js";

export const CSV_COLUMNS = [
  "municipality",
  "state",
  "office_name",
  "address_line1",
  "address_line2",
  "office_city",
  "postal_code",
  "main_phone",
  "website_url",
  "portal_url",
  "work_requiring_permit",
  "required_documents",
  "plan_requirements",
  "fee_notes",
  "fee_schedule_url",
  "typical_review_days",
  "inspection_method",
  "inspection_phone",
  "inspection_url",
  "notes",
  "last_verified",
  "contact_name",
  "contact_title",
  "contact_phone",
  "contact_email",
  "contact_notes",
] as const;

/**
 * JSON keys the importer drops on the document and on each office.
 * The seed file is an array of offices, and each office carries these three.
 * Any other unknown key is rejected. Credential-like keys are rejected
 * even when they sit inside one of these objects.
 */
export const IGNORED_IMPORT_KEYS = ["source_urls", "completeness", "data_gaps"] as const;

const CREDENTIAL_KEY = /(user_?name|password|passcode|token|secret|api_?key)/i;

const httpUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((value) => /^https?:\/\//i.test(value), "Use an http or https URL");

const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((value) => {
      const trimmed = value?.trim() ?? "";
      return trimmed === "" ? null : trimmed;
    });

const optionalUrl = z
  .union([httpUrl, z.literal(""), z.null()])
  .optional()
  .transform((value) => (value ? value : null));

const contactSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    title: optionalText(200),
    role: optionalText(200),
    contact_role: optionalText(200),
    phone: optionalText(80),
    email: z
      .string()
      .trim()
      .max(200)
      .nullish()
      .transform((value) => {
        const trimmed = value?.trim() ?? "";
        return trimmed === "" ? null : trimmed;
      }),
    notes: optionalText(2000),
  })
  .strict()
  .transform((contact) => ({
    name: contact.name,
    title: contact.title ?? contact.role ?? contact.contact_role,
    phone: contact.phone,
    email: contact.email,
    notes: contact.notes,
  }));

const officeSchema = z
  .object({
    municipality: z.string().trim().min(1).max(200),
    state: z
      .string()
      .trim()
      .transform((value) => value.toUpperCase())
      .pipe(z.string().regex(/^[A-Z]{2}$/)),
    office_name: optionalText(200),
    address_line1: optionalText(200),
    address_line2: optionalText(200),
    office_city: optionalText(200),
    postal_code: optionalText(20),
    main_phone: optionalText(80),
    website_url: optionalUrl,
    portal_url: optionalUrl,
    work_requiring_permit: optionalText(4000),
    required_documents: optionalText(4000),
    plan_requirements: optionalText(4000),
    fee_notes: optionalText(4000),
    fee_schedule_url: optionalUrl,
    typical_review_days: z.number().int().min(0).max(3650).nullish(),
    inspection_method: z
      .enum(["phone", "portal", "email", "in_person", "other"])
      .nullish(),
    inspection_phone: optionalText(80),
    inspection_url: optionalUrl,
    notes: optionalText(2000),
    last_verified: z.string().date().nullish(),
    contacts: z.array(contactSchema).optional(),
  })
  .strict();

export type PermitOfficeInput = z.infer<typeof officeSchema>;
export type PermitContactInput = PermitOfficeInput["contacts"] extends
  | Array<infer C>
  | undefined
  ? C
  : never;

export interface ImportCounts {
  created: number;
  updated: number;
  contacts_upserted: number;
  unchanged: number;
}

const OFFICE_FIELDS = [
  "office_name",
  "address_line1",
  "address_line2",
  "office_city",
  "postal_code",
  "contact_phone",
  "website_url",
  "portal_url",
  "work_requiring_permit",
  "required_documents",
  "plan_requirements",
  "fee_notes",
  "fee_schedule_url",
  "typical_review_days",
  "inspection_method",
  "inspection_phone",
  "inspection_url",
  "notes",
  "last_verified",
] as const;

export function rejectCredentialKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) rejectCredentialKeys(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (CREDENTIAL_KEY.test(key)) {
      throw new ApiError(
        "validation_failed",
        `Permit office import does not accept ${key}.`,
      );
    }
    rejectCredentialKeys(child);
  }
}

export function stripIgnoredImportKeys(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const copy = { ...(value as Record<string, unknown>) };
  for (const key of IGNORED_IMPORT_KEYS) delete copy[key];
  return copy;
}

export function parsePermitOfficeJson(body: unknown): PermitOfficeInput[] {
  rejectCredentialKeys(body);
  const stripped = stripIgnoredImportKeys(body);
  if (Array.isArray(stripped)) {
    return stripped.map((office, index) => parseOffice(stripIgnoredImportKeys(office), index));
  }
  if (stripped && typeof stripped === "object" && "offices" in stripped) {
    const parsed = z
      .object({ offices: z.array(z.unknown()).min(1) })
      .strict()
      .safeParse(stripped);
    if (!parsed.success) {
      throw new ApiError(
        "validation_failed",
        "Permit office JSON is not valid.",
        parsed.error.flatten(),
      );
    }
    return parsed.data.offices.map((office, index) =>
      parseOffice(stripIgnoredImportKeys(office), index),
    );
  }
  return [parseOffice(stripIgnoredImportKeys(stripped), 0)];
}

function parseOffice(value: unknown, index: number): PermitOfficeInput {
  const parsed = officeSchema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError(
      "validation_failed",
      `Permit office ${index + 1} is not valid.`,
      parsed.error.flatten(),
    );
  }
  if (parsed.data.contacts) {
    for (const contact of parsed.data.contacts) {
      if (contact.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) {
        throw new ApiError("validation_failed", "Contact email is not valid.", {
          field: "email",
        });
      }
    }
  }
  return parsed.data;
}

export function parsePermitOfficeCsv(text: string): PermitOfficeInput[] {
  const rows = parseCsv(text);
  if (rows.length < 2) {
    throw new ApiError("validation_failed", "The CSV needs a header and one office row.");
  }
  const header = rows[0]!.map((cell) => cell.trim());
  for (const column of header) {
    if (CREDENTIAL_KEY.test(column)) {
      throw new ApiError(
        "validation_failed",
        `Permit office import does not accept ${column}.`,
      );
    }
  }
  const titleColumn = header.includes("contact_title")
    ? "contact_title"
    : header.includes("contact_role")
      ? "contact_role"
      : null;
  const expected = CSV_COLUMNS.filter((column) => column !== "contact_title");
  const missing = [
    ...expected.filter((column) => !header.includes(column)),
    ...(titleColumn ? [] : ["contact_title"]),
  ];
  const allowed = new Set<string>([...CSV_COLUMNS, "contact_role"]);
  const unexpected = header.filter((column) => column && !allowed.has(column));
  if (missing.length || unexpected.length || new Set(header).size !== header.length) {
    throw new ApiError("validation_failed", "CSV columns do not match the permit office file.", {
      missing,
      unexpected,
    });
  }
  const index = new Map(header.map((column, position) => [column, position]));
  const grouped = new Map<string, PermitOfficeInput>();
  for (const [rowNumber, row] of rows.slice(1).entries()) {
    const cell = (column: string) => {
      const at = index.get(column);
      return at === undefined ? "" : (row[at] ?? "").trim();
    };
    const municipality = cell("municipality");
    const state = cell("state").toUpperCase();
    if (!municipality || !/^[A-Z]{2}$/.test(state)) {
      throw new ApiError(
        "validation_failed",
        `Row ${rowNumber + 2} needs a municipality and a two-letter state.`,
      );
    }
    const key = `${municipality.toLowerCase()}|${state}`;
    const days = cell("typical_review_days");
    const parsedDays =
      days === "" ? null : Number(days);
    if (
      parsedDays !== null &&
      (!Number.isInteger(parsedDays) || parsedDays < 0)
    ) {
      throw new ApiError(
        "validation_failed",
        `Row ${rowNumber + 2} has a typical review time that is not a whole number of days.`,
      );
    }
    const draft = {
      municipality,
      state,
      office_name: cell("office_name") || null,
      address_line1: cell("address_line1") || null,
      address_line2: cell("address_line2") || null,
      office_city: cell("office_city") || null,
      postal_code: cell("postal_code") || null,
      main_phone: cell("main_phone") || null,
      website_url: cell("website_url") || null,
      portal_url: cell("portal_url") || null,
      work_requiring_permit: cell("work_requiring_permit") || null,
      required_documents: cell("required_documents") || null,
      plan_requirements: cell("plan_requirements") || null,
      fee_notes: cell("fee_notes") || null,
      fee_schedule_url: cell("fee_schedule_url") || null,
      typical_review_days: parsedDays,
      inspection_method: cell("inspection_method") || null,
      inspection_phone: cell("inspection_phone") || null,
      inspection_url: cell("inspection_url") || null,
      notes: cell("notes") || null,
      last_verified: cell("last_verified") || null,
      contacts: [] as PermitOfficeInput["contacts"],
    };
    const contactName = cell("contact_name");
    if (contactName) {
      draft.contacts = [
        {
          name: contactName,
          title: cell(titleColumn!) || null,
          phone: cell("contact_phone") || null,
          email: cell("contact_email") || null,
          notes: cell("contact_notes") || null,
        },
      ];
    }
    const office = parseOffice(draft, rowNumber);
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, office);
      continue;
    }
    const merged = { ...existing };
    for (const field of [
      "office_name",
      "address_line1",
      "address_line2",
      "office_city",
      "postal_code",
      "main_phone",
      "website_url",
      "portal_url",
      "work_requiring_permit",
      "required_documents",
      "plan_requirements",
      "fee_notes",
      "fee_schedule_url",
      "typical_review_days",
      "inspection_method",
      "inspection_phone",
      "inspection_url",
      "notes",
      "last_verified",
    ] as const) {
      const value = office[field];
      if (value !== null && value !== undefined) {
        (merged as Record<string, unknown>)[field] = value;
      }
    }
    merged.contacts = [...(existing.contacts ?? []), ...(office.contacts ?? [])];
    grouped.set(key, merged);
  }
  return [...grouped.values()];
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const src = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (ch === "\n") {
      row.push(cell);
      cell = "";
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      continue;
    }
    if (ch !== "\r") cell += ch;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value.trim() !== "")) rows.push(row);
  }
  return rows;
}

interface StoredOffice {
  id: string;
  name: string;
  office_name: string | null;
  address_line1: string | null;
  address_line2: string | null;
  office_city: string | null;
  postal_code: string | null;
  contact_phone: string | null;
  website_url: string | null;
  portal_url: string | null;
  work_requiring_permit: string | null;
  required_documents: string | null;
  plan_requirements: string | null;
  fee_notes: string | null;
  fee_schedule_url: string | null;
  typical_review_days: number | null;
  inspection_method: string | null;
  inspection_phone: string | null;
  inspection_url: string | null;
  notes: string | null;
  last_verified: string | null;
}

function storedFromInput(office: PermitOfficeInput): Omit<StoredOffice, "id" | "name"> {
  return {
    office_name: office.office_name ?? null,
    address_line1: office.address_line1 ?? null,
    address_line2: office.address_line2 ?? null,
    office_city: office.office_city ?? null,
    postal_code: office.postal_code ?? null,
    contact_phone: office.main_phone ?? null,
    website_url: office.website_url ?? null,
    portal_url: office.portal_url ?? null,
    work_requiring_permit: office.work_requiring_permit ?? null,
    required_documents: office.required_documents ?? null,
    plan_requirements: office.plan_requirements ?? null,
    fee_notes: office.fee_notes ?? null,
    fee_schedule_url: office.fee_schedule_url ?? null,
    typical_review_days: office.typical_review_days ?? null,
    inspection_method: office.inspection_method ?? null,
    inspection_phone: office.inspection_phone ?? null,
    inspection_url: office.inspection_url ?? null,
    notes: office.notes ?? null,
    last_verified: office.last_verified ?? null,
  };
}

function sameOffice(current: StoredOffice, next: Omit<StoredOffice, "id" | "name">): boolean {
  return OFFICE_FIELDS.every((field) => {
    const left = current[field];
    const right = next[field];
    if (field === "typical_review_days") {
      if (left == null && right == null) return true;
      return Number(left) === Number(right);
    }
    const a = left == null || left === "" ? null : String(left);
    const b = right == null || right === "" ? null : String(right);
    if (field === "last_verified") {
      return (a?.slice(0, 10) ?? null) === (b?.slice(0, 10) ?? null);
    }
    return a === b;
  });
}

export async function importPermitOffices(
  db: SqlClient,
  tenantId: string,
  offices: PermitOfficeInput[],
): Promise<ImportCounts> {
  const counts: ImportCounts = {
    created: 0,
    updated: 0,
    contacts_upserted: 0,
    unchanged: 0,
  };
  for (const office of offices) {
    const next = storedFromInput(office);
    const found = await db.query<StoredOffice>(
      `SELECT id, name, office_name, address_line1, address_line2, office_city, postal_code,
              contact_phone, website_url, portal_url, work_requiring_permit,
              required_documents, plan_requirements, fee_notes, fee_schedule_url,
              typical_review_days, inspection_method, inspection_phone, inspection_url,
              notes, last_verified::text AS last_verified
         FROM projects.jurisdictions
        WHERE lower(name) = lower($1) AND state = $2`,
      [office.municipality, office.state],
    );
    let id = found.rows[0]?.id;
    let officeChanged = false;
    if (!id) {
      const inserted = await db.query<{ id: string }>(
        `INSERT INTO projects.jurisdictions
           (tenant_id, name, state, office_name, address_line1, address_line2, office_city,
            postal_code, contact_phone, website_url, portal_url, work_requiring_permit,
            required_documents, plan_requirements, fee_notes, fee_schedule_url,
            typical_review_days, inspection_method, inspection_phone, inspection_url,
            notes, last_verified)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
         RETURNING id`,
        [
          tenantId,
          office.municipality,
          office.state,
          next.office_name,
          next.address_line1,
          next.address_line2,
          next.office_city,
          next.postal_code,
          next.contact_phone,
          next.website_url,
          next.portal_url,
          next.work_requiring_permit,
          next.required_documents,
          next.plan_requirements,
          next.fee_notes,
          next.fee_schedule_url,
          next.typical_review_days,
          next.inspection_method,
          next.inspection_phone,
          next.inspection_url,
          next.notes,
          next.last_verified,
        ],
      );
      id = inserted.rows[0]!.id;
      counts.created += 1;
      officeChanged = true;
    } else if (found.rows[0]!.name !== office.municipality || !sameOffice(found.rows[0]!, next)) {
      await db.query(
        `UPDATE projects.jurisdictions
            SET name = $2, office_name = $3, address_line1 = $4, address_line2 = $5,
                office_city = $6, postal_code = $7, contact_phone = $8, website_url = $9,
                portal_url = $10, work_requiring_permit = $11, required_documents = $12,
                plan_requirements = $13, fee_notes = $14, fee_schedule_url = $15,
                typical_review_days = $16, inspection_method = $17, inspection_phone = $18,
                inspection_url = $19, notes = $20, last_verified = $21
          WHERE id = $1`,
        [
          id,
          office.municipality,
          next.office_name,
          next.address_line1,
          next.address_line2,
          next.office_city,
          next.postal_code,
          next.contact_phone,
          next.website_url,
          next.portal_url,
          next.work_requiring_permit,
          next.required_documents,
          next.plan_requirements,
          next.fee_notes,
          next.fee_schedule_url,
          next.typical_review_days,
          next.inspection_method,
          next.inspection_phone,
          next.inspection_url,
          next.notes,
          next.last_verified,
        ],
      );
      counts.updated += 1;
      officeChanged = true;
    }
    let contactsChanged = false;
    for (const [position, contact] of (office.contacts ?? []).entries()) {
      const current = await db.query<{
        id: string;
        title: string | null;
        phone: string | null;
        notes: string | null;
        sort_order: number;
      }>(
        `SELECT id, title, phone, notes, sort_order
           FROM projects.jurisdiction_contacts
          WHERE jurisdiction_id = $1
            AND lower(name) = lower($2)
            AND lower(coalesce(email, '')) = lower($3)`,
        [id, contact.name, contact.email ?? ""],
      );
      const row = current.rows[0];
      if (!row) {
        await db.query(
          `INSERT INTO projects.jurisdiction_contacts
             (tenant_id, jurisdiction_id, name, title, phone, email, notes, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            tenantId,
            id,
            contact.name,
            contact.title,
            contact.phone,
            contact.email,
            contact.notes,
            position,
          ],
        );
        counts.contacts_upserted += 1;
        contactsChanged = true;
      } else if (
        (row.title ?? null) !== (contact.title ?? null) ||
        (row.phone ?? null) !== (contact.phone ?? null) ||
        (row.notes ?? null) !== (contact.notes ?? null) ||
        row.sort_order !== position
      ) {
        await db.query(
          `UPDATE projects.jurisdiction_contacts
              SET title = $2, phone = $3, notes = $4, sort_order = $5
            WHERE id = $1`,
          [row.id, contact.title, contact.phone, contact.notes, position],
        );
        counts.contacts_upserted += 1;
        contactsChanged = true;
      }
    }
    if (!officeChanged && !contactsChanged) counts.unchanged += 1;
  }
  return counts;
}
