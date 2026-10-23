import { z } from "zod";
const record = z.object({
  id: z.string().min(1),
  source: z.enum(["qbo", "st"]),
  vendor: z.string(),
  amount: z.number().int().safe(),
  date: z.string().date(),
  currency: z.literal("USD").default("USD"),
  reference: z.string().default(""),
  description: z.string().default(""),
  account: z.string().default(""),
});
const snapshot = z.object({
  revision: z.number().int().nonnegative(),
  mode: z.literal("live"),
  lastSync: z.string().datetime({ offset: true }).nullable(),
  records: z.array(record).max(100000),
});
export function parseReconciliationSnapshot(input: unknown) {
  const result = snapshot.parse(input);
  const keys = result.records.map((r) => `${r.source}:${r.id}`);
  if (new Set(keys).size !== keys.length)
    throw new Error("Duplicate source records");
  return result;
}
export type ReconciliationSnapshot = ReturnType<
  typeof parseReconciliationSnapshot
>;
export class ReconciliationReadAdapter {
  private readonly origin: string;
  constructor(
    private readonly config: {
      origin: string;
      username: string;
      password: string;
    },
    private readonly fetcher: typeof fetch = fetch,
  ) {
    const url = new URL(config.origin);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      !config.username ||
      !config.password
    )
      throw new Error(
        "Use a configured HTTPS reconciliation origin and server credentials",
      );
    this.origin = url.origin;
  }
  async read(): Promise<ReconciliationSnapshot> {
    try {
      const response = await this.fetcher(this.origin + "/api/state", {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(20000),
        headers: {
          Accept: "application/json",
          Authorization:
            "Basic " +
            Buffer.from(
              this.config.username + ":" + this.config.password,
            ).toString("base64"),
        },
      });
      if (!response.ok) throw new Error("Source unavailable");
      return parseReconciliationSnapshot(await response.json());
    } catch {
      throw new Error(
        "Reconciliation read failed. Previous snapshot retained.",
      );
    }
  }
}
