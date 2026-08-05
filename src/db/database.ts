/**
 * The session contract, in one place.
 *
 * Every tenant-scoped query in this module runs inside withTenant(). There is
 * no exported way to get a raw connection with an unset tenant except
 * withoutTenant(), which is for provisioning and health checks and is named so
 * that its use is visible in review.
 */

export interface SqlClient {
  query<R = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: R[]; rowCount: number }>;
}

export interface Database {
  /**
   * BEGIN; select set_config('app.tenant_id', $1, true); ...; COMMIT.
   *
   * set_config(..., is_local => true) rather than a literal `SET LOCAL`: SET
   * takes no bind parameters, so a literal would mean interpolating a value
   * from the session into DDL-shaped SQL. is_local => true is exactly SET
   * LOCAL — it dies with the transaction, so a pooled connection cannot carry
   * one request's tenant into the next request that borrows it.
   */
  withTenant<T>(tenantId: string, fn: (client: SqlClient) => Promise<T>): Promise<T>;

  /**
   * A transaction with no tenant set. RLS returns zero rows from every
   * tenant-scoped table, which is the point: this is for provisioning
   * (tenants, entitlements) and health checks, not for serving requests.
   */
  withoutTenant<T>(fn: (client: SqlClient) => Promise<T>): Promise<T>;

  close(): Promise<void>;
}

export class TransactionRollback extends Error {}
