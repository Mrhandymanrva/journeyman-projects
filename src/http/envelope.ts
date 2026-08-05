import type { Response, Request, NextFunction } from 'express';
import { ApiError } from './errors.js';

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
  _req: Request,
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
    res.status(mapped.status).json({ error: { code: mapped.code, message: mapped.message } });
    return;
  }

  // eslint-disable-next-line no-console
  console.error('[unhandled]', err);
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
): { status: number; code: string; message: string } | null {
  const message = err instanceof Error ? err.message : String(err);

  if (pgCode === '23514' && /cannot be scheduled/i.test(message)) {
    return { status: 409, code: 'compliance_blocked', message };
  }
  if (pgCode === '23505') {
    return {
      status: 409,
      code: 'conflict',
      message: 'That record already exists.',
    };
  }
  if (pgCode === '42501') {
    // "new row violates row-level security policy" — an insert whose tenant_id
    // was not the session tenant, or a tenant whose entitlement is not live.
    return {
      status: 403,
      code: 'module_not_entitled',
      message: 'The Projects module is not active for this account.',
    };
  }
  return null;
}
