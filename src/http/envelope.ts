import type { Response, Request, NextFunction } from 'express';
import { alertWebhookUrl } from '../env.js';
import { ApiError } from './errors.js';

const ALERT_TIMEOUT_MS = 3_000;
const ALERT_SUPPRESS_MS = 5 * 60 * 1000;
const recentAlerts = new Map<string, number>();
let alertNow = (): number => Date.now();

/** Tests advance the suppression clock. Production uses the wall clock. */
export function setAlertClockForTests(now: (() => number) | null): void {
  alertNow = now ?? (() => Date.now());
}

export function resetAlertSuppression(): void {
  recentAlerts.clear();
}

function environmentLabel(): string {
  const name = (process.env.NODE_ENV ?? 'development').trim();
  return name || 'development';
}

/** Path only. The query string can carry codes and is not part of the alert. */
function requestPath(req: Request): string {
  const raw = req.originalUrl || req.url || '/';
  const path = (raw.split('?')[0] || '/').replace(/[\r\n]/g, '');
  return path.slice(0, 300) || '/';
}

/**
 * Fire-and-forget note that this process returned an unhandled 500.
 * The text is the environment name and the path. It does not include the
 * request body, cookies, the query string, or SQL parameters. Identical
 * text is skipped for five minutes. An unset webhook does nothing, and a
 * failed post never changes the response.
 */
function notifyUnhandled(req: Request): void {
  const url = alertWebhookUrl();
  if (!url) return;
  const message = `${environmentLabel()} ${requestPath(req)}`.replace(/[\r\n]/g, '');
  const now = alertNow();
  const previous = recentAlerts.get(message);
  if (previous !== undefined && now - previous < ALERT_SUPPRESS_MS) return;
  recentAlerts.set(message, now);
  for (const [key, sentAt] of recentAlerts) {
    if (now - sentAt >= ALERT_SUPPRESS_MS) recentAlerts.delete(key);
  }
  try {
    void fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: message,
      credentials: 'omit',
      signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
    }).catch(() => {});
  } catch {
    // A bad URL throws before fetch returns a promise. The 500 still stands.
  }
}

export interface PageMeta {
  page: number;
  per_page: number;
  total: number;
}

export function sendData(res: Response, data: unknown, meta?: PageMeta, status = 200): void {
  res.status(status).json(meta ? { data, meta } : { data });
}

/**
 * Terminal error handler. Two rules it exists to enforce centrally:
 *  - a database error never reaches the client as a database error
 *  - an unrecognised throw is a 500 with a generic message, not a stack trace
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ApiError) {
    res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details === undefined ? {} : { details: err.details }),
      },
    });
    return;
  }

  const pgCode = (err as { code?: string } | null)?.code;
  const mapped = mapDatabaseError(pgCode, err);
  if (mapped) {
    if (mapped.log) {
      // A database error that becomes a clean 4xx still has to leave a trace.
      // Silently translating one into a billing message is how a missing GRANT
      // spends a day looking like a subscription problem.
      // eslint-disable-next-line no-console
      console.error(`[db ${pgCode}]`, err instanceof Error ? err.message : err);
    }
    res.status(mapped.status).json({ error: { code: mapped.code, message: mapped.message } });
    return;
  }

  // eslint-disable-next-line no-console
  console.error('[unhandled]', err);
  notifyUnhandled(req);
  res.status(500).json({
    error: { code: 'internal', message: 'Something went wrong on our side.' },
  });
}

/**
 * Database constraints that the schema deliberately enforces are surfaced as
 * the contract's own codes. The trigger message is reused verbatim for the
 * compliance case: it already names which document and when it expired, and
 * rewriting it in the handler means two places to keep true.
 */
function mapDatabaseError(
  pgCode: string | undefined,
  err: unknown,
): { status: number; code: string; message: string; log?: boolean } | null {
  const message = err instanceof Error ? err.message : String(err);

  if (pgCode === '23514' && /cannot be scheduled/i.test(message)) {
    return { status: 409, code: 'compliance_blocked', message };
  }
  if (pgCode === '23514' && /purchase order line/i.test(message)) {
    return { status: 409, code: 'conflict', message };
  }
  if (pgCode === '23514' && message.startsWith('Preconstruction:')) {
    return {
      status: 409,
      code: 'conflict',
      message: message.slice('Preconstruction: '.length),
    };
  }
  if (pgCode === '23505') {
    return { status: 409, code: 'conflict', message: 'That record already exists.' };
  }

  // 42501 is insufficient_privilege, and it arrives for two unrelated reasons.
  //
  // A write whose tenant_id did not match the session, or a tenant whose
  // entitlement is not live, fails the RLS WITH CHECK and says so — that is a
  // real 403 for the caller.
  //
  // A missing GRANT produces the same SQLSTATE and means the database is
  // misconfigured. Reporting that as "your subscription is not active" sends
  // whoever is debugging it to the billing system for a day. It is a 500, and
  // it is logged.
  if (pgCode === '42501') {
    if (/row-level security/i.test(message)) {
      return {
        status: 403,
        code: 'module_not_entitled',
        message: 'The Projects module is not active for this account.',
        log: true,
      };
    }
    return {
      status: 500,
      code: 'internal',
      message: 'The database rejected that request. This is a configuration problem, not yours.',
      log: true,
    };
  }
  return null;
}
