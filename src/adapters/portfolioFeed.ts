import { z } from "zod";

/**
 * Read-only portfolio feed for a tenant's own owner dashboard (Command
 * Center). Same shape as the other per-tenant connectors: the tenant is named
 * in configuration, never inferred from the request, and the secret is a
 * bearer token the dashboard presents on every call.
 */
export interface PortfolioFeedConfig {
  tenantId: string;
  token: string;
}

export function portfolioFeedConfig(
  env: NodeJS.ProcessEnv = process.env,
): PortfolioFeedConfig | undefined {
  if (!env.PM_PORTFOLIO_TENANT_ID || !env.PM_PORTFOLIO_TOKEN) return undefined;
  const tenantId = z.string().uuid().parse(env.PM_PORTFOLIO_TENANT_ID);
  const token = env.PM_PORTFOLIO_TOKEN.trim();
  if (token.length < 24)
    throw Error("PM_PORTFOLIO_TOKEN must be at least 24 characters.");
  return { tenantId, token };
}
