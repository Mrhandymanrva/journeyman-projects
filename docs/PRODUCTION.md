# Production deployment — 2026-10-15

Journeyman PM runs at https://journeyman-projects-production.up.railway.app/.

The production account is `richmond` (formerly `demo`); its tenant ID is unchanged so ServiceTitan, QuickBooks, existing staff, and real project relationships remain intact. Display name: Mr. Handyman of Richmond. Owner email: mason.holloway@mrhandyman.com. The owner must complete the private password setup link. Existing password users keep their passwords and use `richmond` as the company account.

Required runtime settings: NODE_ENV=production, DEV_LOGIN=false, SEED_DEMO=false. Never re-enable demo seeding on this database: it deletes and recreates the tenant that now contains real work.

Project information now has an owner-only Delete project action. Exact project-number confirmation is required. Deletion permanently removes local project data; it does not delete external ServiceTitan or QuickBooks records. Accounting queue/history, external invoices, published documents, dispatch history, and sent bids block deletion. Draft bid recipients and local invoice records are removed in the same transaction before project cascades. No schema migration is needed.

Validation: TypeScript check/build; 17 integration tests covering project deletion, demo relationships, tenant/role restrictions, password sessions and developer-login gating; UI checks for incorrect confirmation, protected-history errors, and success.

This records runtime hardening and deployment, not a certification of backup retention, disaster recovery, or all integrations. Those infrastructure policies have not been audited in this change.

Deployment 109c79c1-c3ac-4587-9569-41b740edd177 succeeded. Live health returned OK, developer sign-in returned 404, and auth config reports devLoginEnabled=false. The three original DMO projects were removed in one transaction; all four ServiceTitan projects remain. The broad local backup was rejected by automatic approval review and was not created.
