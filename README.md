# Journeyman Projects

A separately licensed project management module for the Journeyman Systems
platform. Sold as its own SKU, switched on by subscription, requires the
estimating entitlement.

There is no customer-specific code path anywhere in this repository. If you find
yourself writing one, stop and ask.

Build inputs are in [`docs/handoff/`](docs/handoff/) — read
`02_spec/Journeyman_Projects_Module_Addendum.docx` §1.2 first.

## Status

| Phase | Scope | State |
|-------|-------|-------|
| 1 | Session middleware, projects, stage gates | **built** |
| 2 | Budget, purchase orders, vendor bills, cost position | **built** |
| 3 | Vendors, compliance documents, eligibility, expiry sweep | routes built; nightly expiry sweep and notifications not started |
| 4 | Draws, exception views, manual adapter | **built** |
| 5 | Scheduling, permits, change orders | **built** |
| 6 | Subcontractor portal | not started |
| 7 | Field PWA | not started |
| — | Project console (the reference mock, on live data) | **built** |

Read [`docs/SCHEMA_FIXES.md`](docs/SCHEMA_FIXES.md) for what the first execution
of the schema found, and [`docs/OPEN_ITEMS.md`](docs/OPEN_ITEMS.md) for the
decisions still outstanding.

## Running it

```bash
pnpm install
pnpm dev
```

Then open http://localhost:3200 and sign in as `owner@demo.test` on tenant slug
`demo`.

No database to install. `pnpm dev` boots a real PostgreSQL in process (PGlite),
applies the schema, seeds a demo account with three projects, and serves the
console. Same app, same handlers, same row-level security — the only difference
from production is where the Postgres lives and that the data goes away when you
stop it.

Worth signing in as the other roles, because they get a different console:
`pm@demo.test`, `office@demo.test`, `books@demo.test`.

```bash
pnpm test
```

The test suite needs no database. It boots a real PostgreSQL 16 in process
(PGlite), applies `db/001_schema.sql` and `db/002_seed.sql`, and connects as a
role with `NOSUPERUSER NOBYPASSRLS` that does not own the tables — the only
configuration in which RLS actually engages.

`pnpm db:apply --dry-run` applies the same SQL to a scratch in-process database,
which is the fast way to check a schema edit before it touches anything.

## Deploying

This needs its own PostgreSQL 15+. It cannot share CSR Tool's MySQL and cannot
be ported to one — RLS, `security_invoker` views and `SET LOCAL` have no
equivalent there.

It also needs **two** database roles. A managed Postgres gives you one
connection string and it is a superuser; point the app at it and RLS is not
degraded, it is off, and nothing looks wrong until a customer sees another
customer's projects. `pnpm db:provision` sets this up correctly and verifies it.

Read [`docs/DEPLOY.md`](docs/DEPLOY.md) before the first deploy.

## The rules this codebase is shaped by

These are load-bearing. Each one has a test that fails if it stops being true.

**1. No foreign key crosses into the estimating schema, and no query reaches
into it.** The estimate arrives as a versioned immutable snapshot at
`POST /estimate-imports`. If a field is missing, the contract version changes —
the handler does not reach across.
→ `test/moduleBoundary.test.ts`

**2. Tenant isolation is a database guarantee.** Every tenant-scoped table has
`tenant_id`, RLS enabled and forced, and one policy. A handler never writes a
tenancy `WHERE` clause, and cross-tenant reads come back `404`, never `403` —
`403` confirms the row exists.
→ `test/crossTenantIsolation.test.ts`

**3. Entitlement lives inside the RLS predicate, not only in middleware.** A
lapsed tenant returns zero rows from a background job that never heard of
subscriptions. The exceptions are `entitlements` and `tenant_settings`, which
are tenant-isolated but not entitlement-gated — otherwise a suspended customer
cannot be shown why.
→ `test/entitlements.test.ts`

**4. Every request opens a transaction and sets the tenant with `SET LOCAL`.**
Never a plain `SET`: on a pooled connection that leaks the tenant to whichever
request borrows it next, and no code anywhere looks wrong.
→ `src/db/database.ts`, and `assertDatabaseContract()` refuses to boot if the
application role is a superuser, has `BYPASSRLS`, owns the tables, or if any
table lost its policy.

**5. The module never writes to any external system, and never issues a
customer invoice.** Read-only against ServiceTitan, QuickBooks, anything, in
every configuration. Revenue belongs to the customer's own system of record.

**6. Two route trees, separately authenticated.** `/api/v1/projects/…` for
staff, `/api/v1/portal/…` for subcontractors — two resolvers, two session
stores, no shared code path. A single `resolveUser()` serving both is the shape
of the bug that lets a portal token reach a staff route, and it reads as tidy
refactoring. The portal tree is deliberately absent until phase 6 rather than
stubbed next to the staff resolver.

**7. Portal serializers will be explicit allow-lists.** Never start from the
full record and delete fields.

## Layout

```
db/                     001_schema.sql, 002_seed.sql, 003_roles.sql, 004_change_orders.sql
src/
  db/
    database.ts         the session contract: withTenant / withoutTenant
    pgDatabase.ts       node-postgres implementation (dev, production)
    assertions.ts       startup assertions; the server will not boot without them
    activation.ts       tenant provisioning, in the only order that works
    splitSql.ts         statement splitter that understands dollar quoting
  domain/
    estimateContract.ts the module boundary in code — payload in, budget out
    stages.ts           stage order and what gates block an advance
  http/
    errors.ts           §1.4 error codes
    envelope.ts         §1.3 response envelope, database errors mapped
    capabilities.ts     §2.1 role table and §2.2 unit filter, in one place
    staffSession.ts     staff identity; must not be imported by the portal tree
  routes/
  adapters/
    externalSystem.ts   the revenue system of record; note there is no write method
client/                 the console — the reference mock, on live data. No build step.
scripts/
  devServer.ts          pnpm dev: in-process Postgres, demo data, console
  provisionRoles.ts     one-time database provisioning; see docs/DEPLOY.md
test/
  crossTenantIsolation.test.ts   mandatory test 1
  moduleBoundary.test.ts         mandatory test 2
  schemaHardening.test.ts        the schema's own guarantees
  entitlements.test.ts           §5 lifecycle, startup assertions
  phase1.test.ts                 behaviour
docs/
```

## A note on the two mandatory tests

Both were written before the handlers, as instructed. `crossTenantIsolation`
walks the live Express router and fails the build if a route takes an
identifier and is not exercised with a foreign one — so adding a route without
thinking about tenancy breaks CI rather than shipping.

`moduleBoundary` could not be run literally. "Drop the estimating schema and run
the suite" proves nothing when the schema was never created — a test that cannot
fail reads as coverage. It creates a decoy `estimating` schema, populates it,
drops it, and runs the full flow against a database where a reach across would
have resolved a moment earlier. Plus static assertions that no source file names
the estimating schema in SQL and no foreign key points out of `projects`.
