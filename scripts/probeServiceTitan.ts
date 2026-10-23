/** Read-only connection proof. No application database, imports or writes.
 * Configure ST_ENV, ST_TENANT_ID, ST_CLIENT_ID, ST_CLIENT_SECRET, ST_APP_KEY and
 * optionally ST_PROBE_JOB_ID in the invoking process. Never paste secrets into
 * command arguments. The report contains counts, not customer data or tokens. */
import {
  ServiceTitanReadAdapter,
  type ServiceTitanConfig,
} from "../src/adapters/serviceTitan.js";
const required = (key: string) => {
  const v = process.env[key];
  if (!v) throw new Error(`Missing ${key}`);
  return v;
};
async function main() {
  const environment = required("ST_ENV");
  if (environment !== "integration" && environment !== "production")
    throw new Error("Invalid ST_ENV");
  const config: ServiceTitanConfig = {
    environment,
    tenantId: required("ST_TENANT_ID"),
    clientId: required("ST_CLIENT_ID"),
    clientSecret: required("ST_CLIENT_SECRET"),
    appKey: required("ST_APP_KEY"),
  };
  const client = new ServiceTitanReadAdapter(config);
  const jobId = required("ST_PROBE_JOB_ID");
  const result = await client.readJob(jobId);
  console.log(
    JSON.stringify({
      environment,
      readOnly: true,
      jobVerified: true,
      appointmentCount: result.appointments.length,
      activeAssignmentCount: result.assignments.filter((a) => a.active).length,
      observedAt: result.observedAt,
    }),
  );
}
main().catch(() => {
  console.error(
    "Read-only ServiceTitan proof failed. Check configuration, API scope and response compatibility. No records were written.",
  );
  process.exitCode = 1;
});
