# Open items

Things the build hit that need a decision, and the two the handoff assigned to
CODE with "your call, report back".

---

## Decide from the console

The console is the reference mock rendering live data, at `pnpm dev`. Three
places where the mock made a decision that the product now has to make
deliberately, and the console is the fastest way to have an opinion:

**A. The mock names ServiceTitan; the product cannot.** No field service
platform may appear in the data model, so the console reads
`external_systems.display_name`. A ServiceTitan tenant sees exactly the mock's
wording. The demo tenant is on the manual adapter, so it reads "Manual entry" —
which is honest but reads oddly in "no invoice recorded in Manual entry".
Worth deciding whether a manual tenant should see a generic phrase instead.

**B. Blocking now is assembled from four sources.** Compliance, uninvoiced
draws, budget overruns, overdue permit milestones, and a missing daily log. The
mock hand-picked which of those to show and in what order; the console shows all
of them, worst first. Look at the Whitfield project and say whether that is the
right list — five items is either "the day's work" or "noise", and only you
know which.

**C. The gate strip shows outstanding checklist items on the open gate.** The
mock did not. It is the one place the console adds information the mock did not
have, because gate approval is blocked on the checklist and the mock had no way
to show why.

---

## A gap that shipped a broken migration

`pnpm db:apply --dry-run` applied the schema **as a superuser**, and a superuser
bypasses row-level security entirely. So a migration that writes data into a
tenant-scoped table passed the dry run and failed on the first real deployment
against the `WITH CHECK` predicate. That is exactly what happened with
`db/005_draw_schedule.sql`: green locally, dead in production.

A check that cannot see the most likely production failure is worse than no
check, because it gets trusted.

The dry run now applies as a `NOSUPERUSER NOBYPASSRLS` owner, matching how
`src/provision.ts` applies it for real, and reproduces that failure. Extensions
are still installed as superuser first, exactly as provisioning does.

**The test harness has the same shape and has not been changed.**
`PgliteDatabase.create()` applies the schema as superuser and only then switches
to `jp_app` for queries — which is right for testing handlers, and blind to
migration DML in the same way. Worth aligning if migrations start carrying data
regularly.

## A pattern worth deciding on

Three times now a value a caller supplied has gone nowhere with nobody told:

1. A purchase order raised against a cost code budgeted under a different cost
   type — money absent from the cost position. Now warned.
2. A change order carrying `cost_amount` with no lines — same. Now warned.
3. `scheduled_start` and `scheduled_end` sent to `POST /projects` were accepted
   and discarded, because zod strips unknown keys silently. Now accepted.

The third is the general case: **every request schema in the module silently
drops keys it does not recognise.** A typo in a field name is indistinguishable
from omitting it. `.strict()` on the schemas turns that into a 400 naming the
unexpected field.

Not applied unilaterally — it would reject any client sending extra fields, and
whether that is right depends on who ends up calling this. Worth ten minutes of
your opinion.

## Found while deploying

### `projects.tenants` has no row-level security

Every other tenant-scoped table has RLS enabled and forced. `tenants` does not,
so the application role can read every tenant's `slug` and `display_name` —
not project data, but the customer list.

It is that way for a reason: something has to resolve an identifier before a
session exists, which is exactly what the dev sign-in does when it turns a
tenant slug into an id. Once staff sessions come from the platform, the tenant
id arrives with the session and nothing needs to look it up unauthenticated.

Recommended, once item 0 below is settled:

```sql
ALTER TABLE projects.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects.tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON projects.tenants
  FOR SELECT USING (id = projects.current_tenant());
```

Not applied unilaterally: it is a schema change, it would break the only
sign-in that currently exists, and the schema is yours. `cost_code_library` is
the other table without RLS and that one is correct — it is product content,
not customer data.

---

## Blocking a real deployment

### 0. There is no staff sign-in — only the dev one

