# First execution of the schema — what broke, and what was changed

**To:** Mason
**From:** CODE
**Date:** 5 August 2026
**Re:** README step 1 — "Run the SQL … Fix what breaks, then send Mason the diff."

Both files now apply cleanly and the behaviour they encode is under test. The
originals are vendored unmodified at `docs/handoff/01_schema/`, so the
authoritative diff is:

```bash
diff -u docs/handoff/01_schema/journeyman_projects_schema.sql db/001_schema.sql
diff -u docs/handoff/01_schema/journeyman_projects_seed.sql   db/002_seed.sql
```

This is the reading of it.

## Environment note

No PostgreSQL server and no Docker were available on this machine, so the SQL
was executed against **PGlite** — real PostgreSQL 16 compiled to WASM, running
in process. Same parser, same planner, same RLS implementation. Everything
below is an observed failure, not a static review.

One consequence worth knowing: every test connects as a role created with
`NOSUPERUSER NOBYPASSRLS` that does not own the tables. That is deliberate. A
superuser connection ignores RLS entirely — `FORCE ROW LEVEL SECURITY` closes
the table-owner exemption and never the superuser one — so a test suite run as
superuser would pass every isolation test while isolating nothing.

## The prediction that did not come true

> "The most likely failure is the `DO` block that applies RLS policies — it uses
> nested dollar-quoting (`$f$` inside `$$`) and that is where this kind of
> script usually breaks."

It parsed on the first run. Nested dollar quoting with *distinct* tags is legal
PostgreSQL; the tag has to match to close, so `$f$` inside `$$` is unambiguous.
The block applied all 25 policies correctly.

## Five defects

### FIX 1 — `pgcrypto` is required but unused (`001_schema.sql:20`)

`CREATE EXTENSION IF NOT EXISTS "pgcrypto"` was the very first statement to
fail. Nothing in either file uses pgcrypto: `gen_random_uuid()` has been in core
PostgreSQL since 13. Requiring it means a superuser `CREATE EXTENSION` at
provision time on every new tenant database for no functional benefit.

**Changed:** line removed. `citext` is genuinely used (`slug`, `email`) and stays.

### FIX 2 — the RLS predicate itself broke on a foreign `search_path` (`001_schema.sql:124`)

The important one.

```sql
CREATE FUNCTION tenant_enabled(t uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT t IS NOT NULL
     AND t = current_tenant()          -- unqualified
     AND projects.module_live(t, 'estimating')
     AND projects.module_live(t, 'projects')
$$;
```

`module_live` is schema-qualified; `current_tenant()` is not. Every RLS policy
in the schema routes through `tenant_enabled()`, so on any connection whose
`search_path` did not include `projects`, the security predicate raised

```
function current_tenant() does not exist
```

That is the whole module failing, not one route. It fails **closed** — an error,
never an open read — so it was never a leak. But a connection pooler default, a
migration tool, `pg_dump`, or a `search_path` set per role is enough to trigger
it, and the resulting error points at a function nobody called.

The same defect ran through `activate_tenant()`, `seed_cost_codes()`,
`activate_tenant_full()`, `freeze_baseline()`, and
`enforce_vendor_eligibility()`, all of which referenced tables unqualified.
Observed: `activate_tenant_full()` under `search_path=public` failed with
"function activate_tenant(uuid) does not exist".

**Changed:** every reference inside every function is schema-qualified. The
three predicate functions were moved above the policies that now call them.

Note what was *not* done: `SET search_path = projects, pg_temp` is **not** added
to `current_tenant`, `module_live`, or `tenant_enabled`. A SQL function with a
`SET` clause cannot be inlined by the planner, and `tenant_enabled()` is
evaluated per row by every policy in the schema — pinning it would be a
per-row function call on every query in the product. Full qualification gives
the same correctness and the same protection against a substituted function,
with no planner cost. The plpgsql functions (triggers, activation) *are* pinned,
because plpgsql is never inlined and the clause is free there.

### FIX 3 — a blank tenant id raised instead of reading empty (`001_schema.sql:98`, `:603`)

```sql
CREATE POLICY entitlement_read ON entitlements
  FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
```

`current_setting(..., missing_ok => true)` returns `NULL` when the GUC was never
set, but `''` when it was set to an empty string — and `''::uuid` raises rather
than returning `NULL`. So a request that set the tenant to a blank string got a
500 from the policy.

It landed on the worst two tables to lose: `entitlements` and `tenant_settings`
are the ones deliberately readable regardless of entitlement state, precisely so
a suspended customer can be shown *why* they are suspended rather than an empty
screen. `current_tenant()` already handles this with `NULLIF`; these two policies
were the only places that cast the raw GUC instead of calling it.

**Changed:** both policies now use `projects.current_tenant()`.

### FIX 4 — trigger and activation functions pinned and qualified

Covered under FIX 2 above; called out separately because it is a different
class of consequence. `enforce_vendor_eligibility()` is a *control* — it is what
stops an uninsured subcontractor being confirmed onto a site. A control that
silently depends on the writer's `search_path` is a control that stops working
for reasons invisible at the call site.

Now verified in `test/schemaHardening.test.ts`: blocks `confirmed` for a vendor
with missing documents, permits `proposed` (a PM pencilling someone in while a
renewal is in flight), permits `confirmed` for a compliant vendor, and blocks
again when one document expires.

### FIX 5 — dead variable in `activate_tenant_full()` (`002_seed.sql:141`)

```sql
INSERT INTO business_units (tenant_id, name) VALUES (p_tenant, p_unit_name)
ON CONFLICT (tenant_id, name) DO NOTHING
RETURNING id INTO bu;
```

`bu` was never read. It is also `NULL` on any re-run, because `ON CONFLICT DO
NOTHING` returns no row — so it would have been wrong exactly when someone
reached for it.

**Changed:** `RETURNING` and the `DECLARE` removed.

## One thing that is not a defect but needs saying

`activate_tenant_full()` is `SECURITY INVOKER` and every table it writes carries
a `WITH CHECK` of `tenant_enabled(tenant_id)`. So activation only succeeds when:

1. the `tenants` row exists, **and**
2. **both** entitlement rows exist and are live, **and**
3. the transaction already has `app.tenant_id` set to that tenant.

Get the order wrong and Postgres says *"new row violates row-level security
policy for table compliance_requirements"*, which is true and unhelpful. The
order is now written down once, in `src/db/activation.ts`, and the test fixture
provisions through it.

This is correct behaviour, not something to change — activation writing through
the same predicate that will serve the data back is a real guarantee. It just
needs to be in the runbook.

## Two inconsistencies flagged, not changed

1. **`tenant_settings` is writable by a suspended tenant.** Its policy has both
   `USING` and `WITH CHECK` on plain tenant match, while `entitlements` is
   `FOR SELECT` only. The comment says settings "follows the same rule as
   entitlements", but entitlements is read-only and settings is read-write. Not
   a security hole — it is the tenant's own row — but if the intent was
   read-only-while-suspended, the policy needs splitting. Your call.

2. **Addendum §1.1 vs README.** The addendum's last interpretation row says
   "This module can run for a tenant who never licenses estimating at all", and
   flags it as the row most worth correcting. The README's settled decisions say
   "Projects requires the estimating entitlement." The schema implements the
   README (`tenant_enabled` requires both), and `test/moduleBoundary.test.ts`
   asserts it. Noted only because the two documents shipped together.
