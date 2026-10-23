# Read-only source integrations

## Ownership
ServiceTitan dispatch snapshots are separate from native project activities. A refresh replaces a complete job snapshot, including inactive appointments and assignment flags, without changing the project plan. Technician identity remains the source technician ID. Mapping those IDs onto native planning resources and dispatch-versus-plan conflict reporting are subsequent work.

The PO application's GET /api/state feed is filtered to revision, mode, lastSync and source records. Amounts remain signed integer cents. OAuth configuration, personnel directory, audit history and matching decisions are excluded. Proposed and confirmed matches are not currently imported. Purchases remain an unallocated inbox and have no effect on actual/committed costs. This feed is not the full QBO ledger and is not a subcontractor directory.

## Connection configuration
Production server startup accepts these server-only variables. The ordinary `pnpm dev` preview uses synthetic fixtures and ignores live connector credentials.

ServiceTitan: PM_ST_TENANT_ID (PM account UUID), PM_ST_EXTERNAL_SYSTEM_ID (that account's active external system UUID), ST_ENV (production/integration), ST_TENANT_ID (numeric ST account ID), ST_CLIENT_ID, ST_CLIENT_SECRET, ST_APP_KEY.

PO app: PM_PO_TENANT_ID (PM account UUID), PM_PO_EXTERNAL_SYSTEM_ID (active source UUID), PO_APP_ORIGIN (HTTPS origin only), PO_APP_USER, PO_APP_PASSWORD. Reuse the existing PO application's server authentication through secret configuration; never copy QBO refresh tokens into this application. The initial deployment supports one explicitly bound account per connector.

Apply migration 009 through the established provisioning/migration process. Do not run the entire schema on an existing database as an incremental migration. Complete production staff authentication before exposing production records. The production server still has the existing MemoryStaffSessions seam; it is not a deployable sign-in solution.

## API
All paths are under /api/v1/projects and require a staff session.

- GET /projects/:id/jobs/:jobId/dispatch: configured flag and last snapshot.
- POST /projects/:id/jobs/:jobId/dispatch/refresh: manager/owner/PM refresh of linked source job.
- GET /reconciliation-inbox: last snapshot, restricted to margin viewers with account-wide visibility.
- POST /reconciliation-inbox/refresh: also requires export_cost_data.

Refreshes authenticate before fetching, release the transaction during network work, and recheck the session, account entitlement, staff role and resource ownership before saving. Snapshots use forced tenant RLS and composite tenant foreign keys. Older in-flight reads cannot overwrite newer snapshots. PO source revision regressions are rejected. Failed refreshes return a generic 502 and preserve the prior snapshot. Source sync time is displayed separately from the PM read time. No scheduler or automatic refresh is configured.

## Local review
Run PORT=3211 with pnpm dev (PowerShell: $env:PORT='3211'; pnpm dev).
Sign in as owner@demo.test, tenant demo, access token local-dev.
Choose Whitfield, then Job links → Demo multi-day job → Dispatch → Refresh. It returns three synthetic daily appointments, each assigned to Alex and Taylor. Purchase inbox → Refresh returns one synthetic charge and its PO reference. Nothing in this preview reads production data.

## Validation
Adapter tests cover allowlisting, signed cents, source rejection and configuration stripping. Route tests cover separate planning storage, cancellation replacement, failure retention, tenant and role checks, revocation during reads, connection changes, source revision regression and database isolation. Existing foreign-ID coverage includes the new routes. The live PO adapter probe prints only counts and timestamps.