The platform owns staff identity, and that integration does not exist yet. The
only way in is `POST /api/v1/dev/session`, which mints a session from an email
with no password, is mounted only when `DEV_LOGIN=true`, and is refused
outright when `NODE_ENV=production`.

So today: a **staging** deployment works (set `NODE_ENV=staging`, `DEV_LOGIN=true`),
and a **production** deployment has no way in at all.

That is the right way round — an unusable deployment beats an open one — but it
has to close before a paying tenant. Three options, in order of how much they
cost:

1. **Wire the platform session.** `StaffSessionStore` is a one-method interface
   (`resolve(req) → { tenantId, staffId } | null`); a platform resolver drops in
   beside `MemoryStaffSessions` and nothing else changes. This is the intended
   answer and needs the platform's session format.
2. **Email magic links.** Self-contained, no platform dependency, and reuses the
   notification provider that phase 3's expiry sweep needs anyway. Roughly a
   week including the token store and rate limiting.
3. **Password auth on `staff`.** The table has no `password_hash` column and
   deliberately so — `vendor_portal_users` has one because the portal is a
   separate identity domain. Adding one to staff duplicates identity the
   platform is supposed to own, and I would not do it without you saying so.

Needed from you: whether Projects authenticates staff through the platform, or
stands alone. It changes what gets built, not just how.

---

## Needs Mason

### 1. Nothing maps a gate to a stage — blocking `POST /projects/:id/stage`

`POST /projects/:id/stage` returns `409 gate_not_satisfied` "if the gate is
open" (API Contract §3.1). But `project_stage` is a fixed enum of six forward
stages, `gate_templates.gate_number` is tenant configuration ranging 0–9, and
no column connects them.

**Implemented for now:** leaving the stage at ordinal N requires every gate
numbered N or lower to be approved. Against the shipped five gates that
reproduces the intended chain exactly — gate 0 *Qualification and handoff* to
leave `handoff`, gate 1 *Preconstruction* to leave `precon`, and so on — and it
degrades sanely for a tenant who configures fewer gates.

**Where it is wrong:** a tenant who configures more than six gates gets gates 6
and up that never block anything. Since "five gates is the shipped default, not
a constraint" is explicit, that case is real.

**Recommended fix:** add `gate_templates.advances_to_stage project_stage`, so
the mapping is tenant data rather than arithmetic on the gate number. One
nullable column; a null means the gate is advisory and blocks nothing.

Code: `src/domain/stages.ts`.

### 2. There is no draw template table - RESOLVED, built

§3.1 says project creation seeds "a draw schedule from the tenant default". No
such table exists, and inventing one is the kind of decision the README says to
stop and ask about.

**Answered August 2026:** 30/30/30/10, the final 10% being retainage for punch
list and closeout. `db/005_draw_schedule.sql` adds `draw_templates` per tenant
seeded with that default, plus `draws.is_retainage`. Project creation seeds the
schedule and reports how many it made.

### 3. Change order approval threshold — DECIDED, needs your ratification

README open item 1 asked: tenant setting, or hardcoded default?

**Built as a tenant setting**, `tenant_settings.change_order_approval_threshold`,
default 5000.00. At or below it a project manager may record customer approval;
above it, owner or manager only — which is what the capability table already
implied by separating `approve_change_order_over_threshold` from
`send_change_order`.

Reasoning: every other limit in this schema is per tenant — gate count, which
gate freezes the baseline, compliance requirements, warn days, the cost code
list. A hardcoded number would have been the only thing in the module a
customer could not change. **The default of 5000 is a placeholder, not a
recommendation.**

### 3b. `change_order_lines` — a new table, needs your sign-off

`db/004_change_orders.sql` is the first file that ADDS to the data model rather
than correcting it. Two additions, both explained in the file.

The load-bearing one: `change_orders.cost_amount` is a single number with no
cost code on it, so an approved change order's cost had nowhere to go.
`v_cost_position` matches on `(cost_code, cost_type)`; a scalar matches nothing.

