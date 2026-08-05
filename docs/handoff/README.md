# Journeyman Projects — Build Handoff

**To:** CODE
**From:** Mason Holloway
**Date:** August 2026
**Module:** Journeyman Projects (licensed module, Journeyman Systems platform)

---

## What this is

A separately licensed project management module for subcontractor-dependent
remodel work. Sold as a SKU, switched on by subscription, requires the
estimating entitlement. Mr. Handyman of Richmond & Hampton–Newport News is
tenant one — a customer of the module, not a special case in it.

There is no Mr. Handyman-specific code path anywhere in this package. If you
find yourself writing one, stop and ask.

---

## Read in this order

| # | File | What it is |
|---|------|------------|
| 1 | `02_spec/Journeyman_Projects_Module_Addendum.docx` | Boundary rules, entitlement model, why the architecture is shaped this way. **Read Section 1.2 before anything else.** |
| 2 | `01_schema/journeyman_projects_schema.sql` | Tables, views, triggers, row-level security |
| 3 | `01_schema/journeyman_projects_seed.sql` | Cost code library and tenant activation |
| 4 | `02_spec/Journeyman_Projects_API_Contract.docx` | Route surface, payloads, error semantics, authorization |
| 5 | `03_reference/project_console_mock.html` | Visual reference for the main project screen. Open in a browser; the project switcher and the draw exception are interactive. |

---

## Do this first

### 1. Run the SQL

```bash
createdb jp_scratch
psql jp_scratch -f 01_schema/journeyman_projects_schema.sql
psql jp_scratch -f 01_schema/journeyman_projects_seed.sql
```

**Requires PostgreSQL 15 or later** — the views use `security_invoker`, which
does not exist before 15.

**Neither file has ever been executed.** They were written and statically
reviewed only. Expect errors on the first run. The most likely failure is the
`DO` block that applies RLS policies — it uses nested dollar-quoting (`$f$`
inside `$$`) and that is where this kind of script usually breaks.

Fix what breaks, then send Mason the diff. Do not work around a schema problem
in application code.

### 2. Write two tests before any handler

**Cross-tenant isolation.** Log in as tenant A. Request every route with
tenant B's identifiers substituted into every path parameter and body field.
Every one must return 404 — not 403, which would confirm the row exists.

**Module boundary.** Drop the estimating module's schema entirely from a test
database and run the full Projects test suite. Everything must pass. If
anything fails, a dependency has crept in that the boundary was supposed to
prevent.

Both run in CI on every commit. Written after the code, these tests assert
what the code does instead of what the rule is.

### 3. Verify the session contract

Every request opens a transaction and sets the tenant:

```sql
BEGIN;
SET LOCAL app.tenant_id = '<tenant uuid from session>';
-- handler runs here
COMMIT;
```

`SET LOCAL`, never plain `SET`. With a pooled connection, plain `SET` leaks the
tenant to whichever request borrows that connection next — a cross-tenant leak
with no code that looks wrong anywhere.

Add a startup assertion that the application role does not have `BYPASSRLS` and
does not own the tables:

```sql
SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user;
```

---

## Rules that are not negotiable

1. **No foreign key crosses into the estimating schema, and no query reaches
   into it.** The estimate arrives as a versioned immutable snapshot at
   `POST /estimate-imports`. If a field you need is missing, the contract
   version changes — the handler does not reach across.

2. **The module never writes to any external system.** ServiceTitan,
   QuickBooks, anything. Read-only in every configuration. This is what keeps
   the module from ever being blamed for corrupting a customer's books.

3. **The module never issues a customer invoice.** Revenue belongs to the
   customer's own system of record.

4. **Entitlement is checked inside the RLS predicate**, not only in
   middleware. A lapsed tenant returns zero rows even from a background job
   that never heard of subscriptions. The one exception is the `entitlements`
   and `tenant_settings` tables themselves, which are tenant-isolated but not
   entitlement-gated — otherwise a suspended customer cannot be shown why.

5. **Portal serializers are explicit allow-lists.** Never start from the full
   record and delete fields. See API Contract Section 4.1 for what must never
   appear in a portal response.

6. **Build the manual adapter before the ServiceTitan adapter**, so graceful
   degradation is the default path rather than the fallback nobody tested.

---

## Build order

| Phase | Scope |
|-------|-------|
| 1 | Session middleware, projects, stage gates |
| 2 | Budget, purchase orders, vendor bills, cost position |
| 3 | Vendors, compliance documents, eligibility, expiry sweep |
| 4 | Draws, exception views, manual adapter |
| 5 | Scheduling, permits, change orders |
| 6 | Subcontractor portal |
| 7 | Field PWA — daily logs, photos, offline queue |

Phases 1–4 are independently useful and are the minimum that justifies
building rather than buying. If phase 5 has not started within eight weeks of
phase 4 closing, we buy the rest — that is a decision already made, not a
threat.

---

## Decisions already settled — do not reopen

- Projects requires the estimating entitlement. Licensing dependency only;
  the architectural boundary does not relax.
- Subcontractor portal seats are free and unlimited. No seat counting.
- No active project limit.
- Metering is per business unit. No usage counters, no rollup job, no billing
  events — billing owns the number, Projects only reads it.
- Business unit scoping is enforced in the API, not RLS. It is a visibility
  preference inside one tenant, not a boundary between tenants.

---

## Still open — ask Mason before you need them

1. Change order approval threshold — tenant setting or hardcoded default?
2. Weekly exception report — per business unit or per tenant?
3. Data export scope and retention window on cancellation.

Your call, report back: file storage provider and signed URL lifetime; email
and SMS provider for portal invitations and expiry notices.

---

## Not included, deliberately

Buy-path evaluation documents, the Mr. Handyman internal SOP, and the
subcontractor onboarding packet are operational artifacts for the franchise,
not build inputs. Ask if you want the SOP as context for why a rule exists —
it explains the operating model the module encodes.
