/** Read-only commission probe. GET only. No application database and no writes.
 * Configure ST_ENV, ST_TENANT_ID, ST_CLIENT_ID, ST_CLIENT_SECRET, and ST_APP_KEY
 * in the invoking process. Never paste secrets into command arguments.
 * Optional positional arguments are technician ids. The defaults are
 * 322339504 (Chris Voight, commissionRate 0.0) and 227070567 (Jarrod S, 0.28).
 */
import {
  ServiceTitanReadAdapter,
  type ServiceTitanConfig,
} from "../src/adapters/serviceTitan.js";
import { DEFAULT_PROBE_TECHNICIAN_IDS } from "../src/domain/commissionLabor.js";
import { formatCommissionProbe, runCommissionProbe } from "../src/domain/commissionProbe.js";

const required = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error(`Missing ${key}`);
  return value;
};

async function main() {
  const environment = required("ST_ENV");
  if (environment !== "integration" && environment !== "production") {
    throw new Error("Invalid ST_ENV");
  }
  const config: ServiceTitanConfig = {
    environment,
    tenantId: required("ST_TENANT_ID"),
    clientId: required("ST_CLIENT_ID"),
    clientSecret: required("ST_CLIENT_SECRET"),
    appKey: required("ST_APP_KEY"),
  };
  const ids = process.argv.slice(2).map((arg) => arg.trim()).filter((arg) => arg.length > 0);
  const technicianIds = ids.length ? ids : [...DEFAULT_PROBE_TECHNICIAN_IDS];
  for (const id of technicianIds) {
    if (!/^\d+$/.test(id)) throw new Error("Technician ids must be numeric.");
  }
  const client = new ServiceTitanReadAdapter(config);
  const report = await runCommissionProbe(
    {
      tenantId: config.tenantId,
      readAllowlistedGet: (family, resource, query) =>
        client.readAllowlistedGet(family, resource, query),
    },
    technicianIds,
  );
  console.log(formatCommissionProbe(report));
}

main().catch(() => {
  console.error(
    "Read-only ServiceTitan commission probe failed. Check configuration, API scope and response compatibility. No records were written.",
  );
  process.exitCode = 1;
});
