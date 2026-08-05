# Deploying

## Yes, this needs its own PostgreSQL

It cannot share CSR Tool's MySQL, and it cannot be ported to one. Three things
this module is built on have no MySQL equivalent:

| Depends on | Used for |
|---|---|
| Row-level security with `FORCE` | Tenant isolation and the entitlement gate — the guarantee, not a convenience |
| `security_invoker` views (PG 15+) | Every exception report and the cost position. Without it a view reads with its definer's rights and the whole reporting surface ignores RLS |
| `SET LOCAL` on a transaction-scoped GUC | The session contract. A pooled connection must not carry one request's tenant into the next |

**PostgreSQL 15 or later.** The app asserts this at boot and refuses to start
below it.

PGlite, which the test suite runs on, is a test harness — in-process, single
connection, no server. It is not a deployment target.

## The part that will bite you

A managed Postgres hands you one connection string and it belongs to a
superuser. **Point the application at that string and RLS is not degraded — it
is off.**

`FORCE ROW LEVEL SECURITY` does not save you. Force closes the table-*owner*
exemption; it never closes the superuser one. And nothing will look wrong:
every test in this repository still passes, because they run against a
correctly configured role. The first symptom is a customer seeing another
customer's projects.

So: **two roles, and the application gets the weaker one.**

| Role | Owns | Superuser | BYPASSRLS | Used for |
|---|---|---|---|---|
| `jp_owner` | the schema and every object | no | no | migrations only |
| `jp_app` | nothing | no | no | `DATABASE_URL` |

`assertDatabaseContract()` checks all of this at boot and refuses to start
otherwise. It is the last line of defence, not the mechanism.

## Provisioning, once per database

```bash
export ADMIN_DATABASE_URL='postgres://postgres:…@host:5432/railway'
export JP_OWNER_PASSWORD='…'
export JP_APP_PASSWORD='…'
pnpm db:provision
```

That creates both roles, applies `db/001_schema.sql` and `db/002_seed.sql` **as
`jp_owner`** so the owner owns the objects, applies the grants from
`db/003_roles.sql`, then verifies and prints the `DATABASE_URL` the app should
use. It is idempotent — re-run it after a migration to re-apply grants.

If the schema was already applied as a superuser, fix the ownership before
anything else:

```sql
REASSIGN OWNED BY postgres TO jp_owner;
```

## Application environment

```
DATABASE_URL=postgres://jp_app:…@host:5432/railway
PORT=3200
NODE_ENV=production
```

That is the whole list. Nothing else is read.

## Activating a tenant

Order matters and the database enforces it. `activate_tenant_full()` runs as
the caller under RLS and every table it writes has a `WITH CHECK` of
`tenant_enabled(tenant_id)`, so:

1. insert the `tenants` row
2. insert **both** entitlement rows — `estimating` and `projects` — in a live
   state
3. open a transaction with `app.tenant_id` set to that tenant
4. call `activate_tenant_full(tenant, 'Richmond')`

Out of order, Postgres says *"new row violates row-level security policy for
table compliance_requirements"*, which is true and tells an operator nothing.
`src/db/activation.ts` is the order written down; use it rather than calling
the function by hand.

Adding a second business unit afterwards, and turning on unit scoping:

```sql
INSERT INTO projects.business_units (tenant_id, name)
  VALUES ('<tenant>', 'Hampton-Newport News');
UPDATE projects.tenant_settings SET enforce_business_unit_scoping = true
  WHERE tenant_id = '<tenant>';
```

Both run inside a transaction with `app.tenant_id` set. Everything does.

## Backups

Standard `pg_dump`, with one caveat worth knowing before you need it: a restore
recreates objects owned by whoever runs the restore. Restore as `jp_owner`, or
`REASSIGN OWNED` afterwards and re-run `pnpm db:provision` to reapply grants.
A restore that leaves the app role owning the tables is the same failure as
deploying with a superuser string.

## Still to decide before first customer

Object storage for compliance documents, and an email provider for expiry
notices and portal invitations. Neither blocks phases 1–3. See
[`OPEN_ITEMS.md`](OPEN_ITEMS.md) §7–8.
