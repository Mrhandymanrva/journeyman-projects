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

## Railway, start to finish

This is the sequence that actually worked, not the one that looked like it
would. The difference matters: a managed Postgres has **no public endpoint**
unless you enable a TCP proxy, so nothing you run from a laptop can reach it.
Provisioning has to happen inside the deployment.

**1. Add a PostgreSQL service** to the same Railway project.

**2. Set these on the app service.** `${{Postgres.*}}` are service references,
not typed-in strings, so they survive a password rotation:

```
ADMIN_DATABASE_URL = ${{Postgres.DATABASE_URL}}
JP_OWNER_PASSWORD  = <long random string>
JP_APP_PASSWORD    = <long random string>
DATABASE_URL       = postgresql://jp_app:<JP_APP_PASSWORD>@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/${{Postgres.PGDATABASE}}
```

`ADMIN_DATABASE_URL` is used only by the pre-deploy step. The app itself only
ever reads `DATABASE_URL`, which is `jp_app` — a role with no superuser, no
BYPASSRLS, and no ownership of anything.

**3. Deploy.** `railway.json` runs `node dist/provision.js` before the app
starts. It creates both roles, installs `citext`, applies the schema as
`jp_owner`, applies the grants, and verifies the result. It is idempotent, so
it runs on every deploy and is also how grants reach a table a later migration
adds.

A healthy first deploy logs:

```
connected as postgres (superuser)
role jp_owner ready (created)
role jp_app ready (created)
extension citext ready
applied db/001_schema.sql (91/91 statements)
applied db/002_seed.sql (7/7 statements)
grants applied

verification (every value must be false or 0):
  ok    jp_app is superuser = false
  ok    jp_app has BYPASSRLS = false
  ok    tables owned by jp_app = 0
  ok    tenant-scoped tables without FORCE RLS = 0
  ok    tenant-scoped tables missing entirely = 0
```

If any check fails the deploy stops there. That is the point of them.

### Getting into the console on a staging instance

There is no platform identity integration yet, so the only sign-in that exists
mints a staff session from an email address. Three things gate it, and all
three are required:

```
NODE_ENV        = staging          # anything other than "production"
DEV_LOGIN       = true
DEV_LOGIN_TOKEN = <long random string>
```

Without `DEV_LOGIN_TOKEN` the app refuses to start, because dev login without a
shared secret means whoever finds the hostname is signed in as an owner. With
it, the hostname alone is not enough. It is a shared secret, not
authentication — see `docs/OPEN_ITEMS.md` §0 for the three ways that closes.

`NODE_ENV=production` makes the app refuse to mount dev sign-in at all, so a
production deployment currently has **no way in**. That is deliberate: an
unusable deployment beats an open one.

### Demo data

Same constraint — no public endpoint, nothing to connect to from outside. Set
`SEED_DEMO=true` and redeploy; the pre-deploy step rebuilds the demo account
after provisioning passes. Refused under `NODE_ENV=production`, because demo
tenants and customer data must never share a database.

Turn it off again once seeded, or every deploy rebuilds it and discards
anything you did in the console.

## Provisioning from outside, when the host does expose the database

Only possible where there is a reachable endpoint — a self-hosted Postgres, or
a managed one with a TCP proxy switched on. Otherwise use the pre-deploy step
above.

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
DATABASE_URL     postgres://jp_app:…@host:5432/railway     required
PORT             3200                                      default
NODE_ENV         production | staging | development         default development
DEV_LOGIN        true | false                               default false
DEV_LOGIN_TOKEN  <shared secret>                            required if DEV_LOGIN=true
```

Read by the pre-deploy provisioner only, never by the app:

```
ADMIN_DATABASE_URL   a superuser connection
JP_OWNER_PASSWORD
JP_APP_PASSWORD
SEED_DEMO            true rebuilds the demo account; refused in production
```

That is the whole list.

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
