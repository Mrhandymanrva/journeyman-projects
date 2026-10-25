export interface Env {
  port: number;
  databaseUrl: string;
  nodeEnv: string;
  /** Mounts the passwordless dev sign-in. Refused when nodeEnv is production. */
  devLogin: boolean;
  /** Shared secret every dev sign-in must present. Required when devLogin is on. */
  devLoginToken: string;
  /** Sign in with Command Center; absent when CC_SSO_* is not set. */
  sso?: { url: string; clientId: string; clientSecret: string; tenantId: string };
  /**
   * Optional webhook for an unhandled 500. Absent when ALERT_WEBHOOK_URL is
   * unset or blank. Nothing is sent in that case.
   */
  alertWebhookUrl?: string;
}

/** Blank and whitespace-only values are unset. */
export function alertWebhookUrl(source: NodeJS.ProcessEnv = process.env): string | undefined {
  const url = (source.ALERT_WEBHOOK_URL ?? '').trim();
  return url || undefined;
}

/**
 * Raised instead of a bare Error so server.ts can print something an operator
 * can act on. A stack trace pointing at env.js line 4, repeated every second
 * in a crash loop, says the variable is missing but nothing about what to do —
 * and the thing to do here is not "set a variable", it is "attach a database
 * and provision two roles in it".
 */
export class MissingConfigError extends Error {
  constructor(
    message: string,
    readonly guidance: string,
  ) {
    super(message);
    this.name = 'MissingConfigError';
  }
}

export function readEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const databaseUrl = source.DATABASE_URL;
  if (!databaseUrl) {
    throw new MissingConfigError(
      'DATABASE_URL is not set, so there is no database to serve.',
      [
        'Journeyman Projects needs its own PostgreSQL 15 or later. It cannot share a',
        'MySQL database: tenant isolation is row-level security, every report is a',
        'security_invoker view, and the session contract is SET LOCAL. None of that',
        'exists outside PostgreSQL.',
        '',
        'On Railway:',
        '  1. Add a PostgreSQL service to this project.',
        '  2. On THIS service, add a variable DATABASE_URL referencing it. You are',
        '     not typing a connection string — you are pointing at the service:',
        '       DATABASE_URL = ${{Postgres.DATABASE_URL}}',
        '  3. Provision the two database roles before the first boot:',
        '       ADMIN_DATABASE_URL=<the Postgres service public URL> \\',
        '       JP_OWNER_PASSWORD=… JP_APP_PASSWORD=… pnpm db:provision',
        '  4. Point DATABASE_URL at the jp_app credentials that step 3 prints.',
        '',
        'Step 3 is not optional. The connection string Railway gives you belongs to a',
        'superuser, and a superuser connection ignores row-level security entirely —',
        'FORCE ROW LEVEL SECURITY closes the table-owner exemption and never the',
        'superuser one. Every tenant would see every other tenant. The startup',
        'assertions refuse to boot in that configuration, which is the backstop, not',
        'the fix.',
        '',
        'Full detail: docs/DEPLOY.md',
      ].join('\n'),
    );
  }

  const nodeEnv = source.NODE_ENV ?? 'development';
  const devLogin = source.DEV_LOGIN === 'true' && nodeEnv !== 'production';
  const devLoginToken = source.DEV_LOGIN_TOKEN ?? '';
  // Sign in with Command Center: this deployment is a registered client there (Settings → Connected apps gives the three values);
  // the people it signs in belong to the portfolio tenant unless SSO_TENANT_ID says otherwise.
  const ccUrl = (source.CC_SSO_URL ?? '').trim().replace(/\/$/, '');
  const ccClientId = (source.CC_SSO_CLIENT_ID ?? '').trim();
  const ccClientSecret = (source.CC_SSO_CLIENT_SECRET ?? '').trim();
  const ssoTenantId = (source.SSO_TENANT_ID ?? source.PM_PORTFOLIO_TENANT_ID ?? '').trim();
  const ssoOn = Boolean(ccUrl || ccClientId || ccClientSecret);
  if (ssoOn && !(ccUrl && ccClientId && ccClientSecret)) throw new MissingConfigError('Sign in with Command Center needs all three of CC_SSO_URL, CC_SSO_CLIENT_ID and CC_SSO_CLIENT_SECRET.', 'Register this deployment in Command Center under Settings → Connected apps and copy the three values here.');
  if (ssoOn && !ssoTenantId) throw new MissingConfigError('CC_SSO_* is set but no tenant is named.', 'Set SSO_TENANT_ID (or PM_PORTFOLIO_TENANT_ID) to the tenant Command Center users belong to.');

  if (devLogin && !devLoginToken) {
    throw new MissingConfigError(
      'DEV_LOGIN is on but DEV_LOGIN_TOKEN is not set.',
      [
        'Dev sign-in mints a staff session from an email address with no password.',
        'On anything reachable from the internet, that means whoever finds the',
        'hostname is signed in as an owner.',
        '',
        'Set DEV_LOGIN_TOKEN to a long random string and give it to the people who',
        'should be able to look at the console. It is a shared secret, not',
        'authentication — a holding position until platform sign-in lands.',
        '',
        'Or set DEV_LOGIN=false and leave the deployment locked.',
      ].join('\n'),
    );
  }

  return {
    port: Number(source.PORT ?? 3200),
    databaseUrl,
    nodeEnv,
    devLogin,
    devLoginToken,
    sso: ssoOn ? { url: ccUrl, clientId: ccClientId, clientSecret: ccClientSecret, tenantId: ssoTenantId } : undefined,
    alertWebhookUrl: alertWebhookUrl(source),
  };
}
