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

### 2. There is no draw template table

§3.1 says project creation seeds "a draw schedule from the tenant default". No
such table exists, and inventing one is the kind of decision the README says to
stop and ask about.

**Implemented for now:** create seeds gates and budget lines and reports
`draws_created: 0`. `POST /projects/:id/draws` ("create or replace the
schedule", §3.6) is the explicit route and lands in phase 4.

**Options:** a `draw_templates` table mirroring `gate_templates`; or a
percentage schedule on `tenant_settings` (e.g. 30/30/30/10 against contract
value); or leave draws explicit per project, which for remodel work with
irregular milestones may be the honest answer.

### 3. Change order approval threshold (README open item 1)

Not reached — change orders are phase 5. Flagged so it does not surprise anyone:
the capability table already distinguishes `approve_change_order_over_threshold`
from `send_change_order`, so the threshold needs a home before that phase starts.
`tenant_settings` is the natural place.

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
