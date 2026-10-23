import { ReconciliationReadAdapter } from "../src/adapters/reconciliation.js";
try {
  const client = new ReconciliationReadAdapter({
    origin: process.env.PO_APP_ORIGIN ?? "",
    username: process.env.PO_APP_USER ?? "",
    password: process.env.PO_APP_PASSWORD ?? "",
  });
  const snapshot = await client.read();
  console.log(
    JSON.stringify({
      readOnly: true,
      revision: snapshot.revision,
      lastSourceSync: snapshot.lastSync,
      purchases: snapshot.records.filter((r) => r.source === "qbo").length,
      purchaseOrders: snapshot.records.filter((r) => r.source === "st").length,
      configurationStripped: !("quickbooks" in snapshot),
    }),
  );
} catch {
  console.error(
    "Reconciliation client proof failed. No business data was written.",
  );
  process.exitCode = 1;
}
