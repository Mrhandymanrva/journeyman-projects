import type { Database } from "../db/database.js";
import type { SourceConnections } from "../adapters/sourceConnections.js";
import { DEMO_ST_LABOR_TYPE, DEMO_TENANT_ID } from "./demoData.js";

/** Synthetic fixtures only. Never load production credentials into pnpm dev. */
export async function seedDemoSources(
  db: Database,
): Promise<SourceConnections> {
  const externalSystemId = await db.withTenant(DEMO_TENANT_ID, async (c) => {
    const systems = await c.query<{ id: string }>(
      "SELECT id FROM projects.external_systems WHERE active ORDER BY display_name LIMIT 1",
    );
    const id = systems.rows[0]!.id;
    const projects = await c.query<{ id: string }>(
      "SELECT id FROM projects.projects ORDER BY project_number LIMIT 1",
    );
    await c.query(
      `INSERT INTO projects.project_job_links(tenant_id,project_id,external_system_id,external_job_id,title) VALUES ($1,$2,$3,'900001','Demo · multi-day field job') ON CONFLICT DO NOTHING`,
      [DEMO_TENANT_ID, projects.rows[0]!.id, id],
    );
    return id;
  });
  const start = new Date();
  start.setUTCHours(12, 0, 0, 0);
  const date = (days: number, hours = 0) =>
    new Date(start.getTime() + days * 86400000 + hours * 3600000).toISOString();
  return {
    serviceTitan: {
      tenantId: DEMO_TENANT_ID,
      externalSystemId,
      key: "demo:st",
      client: {
        sourceTenantId: "demo-st",
        async readLaborTypes() {
          // Demo only. Production never loads this client. DEMO_ST_LABOR switches
          // the fake read so a screenshot can show the error. It is not stored.
          const mode = (process.env.DEMO_ST_LABOR ?? "one").trim();
          if (mode === "forbidden") return { forbidden: true, laborTypes: [] };
          if (mode === "none") return { forbidden: false, laborTypes: [] };
          if (mode === "many") {
            return {
              forbidden: false,
              laborTypes: [
                { ...DEMO_ST_LABOR_TYPE },
                {
                  id: "9002",
                  name: "Shop",
                  code: "ST-SHOP",
                  serviceCodeId: null,
                  active: true,
                },
              ],
            };
          }
          return { forbidden: false, laborTypes: [{ ...DEMO_ST_LABOR_TYPE }] };
        },
        async readJob(id) {
          return {
            job: {
              id,
              jobNumber: "DEMO-900001",
              customerId: "1",
              locationId: "1",
              jobStatus: "InProgress",
              summary: "Synthetic demo job",
              modifiedOn: date(0),
            },
            appointments: [0, 1, 2].map((n) => ({
              id: String(101 + n),
              jobId: id,
              appointmentNumber: `DEMO-${n + 1}`,
              start: date(n),
              end: date(n, 8),
              status: "Scheduled",
              active: true,
              isConfirmed: true,
              modifiedOn: date(0),
            })),
            assignments: [0, 1, 2].flatMap((n) =>
              [0, 1].map((tech) => ({
                id: String(n * 2 + tech + 1),
                jobId: id,
                appointmentId: String(101 + n),
                technicianId: String(501 + tech),
                technicianName: tech ? "Demo Taylor" : "Demo Alex",
                active: true,
                status: "Assigned",
                modifiedOn: date(0),
              })),
            ),
            observedAt: new Date().toISOString(),
          };
        },
      },
    },
    reconciliation: {
      tenantId: DEMO_TENANT_ID,
      externalSystemId,
      key: "demo:po",
      client: {
        async read() {
          return {
            revision: 1,
            mode: "live" as const,
            lastSync: new Date().toISOString(),
            records: [
              {
                id: "DEMO-QB-1",
                source: "qbo" as const,
                vendor: "Demo building supply",
                amount: 42875,
                date: date(0).slice(0, 10),
                currency: "USD" as const,
                reference: "DEMO-PO-42",
                description: "Synthetic material purchase",
                account: "Demo card",
              },
              {
                id: "DEMO-ST-1",
                source: "st" as const,
                vendor: "Demo building supply",
                amount: 42875,
                date: date(0).slice(0, 10),
                currency: "USD" as const,
                reference: "DEMO-PO-42",
                description:
                  "Synthetic PO reference — not an additional expense",
                account: "",
              },
            ],
          };
        },
      },
    },
  };
}
