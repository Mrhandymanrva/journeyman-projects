import { z } from "zod";
import { ServiceTitanReadAdapter } from "./serviceTitan.js";
import { ReconciliationReadAdapter } from "./reconciliation.js";
export interface SourceConnections {
  serviceTitan?: {
    tenantId: string;
    externalSystemId: string;
    key: string;
    writesEnabled?: boolean;
    client: Pick<ServiceTitanReadAdapter, "readJob"> &
      Partial<
        Pick<
          ServiceTitanReadAdapter,
          | "readTechnicians"
          | "readEmployees"
          | "readStaffName"
          | "rescheduleAppointment"
          | "readProject"
          | "listProjects"
          | "readProjectDetails"
          | "publishRecord"
          | "recordReceipts"
          | "projectNoteReceipt"
          | "publishProjectNote"
          | "readJobTimesheets"
          | "readGrossPayItems"
          | "readProjectJobs"
          | "readJobInvoiceLines"
          | "readJobPurchaseOrders"
          | "readAllowlistedGet"
          | "readLaborService"
          | "readInvoices"
          | "readPayments"
          | "readEstimates"
          | "sourceTenantId"
        >
      >;
  };
  reconciliation?: {
    tenantId: string;
    externalSystemId: string;
    key: string;
    writesEnabled?: boolean;
    client: Pick<ReconciliationReadAdapter, "read">;
  };
}
export function readSourceConnections(
  env: NodeJS.ProcessEnv = process.env,
): SourceConnections {
  const result: SourceConnections = {};
  if (env.PM_ST_TENANT_ID) {
    const tenantId = z.string().uuid().parse(env.PM_ST_TENANT_ID);
    const externalSystemId = z
      .string()
      .uuid()
      .parse(env.PM_ST_EXTERNAL_SYSTEM_ID);
    const environment = z.enum(["production", "integration"]).parse(env.ST_ENV);
    const sourceTenant = z.string().regex(/^\d+$/).parse(env.ST_TENANT_ID);
    result.serviceTitan = {
      tenantId,
      externalSystemId,
      key: `st:${environment}:${sourceTenant}`,
      writesEnabled: env.PM_ST_WRITES_ENABLED === "true",
      client: new ServiceTitanReadAdapter({
        environment,
        tenantId: sourceTenant,
        clientId: env.ST_CLIENT_ID ?? "",
        clientSecret: env.ST_CLIENT_SECRET ?? "",
        appKey: env.ST_APP_KEY ?? "",
      }),
    };
  }
  if (env.PM_PO_TENANT_ID) {
    const tenantId = z.string().uuid().parse(env.PM_PO_TENANT_ID);
    const externalSystemId = z
      .string()
      .uuid()
      .parse(env.PM_PO_EXTERNAL_SYSTEM_ID);
    const origin = z.string().url().parse(env.PO_APP_ORIGIN);
    result.reconciliation = {
      tenantId,
      externalSystemId,
      key: `po:${new URL(origin).origin}`,
      client: new ReconciliationReadAdapter({
        origin,
        username: env.PO_APP_USER ?? "",
        password: env.PO_APP_PASSWORD ?? "",
      }),
    };
  }
  return result;
}
