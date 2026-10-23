import type { Database, SqlClient } from "../db/database.js";
export interface AccountingGateway {
  tenantId: string;
  call(
    input: Record<string, unknown>,
  ): Promise<{ realm: string; environment: string; result: any }>;
}
export class AccountingFailure extends Error {
  constructor(
    message: string,
    readonly uncertain = false,
  ) {
    super(message);
  }
}
export function accountingGateway(
  env: NodeJS.ProcessEnv = process.env,
): AccountingGateway | undefined {
  if (
    !env.PM_QBO_TENANT_ID ||
    !env.PM_ACCOUNTING_KEY ||
    !env.PO_APP_ORIGIN ||
    !env.PO_APP_USER ||
    !env.PO_APP_PASSWORD
  )
    return;
  const origin = new URL(env.PO_APP_ORIGIN);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/"
  )
    throw Error("Invalid accounting connector origin");
  return {
    tenantId: env.PM_QBO_TENANT_ID,
    async call(input) {
      let response: Response;
      try {
        response = await fetch(origin.origin + "/api/pm-accounting", {
          method: "POST",
          headers: {
            Authorization:
              "Basic " +
              Buffer.from(env.PO_APP_USER + ":" + env.PO_APP_PASSWORD).toString(
                "base64",
              ),
            "x-pm-accounting-key": env.PM_ACCOUNTING_KEY!,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(input),
          redirect: "error",
          signal: AbortSignal.timeout(90000),
        });
      } catch {
        throw new AccountingFailure(
          "Accounting connector did not return a result.",
          String(input.action).startsWith("create") || (input.action === "w9" || input.action === "syncVendor"),
        );
      }
      const body: any = await response.json();
      if (!response.ok)
        throw new AccountingFailure(
          body.error || "Accounting connection unavailable.",
          !!body.uncertain,
        );
      if (!body.realm || !body.result)
        throw new AccountingFailure(
          "Invalid accounting response.",
          String(input.action).startsWith("create") || (input.action === "w9" || input.action === "syncVendor"),
        );
      if (body.result.fault)
        throw new AccountingFailure(
          body.result.message,
          body.result.status >= 500 || body.result.status === 408,
        );
      return body;
    },
  };
}
export function vendorPayload(vendor: Record<string, any>) {
  return {
    DisplayName: String(vendor.legal_name).slice(0, 100),
    CompanyName: String(vendor.legal_name).slice(0, 100),
    PrimaryEmailAddr: { Address: vendor.email },
    ...(vendor.phone
      ? { PrimaryPhone: { FreeFormNumber: String(vendor.phone).slice(0, 30) } }
      : {}),
    ...(vendor.address
      ? { BillAddr: { Line1: String(vendor.address).slice(0, 500) } }
      : {}),
    Notes: (
      "Journeyman PM vendor " +
      vendor.id +
      " | Contact: " +
      (vendor.primary_contact || "") +
      " | Trades: " +
      (vendor.trades || []).join(", ") +
      " | License: " +
      (vendor.license_number || "") +
      " | Specialties: " +
      (vendor.specialties || []).join(", ")
    ).slice(0, 2000),
  };
}
export async function queueVendor(
  db: SqlClient,
  tenant: string,
  vendor: Record<string, any>,
) {
  const payload = vendorPayload(vendor);
  await db.query(
    `INSERT INTO projects.accounting_queue(tenant_id,kind,record_id,payload) VALUES($1,'vendor',$2,$3::jsonb) ON CONFLICT(tenant_id,kind,record_id) DO NOTHING`,
    [tenant, vendor.id, JSON.stringify(payload)],
  );
}
interface Queue {
  id: string;
  kind: "vendor" | "bill";
  record_id: string;
  payload: any;
  realm: string | null;
  check_only: boolean;
}
export async function runAccounting(db: Database, gateway: AccountingGateway) {
  const tenant = gateway.tenantId;
  const job = await db.withTenant(tenant, async (sql) => {
    // An abandoned network write has an unknown outcome; never automatically resend it.
    await sql.query(
      `UPDATE projects.accounting_queue SET state='uncertain',message='Interrupted sync: check QuickBooks before retrying.',updated_at=now() WHERE state='processing' AND updated_at<now()-interval '5 minutes'`,
    );
    const rows = await sql.query<Queue>(
      `SELECT * FROM projects.accounting_queue WHERE state='queued' AND (kind='bill' OR EXISTS(SELECT 1 FROM projects.vendors v WHERE v.id=record_id AND NOT v.archived AND COALESCE(v.phone,'')<>'' AND COALESCE(v.address,'')<>'' AND COALESCE(v.primary_contact,'')<>'' AND EXISTS(SELECT 1 FROM projects.vendor_documents d WHERE d.vendor_id=v.id AND d.kind='tax_form' AND d.verified_at IS NOT NULL AND d.file_data IS NOT NULL AND (d.expires_on IS NULL OR d.expires_on>=CURRENT_DATE)))) ORDER BY CASE kind WHEN 'vendor' THEN 0 ELSE 1 END,created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
    );
    const job = rows.rows[0];
    if (job && job.kind === "vendor" && !job.check_only) {
      const v = (
        await sql.query<any>("SELECT * FROM projects.vendors WHERE id=$1", [
          job.record_id,
        ])
      ).rows[0];
      job.payload = vendorPayload(v);
      const cfg = (
        await sql.query<{ realm: string }>(
          "SELECT realm FROM projects.accounting_config",
        )
      ).rows[0];
      job.realm = job.realm ?? cfg?.realm ?? null;
      await sql.query(
        "UPDATE projects.accounting_queue SET payload=$2::jsonb,realm=$3 WHERE id=$1",
        [job.id, JSON.stringify(job.payload), job.realm],
      );
    }
    if (job)
      await sql.query(
        `UPDATE projects.accounting_queue SET state='processing',updated_at=now() WHERE id=$1`,
        [job.id],
      );
    return job;
  });
  if (!job) return;
  let sent = false;
  try {
    const call = async (input: Record<string, unknown>) => {
      const answer = await gateway.call({
        ...input,
        ...(job.realm ? { expectedRealm: job.realm } : {}),
      });
      if (job.realm && job.realm !== answer.realm)
        throw new AccountingFailure(
          "The QuickBooks company changed. Restore the original connection.",
        );
      if (!job.realm) {
        job.realm = answer.realm;
        await db.withTenant(tenant, (s) =>
          s.query(`UPDATE projects.accounting_queue SET realm=$2 WHERE id=$1`, [
            job.id,
            answer.realm,
          ]),
        );
      }
      return answer.result;
    };
    let entity: any;
    let w9Id: string | null = null;
    if (job.kind === "vendor") {
      const linked = await db.withTenant(tenant, s => s.query<{qbo_id:string|null}>("SELECT qbo_id FROM projects.vendors WHERE id=$1",[job.record_id]));
      const linkedId=linked.rows[0]?.qbo_id;
      const found = linkedId ? [(await call({action:"vendor",id:linkedId})).Vendor].filter(Boolean) :
        (await call({action:"vendors",name:job.payload.DisplayName})).QueryResponse?.Vendor || [];
      if(linkedId) {
        entity=found.find((v:any)=>String(v.Id)===linkedId && v.Active!==false);
        if(!entity)throw new AccountingFailure("The linked QuickBooks vendor is missing or inactive. Check QuickBooks.");
      }
      if (!linkedId && found.length) {
        entity = found.find((v: any) =>
          v.Notes?.includes("Journeyman PM vendor " + job.record_id),
        );
        if (!entity) {
          const compatible = found.filter(
            (v: any) =>
              v.Active !== false &&
              v.PrimaryEmailAddr?.Address?.toLowerCase() ===
                job.payload.PrimaryEmailAddr.Address.toLowerCase(),
          );
          if (compatible.length === 1) entity = compatible[0];
          else
            throw new AccountingFailure(
              "A QuickBooks vendor has this name with different contact details. Correct the intake details or resolve the duplicate in QuickBooks.",
            );
        }
      } else if (!linkedId && !job.check_only) {
        sent = true;
        entity = (
          await call({
            action: "createVendor",
            requestId: job.id,
            payload: job.payload,
          })
        ).Vendor;
      }
      if (entity?.Id) {
        const doc = await db.withTenant(tenant, (s) =>
          s.query<{ id: string; media_type: string; content: string }>(
            `SELECT id,media_type,encode(file_data,'base64') AS content FROM projects.vendor_documents WHERE vendor_id=$1 AND kind='tax_form' AND verified_at IS NOT NULL AND file_data IS NOT NULL AND (expires_on IS NULL OR expires_on>=CURRENT_DATE) ORDER BY created_at DESC LIMIT 1`,
            [job.record_id],
          ),
        );
        if (!doc.rows[0])
          throw new AccountingFailure(
            "Upload and review the W-9 before syncing this vendor.",
          );
        const w9 = doc.rows[0];
        const attached = await call({
          action: "w9",
          vendorId: String(entity.Id),
          documentId: w9.id,
          content: w9.content,
          mediaType: w9.media_type,
          checkOnly: job.check_only,
        });
        if (!attached.Attachable?.Id)
          throw new AccountingFailure(
            "The W-9 attachment has not been confirmed in QuickBooks.",
            true,
          );
        w9Id = String(attached.Attachable.Id);
      }
    } else {
      const linked = await db.withTenant(tenant, (s) =>
        s.query<{ qbo_id: string | null }>(
          `SELECT qbo_id FROM projects.vendors WHERE id=$1`,
          [job.payload.vendorId],
        ),
      );
      const vendorId = linked.rows[0]?.qbo_id;
      if (!vendorId)
        throw new AccountingFailure(
          "Vendor has not reached QuickBooks. Sync the vendor first, then retry this bill.",
        );
      const payload = { ...job.payload.bill, VendorRef: { value: vendorId } };
      const found = (
        (await call({ action: "bills", number: payload.DocNumber }))
          .QueryResponse?.Bill || []
      ).filter((b: any) => b.VendorRef?.value === vendorId);
      entity = found.find((b: any) =>
        b.PrivateNote?.includes("Journeyman PM bill " + job.record_id),
      );
      if (!entity && found.length)
        throw new AccountingFailure(
          "QuickBooks already has this vendor invoice number. Review the existing bill; PM will not create a duplicate.",
        );
      if (!entity && !job.check_only) {
        sent = true;
        entity = (
          await call({ action: "createBill", requestId: job.id, payload })
        ).Bill;
      }
      if (
        entity &&
        Math.abs(Number(entity.TotalAmt) - Number(payload.Line[0].Amount)) >
          0.005
      )
        throw new AccountingFailure(
          "QuickBooks bill amount differs from the approved PM amount.",
          true,
        );
    }
    if (!entity?.Id)
      throw new AccountingFailure(
        job.check_only
          ? "No matching receipt found. Verify in QuickBooks before any resend."
          : "QuickBooks did not confirm the record.",
        true,
      );
    await db.withTenant(tenant, async (s) => {
      if (job.kind === "vendor")
        await s.query(
          `UPDATE projects.vendors SET qbo_id=$2,qbo_w9_id=$3 WHERE id=$1`,
          [job.record_id, String(entity.Id), w9Id],
        );
      else
        await s.query(
          `UPDATE projects.vendor_bills SET qbo_id=$2,qbo_balance=$3,qbo_checked_at=now(),qbo_message=NULL WHERE id=$1`,
          [job.record_id, String(entity.Id), entity.Balance ?? null],
        );
      await s.query(
        `UPDATE projects.accounting_queue SET state='synced',external_id=$2,message='Confirmed in QuickBooks',updated_at=now() WHERE id=$1`,
        [job.id, String(entity.Id)],
      );
    });
  } catch (e) {
    const uncertain =
      (e instanceof AccountingFailure ? e.uncertain : sent) || job.check_only;
    const message =
      e instanceof AccountingFailure
        ? e.message
        : "Accounting sync could not be confirmed. Check the connection and try again.";
    await db.withTenant(tenant, (s) =>
      s.query(
        `UPDATE projects.accounting_queue SET state=$2,message=$3,updated_at=now() WHERE id=$1`,
        [job.id, uncertain ? "uncertain" : "failed", message],
      ),
    );
  }
}
export async function refreshAccountingBalances(
  db: Database,
  gateway: AccountingGateway,
) {
  const bills = await db.withTenant(gateway.tenantId, (s) =>
    s.query<{ id: string; qbo_id: string; amount: string; realm: string }>(
      `SELECT b.id,b.qbo_id,b.amount,q.realm FROM projects.vendor_bills b JOIN projects.accounting_queue q ON q.record_id=b.id AND q.kind='bill' WHERE b.qbo_id IS NOT NULL AND (b.qbo_checked_at IS NULL OR b.qbo_checked_at<now()-interval '5 minutes') ORDER BY b.qbo_checked_at NULLS FIRST LIMIT 20`,
    ),
  );
  for (const bill of bills.rows)
    try {
      const response = await gateway.call({
        action: "bill",
        id: bill.qbo_id,
        expectedRealm: bill.realm,
      });
      const b = response.result.Bill;
      if (
        response.realm !== bill.realm ||
        !b ||
        b.Id !== bill.qbo_id ||
        !Number.isFinite(b.Balance)
      )
        throw Error("Invalid balance");
      const mismatch =
        Math.abs(Number(b.TotalAmt) - Number(bill.amount)) > 0.005;
      await db.withTenant(gateway.tenantId, (s) =>
        s.query(
          `UPDATE projects.vendor_bills SET qbo_balance=$2,qbo_checked_at=now(),qbo_message=$3,status=CASE WHEN $4 THEN status WHEN $2::numeric=0 THEN 'paid'::projects.bill_status ELSE 'approved'::projects.bill_status END,paid_at=CASE WHEN NOT $4 AND $2::numeric=0 THEN COALESCE(paid_at,now()) ELSE NULL END WHERE id=$1`,
          [
            bill.id,
            b.Balance,
            mismatch
              ? "Amount changed in QuickBooks; review the project cost."
              : null,
            mismatch,
          ],
        ),
      );
    } catch {
      await db.withTenant(gateway.tenantId, (s) =>
        s.query(
          `UPDATE projects.vendor_bills SET qbo_message='Balance refresh failed. Last known balance shown.',qbo_checked_at=now() WHERE id=$1`,
          [bill.id],
        ),
      );
    }
}
export function startAccountingWorker(
  db: Database,
  gateway: AccountingGateway | undefined,
) {
  if (!gateway) return;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await runAccounting(db, gateway);
      await refreshAccountingBalances(db, gateway);
    } catch {
      console.error("Accounting worker unavailable; queued work retained.");
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), 15000);
  timer.unref();
  void tick();
  return timer;
}
