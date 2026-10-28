/**
 * Phone and email from a ServiceTitan customer or location contact list.
 * The list is what a CRM contacts GET already returned. Nothing here calls
 * ServiceTitan.
 */

export interface StoredServiceTitanContact {
  id: string | null;
  type: string;
  value: string;
  memo: string | null;
  /** True when ServiceTitan says not to contact this person at all. */
  optedOut: boolean;
  /** True when ServiceTitan says not to text this number. The number can still be called. */
  doNotText: boolean;
}

export interface PickedServiceTitanContact {
  phone: string | null;
  email: string | null;
  doNotText: boolean;
}

export interface ServiceTitanContactSource {
  id?: string | number | null;
  type?: string | null;
  value?: string | null;
  memo?: string | null;
  optedOut?: boolean | null;
  doNotContact?: boolean | null;
  doNotMail?: boolean | null;
  doNotText?: boolean | null;
  phoneSettings?: { phoneNumber?: string | null; doNotText?: boolean | null } | null;
}

function memoSaysMobile(memo: string | null | undefined): boolean {
  return /cell|mobile/i.test(memo ?? "");
}

/**
 * Mobile first, then a regular phone. Fax and email are not phone types.
 * An older row typed Phone whose memo says cell or mobile ranks as a mobile.
 */
export function phoneRank(type: string, memo?: string | null): number | null {
  const normalized = type.toLowerCase().replace(/[\s_-]/g, "");
  if (!normalized || normalized === "fax" || normalized.includes("email")) return null;
  if (normalized.includes("mobile") || normalized === "cell" || normalized.includes("cellphone")) return 0;
  if (normalized === "phone" && memoSaysMobile(memo)) return 0;
  if (
    normalized === "phone" ||
    normalized.includes("landline") ||
    normalized === "home" ||
    normalized.includes("homephone") ||
    normalized === "main"
  ) {
    return 1;
  }
  if (normalized.includes("phone")) return 2;
  return null;
}

export function isEmailType(type: string): boolean {
  return type.toLowerCase().replace(/[\s_-]/g, "").includes("email");
}

function isPrimary(memo: string | null): boolean {
  return /\bprimary\b/i.test(memo ?? "");
}

/** Drop a blank value. Keep an opted-out contact so the caller can see it was skipped. */
export function normalizeServiceTitanContact(
  row: ServiceTitanContactSource,
): StoredServiceTitanContact | null {
  const type = (row.type ?? "").trim();
  const value = (row.value ?? "").trim() || (row.phoneSettings?.phoneNumber ?? "").trim();
  if (!value) return null;
  const phone = phoneRank(type, row.memo) != null;
  const email = isEmailType(type) || (!phone && value.includes("@"));
  const optedOut =
    row.optedOut === true ||
    row.doNotContact === true ||
    (email && row.doNotMail === true);
  return {
    id: row.id == null ? null : String(row.id),
    type: type || (email ? "Email" : "Phone"),
    value,
    memo: row.memo?.trim() || null,
    optedOut,
    doNotText: row.doNotText === true || (phone && row.phoneSettings?.doNotText === true),
  };
}

/**
 * One phone and one email. Mobile beats a landline, even a primary landline.
 * A Phone row whose memo says cell or mobile counts as a mobile. Within a
 * type, a primary memo wins, then the earlier row. Customer contacts should
 * be listed before location contacts so a tie stays with the customer.
 * Rows opted out of contact, and blank rows, are not used. Do-not-text stays
 * eligible and is reported on the picked phone. Null means ServiceTitan had none.
 */
export function pickServiceTitanContact(
  contacts: readonly StoredServiceTitanContact[],
): PickedServiceTitanContact {
  const usable = contacts.filter((contact) => contact.value.trim() && !contact.optedOut);
  const phones = usable
    .map((contact, index) => ({ contact, index, rank: phoneRank(contact.type, contact.memo) }))
    .filter((row): row is { contact: StoredServiceTitanContact; index: number; rank: number } => row.rank != null)
    .sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      const primary = Number(isPrimary(a.contact.memo)) - Number(isPrimary(b.contact.memo));
      if (primary !== 0) return -primary;
      return a.index - b.index;
    });
  const emails = usable
    .map((contact, index) => ({ contact, index }))
    .filter((row) => isEmailType(row.contact.type) || row.contact.value.includes("@"))
    .sort((a, b) => {
      const primary = Number(isPrimary(a.contact.memo)) - Number(isPrimary(b.contact.memo));
      if (primary !== 0) return -primary;
      return a.index - b.index;
    });
  return {
    phone: phones[0]?.contact.value ?? null,
    email: emails[0]?.contact.value ?? null,
    doNotText: phones[0]?.contact.doNotText === true,
  };
}
