# Staging

Staging is a second Railway environment of this same repository. It uses the same `railway.json` pre-deploy (`node dist/provision.js`). It is not a separate codebase. The settings below are the owner's actions in Railway. This pull request does not set them, and it does not turn backups on.

## Variables

| Variable | Staging |
|---|---|
| `NODE_ENV` | `staging` |
| Postgres | A new database. `DATABASE_URL` must not be the production database. |
| `ST_ENV` | `integration`. That is `api-integration.servicetitan.io`, not the production ServiceTitan host. |
| QuickBooks | The sandbox company and the sandbox bridge key. |
| `PM_ST_WRITES_ENABLED` | Leave unset. |
| `SEED_DEMO` | Allowed here. Production already refuses it. |
| `DEV_LOGIN` | Only if this environment is not pointed at a staging Command Center. |
| `CC_SSO_URL` | The staging Command Center, when that exists. |

`ST_ENV=integration` is what selects the integration host. The other ServiceTitan values (`PM_ST_TENANT_ID`, `PM_ST_EXTERNAL_SYSTEM_ID`, `ST_TENANT_ID`, `ST_CLIENT_ID`, `ST_CLIENT_SECRET`, `ST_APP_KEY`) are the staging app's own credentials, not production's. See `docs/SOURCE_INTEGRATIONS.md`.

The QuickBooks bridge is the same variables as production (`PM_QBO_TENANT_ID`, `PM_ACCOUNTING_KEY`, `PO_APP_ORIGIN`, `PO_APP_USER`, `PO_APP_PASSWORD`), pointed at the sandbox company and the sandbox key. See `docs/QUICKBOOKS_PAYABLES.md`.

Leaving `PM_ST_WRITES_ENABLED` unset keeps ServiceTitan writes off. Do not copy the production value.

`SEED_DEMO=true` rebuilds the demo account on deploy. Production will not do that. Turn it off again after a seed, or the next deploy rebuilds the account.

Sign-in with Command Center needs `CC_SSO_URL`, `CC_SSO_CLIENT_ID`, `CC_SSO_CLIENT_SECRET`, and `SSO_TENANT_ID` (or `PM_PORTFOLIO_TENANT_ID`). Use the staging Command Center. If that app does not exist yet, `DEV_LOGIN` and `DEV_LOGIN_TOKEN` are the way in, and `NODE_ENV` must stay `staging`. Do not turn `DEV_LOGIN` on when this environment is already pointed at a staging Command Center.

`ALERT_WEBHOOK_URL` is optional on every environment. Leave it unset and unhandled errors are only written to the log.

## Restore drill

This is a Railway action for the owner. It is not a script in this repository. A checker can live at `scripts/restoreCheck.ts` later. It is not part of this change.

The drill cannot pass until Railway backups are turned on for the production database. `docs/PRODUCTION.md` records that a backup was attempted and was not created. Turn backups on first.

Then:

1. Dump the production database in custom format (`pg_dump --format=custom`).
2. Restore that dump into the empty staging Postgres as `jp_owner` (`pg_restore`). Staging `DATABASE_URL` stays on that new database. Do not restore over production.
3. Run `node dist/provision.js` so migrations and grants that landed after the dump are applied. A deploy of this service does that in the Railway pre-deploy step.
4. Boot the app. Startup runs `assertDatabaseContract()`. The drill requires that check to pass. If it fails, the process exits and the drill has not passed.
5. Compare counts of `projects.projects`, `projects.draws`, `projects.vendor_bills`, and `projects.staff` with production.
6. Open one project with staging sign-in.

While the app boots, staging must be on the integration ServiceTitan host and the sandbox QuickBooks key. That is what keeps the drill from posting to production. Run the drill again after each migration batch.
