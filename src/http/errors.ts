/**
 * Error codes from API Contract §1.4. `code` is what a client branches on;
 * `message` is for a human and may be reworded freely.
 */
export const ERROR_CODES = {
  validation_failed: 400,
  unauthenticated: 401,
  forbidden: 403,
  module_not_entitled: 403,
  not_found: 404,
  gate_not_satisfied: 409,
  compliance_blocked: 409,
  baseline_frozen: 409,
  draw_already_invoiced: 409,
  conflict: 409,
  contract_version_unsupported: 422,
  rate_limited: 429,
  internal: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get status(): number {
    return ERROR_CODES[this.code];
  }
}

/**
 * Cross-tenant reads return this, never `forbidden`. 403 on someone else's row
 * confirms the identifier is real, which is the whole thing the isolation is
 * for. Handlers get this for free by never special-casing tenancy: the query
 * runs, RLS filters it to nothing, and the handler reports what it saw.
 */
export const notFound = (what = 'Not found') => new ApiError('not_found', what);

export const validationFailed = (details: unknown, message = 'Request body is not valid') =>
  new ApiError('validation_failed', message, details);

export const forbidden = (message: string, details?: unknown) =>
  new ApiError('forbidden', message, details);

export const conflict = (code: ErrorCode, message: string, details?: unknown) =>
  new ApiError(code, message, details);
