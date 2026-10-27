import { ServiceTitanReadError } from "../adapters/serviceTitan.js";

const SECRET =
  /(?:Bearer\s+)[A-Za-z0-9._~+/=-]{8,}|ak1\.[A-Za-z0-9._-]+|(?:client_secret|app_key|ST-App-Key)\s*[:=]\s*\S+/gi;

const GENERIC = "Source refresh failed. The previous snapshot is unchanged.";

/**
 * The screen shows a ServiceTitanReadError, because those messages name the
 * failed read and do not include response bodies. Any other error stays generic.
 * The server log still has the stack.
 */
export function sourceFailureMessage(err: unknown): string {
  if (!(err instanceof ServiceTitanReadError)) return GENERIC;
  const cleaned = err.message.replace(SECRET, "[redacted]").replace(/\s+/g, " ").trim().slice(0, 400);
  const detail = cleaned || "ServiceTitan read failed.";
  if (/^source refresh failed:/i.test(detail)) return detail;
  return `Source refresh failed: ${detail} The previous snapshot is unchanged.`;
}
