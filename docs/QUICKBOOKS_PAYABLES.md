# QuickBooks vendor and bill workflow

Financials → Vendor bills & payments is the project AP workspace.

1. Add the vendor in Resources with legal name, contact person, email, phone, and address. Upload and review an actual W-9 file.
2. New vendors queue automatically. The worker waits for complete intake, looks for an exact QBO display name, reuses only an active match with the same email (or this PM vendor marker), and otherwise creates the vendor. Conflicting matches block synchronization. Contact person, trades, license and specialties are included in Notes. The reviewed W-9 is attached to the QBO vendor.
3. In Financials → Vendor setup & W-9 review, enter the W-9 tax ID and choose the 1099 setting to save directly to QBO. PM does not persist a separate tax-ID field or return it in responses. Alternatively, an approver can attest that existing QBO tax information was checked against the W-9. This is a human review, not IRS TIN verification.
4. Refresh QuickBooks lists. Optionally map the ST/PM project to a QBO customer/job; no customer is invented or matched by name. Select the expense account at approval.
5. Record each invoice against its purchase order/subcontract. The screen compares cumulative non-rejected invoices with contracted value. Overruns are visible warnings. Owner, manager or bookkeeper may approve; PMs may enter bills but cannot approve.
6. Approval locks the bill and commits its immutable posting payload in the same transaction. The worker posts a QBO Bill with a stable request ID, PM marker, vendor, account, dates and project/PO description. It does not create BillPayments or move money.
7. QBO remaining balance is refreshed periodically (up to 20 bills per 15-second cycle, with a five-minute minimum age), including partial payments. Zero balance is labelled settled, since credits can also settle bills. Amount differences raise a review warning without overwriting PM approved cost.

## Operational behavior
- The existing PO service hosts only a narrow authenticated accounting bridge at `/api/pm-accounting`, reusing its single OAuth token refresh owner. No OAuth token copies or direct database sharing.
- Both Basic service authentication and a separate `PM_ACCOUNTING_KEY` are required. PM uses `PO_APP_ORIGIN`, `PO_APP_USER`, `PO_APP_PASSWORD`, `PM_ACCOUNTING_KEY`, and `PM_QBO_TENANT_ID`.
- QBO realm is bound in configuration/queue and checked **before** writes. An ambiguous timeout is never blindly retried; Check QBO receipt performs reads only. Unconfirmed writes require reconciliation before any resend.
- Existing PM vendors are not bulk-created in QBO on deployment. Queue them from Vendor setup when reviewed. Existing approved unsent bills need an explicit Review & approve action; no historical bills are backfilled automatically.
- Retention requires separate payable and held invoices; approval blocks bills with retention until split. PM preserves the complete contract commitment. Do not duplicate the same amount in both bill records.
- W-9 sync transfers the reviewed file; other compliance files remain in PM. Entering a tax ID updates QBO, while the source W-9 remains in the restricted PM document store.
- Use Check QuickBooks on a vendor profile to compare and sync shared contact details with PM taking priority. Tax and 1099 changes retain the separate reviewed-W-9 workflow.
- Synthetic integration tests exercise writes. Production verification reads catalogs and existing records only; no test vendors, bills or payments are created.

## QuickBooks vendor discovery and profile sync

Resources → Subcontractors → Import from QuickBooks lists active QuickBooks vendors, with search and pagination. Only selected vendors with company name, valid email, phone and address are imported. A linked vendor is not imported twice; name/email collisions require matching the existing PM profile. Importing does not activate a vendor or mark W-9, tax or insurance requirements reviewed.

Each profile has Check QuickBooks. It checks the linked QuickBooks ID, or proposes exact-name matches before any W-9 prerequisite. Find existing QuickBooks vendor supports different-name matches. Compare both records and confirm they are the same vendor before syncing.

PM is authoritative for shared contact fields: company/display name, contact person, email, phone, address and notes. Populated PM values update existing QuickBooks fields. Empty PM fields are filled from QuickBooks first. Sync uses the current QuickBooks SyncToken and a sparse update, preserves unrelated QuickBooks fields, and never sends tax identifiers through the contact sync. Tax ID/1099 and W-9 attachment workflows remain separate. After an uncertain result, reopen Check QuickBooks before retrying.

The connector must deploy `/api/pm-accounting` from the current purchase-order source. Keep that route and `lib/pm-vendors.ts` in Git so a later GitHub deployment does not remove the bridge.