It also made a sentence the module already says untrue. Editing a budget after
the freeze gate returns *"changes after the freeze belong on a change order"* —
which is a dead end if a change order cannot reach the budget. Approving one is
now the only sanctioned way to move a frozen baseline, and it needs lines to do
it with. `cost_amount` is kept and derived from the lines, so nothing reading it
today breaks.

Drop the file and the feature degrades to what the schema originally described;
nothing else depends on it.

### 4. Weekly exception report — per business unit or per tenant (README open item 2)

Not reached — background jobs are phase 3+. Note that §5 of the API Contract
says "one email per business unit" while the README asks the question as still
open. The API Contract's answer is the one the code will follow unless told
otherwise.

### 5. `tenant_settings` is writable while suspended

See `docs/SCHEMA_FIXES.md`, final section. A policy question, not a bug.

---

## CODE's call, reported back

### 6. Database for development and CI — PGlite in process, real Postgres in deploy

No PostgreSQL and no Docker were available on this machine.

**Chosen:** [PGlite](https://pglite.dev) — actual PostgreSQL 16 compiled to
WASM, running in the Node process — for tests and CI. Real parser, real
planner, real RLS. `src/db/pgDatabase.ts` (node-postgres) is what runs against a
real server in dev and production; both implement the same three-method
`Database` interface, and the handlers only ever see the interface.

**Why this rather than a Postgres container in CI:** the test suite boots a
fresh database per file in about half a second, so the isolation suite can
afford to be exhaustive rather than shared-fixture. And CI needs no service
container, which means the boundary test — drop a schema, run everything —
is a normal test rather than an ops exercise.

**What it does not cover:** connection pooling behaviour, `pg_stat` and lock
contention, extension availability on the target host, and anything version
specific past 16. `pnpm db:apply` runs the same SQL against a real
`DATABASE_URL` and should be part of the first deploy to staging.

### 7. File storage provider and signed URL lifetime (README, API Contract §7 item 3)

Not needed until phase 3 (`POST /vendors/:id/documents`). Recommendation when it
lands, stated now so it can be argued with early:

- **S3-compatible object storage** behind a `FileStore` interface with a single
  implementation to start. `vendor_documents.file_key` is already an opaque key
  and never a URL, which is the part that matters — the schema does not care who
  stores the bytes.
- **Signed PUT: 15 minutes.** Long enough for a subcontractor to photograph a
  certificate and upload it over a bad connection; short enough that a URL
  copied out of a browser history is dead.
- **Signed GET: 5 minutes, issued per view, never embedded in an email.** These
  are certificates of insurance with policy numbers on them.
- The file must never transit the API (§3.4 already says this). Worth restating
  because a 40 MB scanned PDF through an Express body parser is how the module
  first falls over.

### 8. Email and SMS provider for portal invitations and expiry notices (§7 item 4)

Not needed until phase 3 (expiry sweep) and phase 6 (portal invitations).
Recommendation: put both behind a `Notifier` interface now and pick the vendor
when phase 3 starts. The reason to decide late is in the Addendum §6.2 — portal
password resets are projected to be the dominant support cost of this SKU, so
the deliverability question is a pricing input, not just a plumbing choice, and
it should be answered with the margin model open.

**One thing that should be decided early regardless of vendor:** whether expiry
notices go to the subcontractor, to office staff, or both. `compliance_requirements.warn_days`
is per tenant per document kind, but there is no column for who gets told. That
is a schema question and it is cheaper now than after the first customer.

### 9. ServiceTitan API tier — invoice lookback (§7 item 6, Mason)

Not reached. Per the README, the manual adapter is built first and the
ServiceTitan adapter after, so this does not block anything until phase 4.
`external_systems.verify_invoices` already defaults to `false`, and
`POST /draws/:id/external-invoice` is specified to return
`verification_available: false` so the client hides an action that cannot work.
