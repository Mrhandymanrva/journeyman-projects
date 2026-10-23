# Project planning increment

## Available now

- Project job links: several external jobs per project, with an explicitly selected system and stable job ID. Existing nonempty job references with a system are copied by migration 008. References without a configured system remain in the original project fields for manual resolution.
- Scheduling resources: employees, internal crews and subcontractor crews independent of staff login accounts. Subcontractor resources require a vendor.
- Activities: phase label, optional job link, multiple resources, date window, status and multiple finish-to-start predecessors with waiting days.
- Two-week lookahead: selected project or all visible projects; editable start date, overlap warnings, predecessor readiness and compliance warnings. The full project activity list remains below it for work outside the selected dates.
- Dependency edits are serialized per project and reject cycles or references to other projects. Composite database foreign keys enforce tenant/project ownership of new relationships.
- Confirmed and in-progress resource assignments enforce subcontractor eligibility in database triggers.

Date windows are inclusive. A predecessor ending September 16 with zero waiting days permits its successor on September 17. Two waiting days permit September 19. Overlaps are warnings, including proposed work; completed/canceled activities do not reserve resources. Resource warnings currently cover explicitly assigned resources, not legacy staff/vendor-only windows or ordinary ST dispatch work that has not been imported.

## API

All paths below are relative to `/api/v1/projects` and use staff authentication.

- `GET/POST /resources`
- `GET /external-systems` (names and IDs only)
- `GET/POST /projects/:id/jobs`
- `DELETE /projects/:id/jobs/:jobId` (refuses removal while used by an activity)
- `GET /schedule-lookahead?from=YYYY-MM-DD&to=YYYY-MM-DD` (up to 93 days, business-unit filtered)
- Existing schedule creation/edit endpoints accept `phase`, `job_link_id`, `resource_ids`, `dependencies`.

An omitted resources/dependencies collection preserves existing relationships. An empty collection clears them. A dependency is `{predecessor_id, lag_days}`. Legacy `depends_on` input is validated and converted; do not send it alongside `dependencies`.

## Integration proof and next connection step

The existing purchase_orders service was inspected with user authorization. Its configured environments are production for both ST and QBO. Read-only ST probes returned HTTP 200 for projects, jobs, appointments, appointment assignments, technicians and invoices. The PO app's stored live snapshot reported 222 QBO purchases and 1,108 ST POs, last synchronized September 14, 2026. That is a snapshot check, not a new QBO vendor/bill API proof.

`src/adapters/serviceTitan.ts` is an explicitly configured job/appointment/assignment client. It validates response shapes, strips unrelated source fields, checks job ownership, refuses incomplete/duplicate pages and preserves appointment timestamps. It also publishes project notes and files, reschedules appointments, and assigns technicians. It does not create customer invoices. It is not connected to scheduled import or HTTP sync handlers yet. `scripts/probeServiceTitan.ts` can exercise it with server-side process environment settings and a numeric `ST_PROBE_JOB_ID`; it reports counts only.

Keep QBO token refresh under one owner. The PO app stores encrypted rotating tokens in PostgreSQL and protects refresh with a database lock. Do not copy its refresh token into an independent PM refresh loop. A shared tenant-aware connector service or a separate OAuth grant is the next architecture step. Reuse mapping/transport logic through an explicit contract rather than importing its single-workspace database into this multi-tenant app.

No live data is seeded into the passwordless disposable demo. No new invoice, payment, bill or dispatch write was made. The new planning UI states that synchronization is not connected.

## Validation and release

Apply migration 008 with the existing provisioning flow. It is included in production, dev and test schema manifests and startup RLS assertions. Do not run schema scripts against an unspecified live database.

Before production rollout, connect platform staff authentication and configure the PM tenant's connector binding. Remaining work includes durable import/checkpoint/error handling, actual ST appointment mirror and resource identity mapping, QBO bill/expense allocation and cost reconciliation, timed resource conflicts, baseline date tracking, and file/portal workflows.
