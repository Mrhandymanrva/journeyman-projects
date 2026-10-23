import { quickbooksVendorRoutes } from "./quickbooksVendors.js";
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import {
  staffRoute,
  staffExternalRoute,
  type StaffRouterDeps,
  type StaffContext,
} from "../http/staffSession.js";
import { requireCapability } from "../http/capabilities.js";
import { ApiError, notFound } from "../http/errors.js";
import { sendData } from "../http/envelope.js";
import { loadVisibleProject, parseUuidParam, parseBody } from "./shared.js";
import { queueVendor, type AccountingGateway } from "../adapters/quickbooks.js";
import { buildVendorBillPayload, type BillCostGroup } from "../domain/vendorBillPayload.js";
import {
  COST_TYPES,
  loadCostTypeAccounts,
  suggestAccountMapping,
  type AccountMapping,
  type CostType,
} from "../domain/accountMapping.js";
import { assertSubcontractCompliance } from "../domain/vendorCompliance.js";
export async function prepareBillAccounting(
  ctx: StaffContext,
  billId: string,
  gateway?: AccountingGateway,
) {
  const result = await ctx.db.query<any>(
    `SELECT b.*,po.project_id,po.vendor_id,po.po_number,po.status AS po_status,po.kind::text AS kind,po.cost_type::text AS po_cost_type,p.name AS project_name,p.project_number,p.qbo_customer_id,v.qbo_id AS vendor_qbo_id,v.qbo_w9_id,v.qbo_tax_reviewed_at,v.archived FROM projects.vendor_bills b JOIN projects.purchase_orders po ON po.id=b.po_id JOIN projects.projects p ON p.id=po.project_id LEFT JOIN projects.vendors v ON v.id=po.vendor_id WHERE b.id=$1 FOR UPDATE OF b`,
    [billId],
  );
  const b = result.rows[0];
  if (!b) throw notFound("Vendor bill not found");
  await loadVisibleProject(ctx, b.project_id, "id");
  if (b.source === "qbo_link") {
    throw new ApiError(
      "conflict",
      "This bill is linked to an existing QuickBooks transaction and will not be sent again.",
    );
  }
  if (b.kind === "material") {
    throw new ApiError(
      "conflict",
      "A material bill is recorded by linking the QuickBooks transaction that already exists. It is not approved and it is not sent to QuickBooks.",
    );
  }
  if (
    b.status !== "received" &&
    !(
      gateway &&
      b.status === "approved" &&
      !(
        await ctx.db.query(
          `SELECT id FROM projects.accounting_queue WHERE kind='bill' AND record_id=$1`,
          [billId],
        )
      ).rows.length
    )
  )
    throw new ApiError(
      "conflict",
      "Only a bill awaiting approval can be approved.",
    );
  if (b.po_status !== "issued" && b.po_status !== "partially_billed")
    throw new ApiError(
      "conflict",
      "Issue the purchase order before approving its bill.",
    );
  await assertSubcontractCompliance(
    ctx.db,
    { kind: b.kind, vendor_id: b.vendor_id },
    "bill_approval",
    b.invoice_date ? String(b.invoice_date) : null,
  );
  if (!gateway) return; // Standalone installs retain the existing approval workflow.
  if (gateway.tenantId !== ctx.staff.tenantId)
    throw new ApiError(
      "conflict",
      "QuickBooks is not configured for this company.",
    );
  if (
    !b.vendor_id ||
    !b.vendor_qbo_id ||
    !b.qbo_w9_id ||
    !b.qbo_tax_reviewed_at ||
    b.archived
  )
    throw new ApiError(
      "conflict",
      "Complete vendor setup first: sync the reviewed W-9 and contact details, then confirm the vendor tax information in QuickBooks.",
    );
  if (Number(b.retention_held) > 0)
    throw new ApiError(
      "conflict",
      "Retention must be separated from the bill approved for payment. Record the payable portion as its own bill; keep the held amount unapproved.",
    );
  const config = (
    await ctx.db.query<any>("SELECT * FROM projects.accounting_config")
  ).rows[0];
  const body = parseBody(
    z.object({ qbo_account_id: z.string().regex(/^[0-9]+$/) }),
    ctx.req.body ?? {},
  );
  if (!config?.accounts.some((a: any) => a.id === body.qbo_account_id))
    throw new ApiError(
      "validation_failed",
      "Refresh QuickBooks lists and choose an expense account.",
    );
  if (
    b.qbo_customer_id &&
    !config.customers.some((c: any) => c.id === b.qbo_customer_id)
  )
    throw new ApiError(
      "conflict",
      "The linked QuickBooks customer is no longer active. Update the project mapping.",
    );
  const vendorQueue = (
    await ctx.db.query<{ realm: string }>(
      `SELECT realm FROM projects.accounting_queue WHERE kind='vendor' AND record_id=$1 AND state='synced'`,
      [b.vendor_id],
    )
  ).rows[0];
  if (vendorQueue?.realm !== config.realm)
    throw new ApiError(
      "conflict",
      "Vendor belongs to a different QuickBooks company.",
    );
  const duplicate = await ctx.db.query(
    `SELECT b.id FROM projects.vendor_bills b JOIN projects.purchase_orders po ON po.id=b.po_id WHERE po.vendor_id=$1 AND b.vendor_invoice_number=$2 AND b.id<>$3 AND b.status<>'rejected'`,
    [b.vendor_id, b.vendor_invoice_number, billId],
  );
  if (duplicate.rows.length)
    throw new ApiError(
      "conflict",
      "This vendor invoice number is already recorded against another purchase order.",
    );
  if (b.vendor_invoice_number.length > 21 || Number(b.amount) <= 0)
    throw new ApiError(
      "validation_failed",
      "QuickBooks bills require a positive amount and an invoice number no longer than 21 characters.",
    );
  const grouped = await ctx.db.query<{ cost_type: string; gross: string }>(
    `SELECT l.cost_type::text AS cost_type, SUM(bl.gross_amount)::text AS gross
       FROM projects.bill_lines bl
       JOIN projects.po_lines l ON l.id = bl.po_line_id
      WHERE bl.bill_id = $1
      GROUP BY l.cost_type`,
    [billId],
  );
  const groups: BillCostGroup[] = grouped.rows.length
    ? grouped.rows.map((row) => ({ costType: row.cost_type, amount: Number(row.gross) }))
    : [{ costType: b.po_cost_type ?? "S", amount: Number(b.amount) }];
  const mapping = await loadCostTypeAccounts(ctx.db);
  const labels: Record<CostType, string> = {
    L: "labor",
    M: "material",
    S: "subcontract",
    O: "other",
  };
  for (const type of COST_TYPES) {
    const mapped = mapping.accounts[type];
    if (mapped && !config.accounts.some((account: { id: string }) => account.id === mapped)) {
      throw new ApiError(
        "validation_failed",
        `The ${labels[type]} cost type is mapped to QuickBooks account ${mapped}, which is not in the current chart of accounts. Refresh the lists or clear that mapping before approving.`,
      );
    }
  }
  const bill = buildVendorBillPayload({
    id: b.id,
    invoiceNumber: b.vendor_invoice_number,
    invoiceDate: String(b.invoice_date),
    dueDate: String(b.due_date),
    projectNumber: b.project_number,
    projectName: b.project_name,
    poNumber: b.po_number,
    amount: Number(b.amount),
    description: b.description ?? "",
    accountId: body.qbo_account_id,
    customerId: b.qbo_customer_id,
    groups,
    accounts: mapping.accounts,
  });
  await ctx.db.query(
    `UPDATE projects.vendor_bills SET qbo_account_id=$2 WHERE id=$1`,
    [billId, body.qbo_account_id],
  );
  await ctx.db.query(
    `INSERT INTO projects.accounting_queue(tenant_id,kind,record_id,payload,realm) VALUES($1,'bill',$2,$3::jsonb,$4)`,
    [
      ctx.staff.tenantId,
      billId,
      JSON.stringify({ vendorId: b.vendor_id, bill }),
      config.realm,
    ],
  );
}
export function accountingRoutes(
  deps: StaffRouterDeps,
  gateway?: AccountingGateway,
) {
  const router = Router();
  router.use(quickbooksVendorRoutes(deps,gateway));
  router.get(
    "/accounting/catalog",
    staffRoute(deps, async (ctx) => {
      const config = (
        await ctx.db.query(
          "SELECT realm,environment,accounts,customers,updated_at FROM projects.accounting_config",
        )
      ).rows[0];
      sendData(ctx.res, {
        connected: gateway?.tenantId === ctx.staff.tenantId,
        ...config,
      });
    }),
  );
  router.post(
    "/accounting/catalog/refresh",
    staffExternalRoute(
      deps,
      async (ctx) => {
        requireCapability(ctx.staff.role, "approve_vendor_bill");
        if (!gateway || gateway.tenantId !== ctx.staff.tenantId)
          throw new ApiError(
            "conflict",
            "QuickBooks connector is not configured.",
          );
        return gateway;
      },
      (g) => g.call({ action: "catalog" }),
      async (ctx, _g, response) => {
        const config = (
          await ctx.db.query<{ realm: string }>(
            "SELECT realm FROM projects.accounting_config",
          )
        ).rows[0];
        if (config && config.realm !== response.realm)
          throw new ApiError(
            "conflict",
            "The connected QuickBooks company changed. Restore the original connection.",
          );
        await ctx.db.query(
          `INSERT INTO projects.accounting_config(tenant_id,realm,environment,accounts,customers) VALUES($1,$2,$3,$4::jsonb,$5::jsonb) ON CONFLICT(tenant_id) DO UPDATE SET accounts=EXCLUDED.accounts,customers=EXCLUDED.customers,updated_at=now()`,
          [
            ctx.staff.tenantId,
            response.realm,
            response.environment,
            JSON.stringify(response.result.accounts),
            JSON.stringify(response.result.customers),
          ],
        );
        sendData(ctx.res, { refreshed: true });
      },
    ),
  );
  router.get(
    "/accounting/cost-type-accounts",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "manage_company_settings");
      sendData(ctx.res, await presentCostTypeAccounts(ctx));
    }),
  );
  router.patch(
    "/accounting/cost-type-accounts",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "manage_company_settings");
      const body = parseBody(
        z.object({
          agreement_grace_days: z.number().int().min(0).max(365).optional(),
          accounts: z
            .object({
              L: z.string().regex(/^[0-9]+$/).nullable(),
              M: z.string().regex(/^[0-9]+$/).nullable(),
              S: z.string().regex(/^[0-9]+$/).nullable(),
              O: z.string().regex(/^[0-9]+$/).nullable(),
            })
            .optional(),
        }),
        ctx.req.body,
      );
      if (body.accounts) {
        const config = (
          await ctx.db.query<{ accounts: Array<{ id: string }> }>(
            "SELECT accounts FROM projects.accounting_config",
          )
        ).rows[0];
        const known = new Set((config?.accounts ?? []).map((account) => String(account.id)));
        for (const id of Object.values(body.accounts)) {
          if (id && !known.has(id)) {
            throw new ApiError(
              "validation_failed",
              "Refresh QuickBooks lists and choose an expense account from the chart. Nothing was saved.",
            );
          }
        }
      }
      const current = await loadCostTypeAccounts(ctx.db);
      const accounts: AccountMapping = body.accounts ?? current.accounts;
      const grace = body.agreement_grace_days ?? current.graceDays;
      const updated = await ctx.db.query(
        `UPDATE projects.tenant_settings
            SET agreement_grace_days = $2,
                qbo_account_labor = $3,
                qbo_account_material = $4,
                qbo_account_subcontract = $5,
                qbo_account_other = $6,
                updated_at = now()
          WHERE tenant_id = $1`,
        [ctx.staff.tenantId, grace, accounts.L, accounts.M, accounts.S, accounts.O],
      );
      if (updated.rowCount === 0) {
        throw new ApiError("conflict", "Company settings are not initialized.");
      }
      sendData(ctx.res, await presentCostTypeAccounts(ctx));
    }),
  );
  router.get(
    "/projects/:id/vendor-bills",
    staffRoute(deps, async (ctx) => {
      const id = parseUuidParam(ctx.req.params.id, "Project");
      await loadVisibleProject(ctx, id, "id");
      const rows = await ctx.db.query(
        `SELECT b.id,b.po_id,b.vendor_invoice_number,b.amount,b.retention_held,b.source,b.qbo_txn_type,b.status::text,b.invoice_date,b.due_date,b.description,b.qbo_id,b.qbo_balance,b.qbo_checked_at,b.qbo_message,b.qbo_account_id,b.approved_at,po.po_number,po.kind::text AS po_kind,po.amount AS contracted,COALESCE(v.legal_name,po.supplier_name) AS vendor,q.state AS sync_state,q.message AS sync_message,(SELECT COALESCE(sum(other.amount),0) FROM projects.vendor_bills other WHERE other.po_id=po.id AND other.status<>'rejected') AS billed_to_date FROM projects.vendor_bills b JOIN projects.purchase_orders po ON po.id=b.po_id LEFT JOIN projects.vendors v ON v.id=po.vendor_id LEFT JOIN projects.accounting_queue q ON q.record_id=b.id AND q.kind='bill' WHERE po.project_id=$1 ORDER BY b.received_at DESC`,
        [id],
      );
      const p = (
        await ctx.db.query(
          "SELECT qbo_customer_id FROM projects.projects WHERE id=$1",
          [id],
        )
      ).rows[0];
      sendData(ctx.res, {
        bills: rows.rows.map((bill) => ({
          ...bill,
          card_charge_state:
            bill.po_kind === "material" && bill.status === "received" && !bill.qbo_id
              ? "awaiting_card_charge"
              : bill.po_kind === "material" && bill.qbo_id
                ? "matched"
                : null,
        })),
        ...p,
      });
    }),
  );
  router.patch(
    "/projects/:id/accounting",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "approve_vendor_bill");
      const id = parseUuidParam(ctx.req.params.id, "Project");
      await loadVisibleProject(ctx, id, "id");
      const b = parseBody(
        z.object({
          qbo_customer_id: z
            .string()
            .regex(/^[0-9]+$/)
            .nullable(),
        }),
        ctx.req.body,
      );
      if (b.qbo_customer_id) {
        const c = (
          await ctx.db.query<any>(
            "SELECT customers FROM projects.accounting_config",
          )
        ).rows[0];
        if (!c?.customers.some((x: any) => x.id === b.qbo_customer_id))
          throw new ApiError(
            "validation_failed",
            "Choose an active QuickBooks customer from the list.",
          );
      }
      await ctx.db.query(
        "UPDATE projects.projects SET qbo_customer_id=$2 WHERE id=$1",
        [id, b.qbo_customer_id],
      );
      sendData(ctx.res, b);
    }),
  );
  router.get(
    "/accounting/vendors",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "approve_vendor_bill");
      const rows = await ctx.db.query(
        `SELECT v.id,v.legal_name,v.qbo_id,v.qbo_w9_id,v.qbo_tax_reviewed_at,v.primary_contact,v.phone,v.address,q.state,q.message,EXISTS(SELECT 1 FROM projects.vendor_documents d WHERE d.vendor_id=v.id AND d.kind='tax_form' AND d.file_data IS NOT NULL AND d.verified_at IS NOT NULL AND (d.expires_on IS NULL OR d.expires_on>=CURRENT_DATE)) AS w9_reviewed FROM projects.vendors v LEFT JOIN projects.accounting_queue q ON q.record_id=v.id AND q.kind='vendor' WHERE NOT v.archived ORDER BY v.legal_name`,
      );
      sendData(ctx.res, rows.rows);
    }),
  );
  router.post(
    "/vendors/:id/accounting-review",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "approve_vendor_bill");
      const id = parseUuidParam(ctx.req.params.id, "Vendor");
      const v = (
        await ctx.db.query<any>("SELECT * FROM projects.vendors WHERE id=$1", [
          id,
        ])
      ).rows[0];
      if (!v) throw notFound("Vendor not found");
      parseBody(z.object({ confirmed: z.literal(true) }), ctx.req.body);
      if (!v.qbo_id || !v.qbo_w9_id)
        throw new ApiError(
          "conflict",
          "Sync the vendor and W-9 to QuickBooks first.",
        );
      await ctx.db.query(
        "UPDATE projects.vendors SET qbo_tax_reviewed_by=$2,qbo_tax_reviewed_at=now() WHERE id=$1",
        [id, ctx.staff.staffId],
      );
      sendData(ctx.res, { reviewed: true });
    }),
  );
  router.post(
    "/vendors/:id/accounting-sync",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "manage_vendors");
      const id = parseUuidParam(ctx.req.params.id, "Vendor");
      const v = (
        await ctx.db.query<any>("SELECT * FROM projects.vendors WHERE id=$1", [
          id,
        ])
      ).rows[0];
      if (!v) throw notFound("Vendor not found");
      if (v.archived)
        throw new ApiError("conflict", "Restore the vendor first.");
      await queueVendor(ctx.db, ctx.staff.tenantId, v);
      await ctx.db.query(
        `UPDATE projects.accounting_queue SET state='queued',check_only=(state='uncertain'),updated_at=now(),payload=CASE WHEN state='failed' THEN $2::jsonb ELSE payload END WHERE kind='vendor' AND record_id=$1 AND state IN ('failed','uncertain')`,
        [
          id,
          JSON.stringify({
            DisplayName: v.legal_name.slice(0, 100),
            CompanyName: v.legal_name.slice(0, 100),
            PrimaryEmailAddr: { Address: v.email },
            PrimaryPhone: { FreeFormNumber: (v.phone || "").slice(0, 30) },
            BillAddr: { Line1: (v.address || "").slice(0, 500) },
            Notes: "Journeyman PM vendor " + id,
          }),
        ],
      );
      sendData(ctx.res, { queued: true });
    }),
  );
  router.post(
    "/bills/:id/accounting-sync",
    staffRoute(deps, async (ctx) => {
      requireCapability(ctx.staff.role, "approve_vendor_bill");
      const id = parseUuidParam(ctx.req.params.id, "Bill");
      const b = (
        await ctx.db.query<any>(
          "SELECT b.*,po.project_id FROM projects.vendor_bills b JOIN projects.purchase_orders po ON po.id=b.po_id WHERE b.id=$1",
          [id],
        )
      ).rows[0];
      if (!b) throw notFound("Bill not found");
      await loadVisibleProject(ctx, b.project_id, "id");
      await ctx.db.query(
        `UPDATE projects.accounting_queue SET state='queued',check_only=(state='uncertain'),updated_at=now() WHERE kind='bill' AND record_id=$1 AND state IN ('failed','uncertain')`,
        [id],
      );
      if (b.qbo_id)
        await ctx.db.query(
          "UPDATE projects.vendor_bills SET qbo_checked_at=NULL WHERE id=$1",
          [id],
        );
      sendData(ctx.res, { queued: true });
    }),
  );
  router.post(
    "/vendors/:id/accounting-tax",
    staffExternalRoute(
      deps,
      async (ctx) => {
        requireCapability(ctx.staff.role, "approve_vendor_bill");
        const id = parseUuidParam(ctx.req.params.id, "Vendor");
        const v = (
          await ctx.db.query<any>(
            `SELECT v.qbo_id,v.qbo_w9_id,q.realm FROM projects.vendors v LEFT JOIN projects.accounting_queue q ON q.record_id=v.id AND q.kind='vendor' WHERE v.id=$1`,
            [id],
          )
        ).rows[0];
        if (!v) throw notFound("Vendor not found");
        if (
          !gateway ||
          gateway.tenantId !== ctx.staff.tenantId ||
          !v.qbo_id ||
          !v.qbo_w9_id ||
          !v.realm
        )
          throw new ApiError(
            "conflict",
            "Sync the vendor and reviewed W-9 first.",
          );
        const body = parseBody(
          z.object({
            tax_id: z
              .string()
              .transform((s) => s.replace(/[- ]/g, ""))
              .pipe(z.string().regex(/^[0-9]{9}$/)),
            vendor_1099: z.boolean(),
            confirmed: z.literal(true),
          }),
          ctx.req.body,
        );
        return {
          id,
          vendorId: v.qbo_id,
          realm: v.realm,
          taxId: body.tax_id,
          vendor1099: body.vendor_1099,
        };
      },
      async (p) => {
        try {
          const response = await gateway!.call({
            action: "tax",
            vendorId: p.vendorId,
            expectedRealm: p.realm,
            taxId: p.taxId,
            vendor1099: p.vendor1099,
            requestId: randomUUID(),
          });
          return {
            ok:
              response.realm === p.realm &&
              response.result.Vendor?.Id === p.vendorId,
          };
        } catch {
          return { ok: false };
        }
      },
      async (ctx, p, result) => {
        if (!result.ok)
          throw new ApiError(
            "conflict",
            "Tax details were not confirmed. Review the vendor in QuickBooks before trying again.",
          );
        await ctx.db.query(
          "UPDATE projects.vendors SET qbo_tax_reviewed_by=$2,qbo_tax_reviewed_at=now() WHERE id=$1",
          [p.id, ctx.staff.staffId],
        );
        ctx.res.setHeader("Cache-Control", "no-store");
        sendData(ctx.res, { reviewed: true });
      },
    ),
  );
  return router;
}

async function presentCostTypeAccounts(ctx: StaffContext) {
  const saved = await loadCostTypeAccounts(ctx.db);
  const config = (
    await ctx.db.query<{ accounts: Array<{ id: string; name: string }> | null }>(
      "SELECT accounts FROM projects.accounting_config",
    )
  ).rows[0];
  const catalog = (config?.accounts ?? []).map((account) => ({
    id: String(account.id),
    name: String(account.name ?? ""),
  }));
  return {
    agreement_grace_days: saved.graceDays,
    accounts: saved.accounts,
    suggestions: suggestAccountMapping(catalog),
    catalog,
  };
}
