export interface Env {
  port: number;
  databaseUrl: string;
  nodeEnv: string;
  /** Mounts the passwordless dev sign-in. Refused when nodeEnv is production. */
  devLogin: boolean;
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
  return {
    port: Number(source.PORT ?? 3200),
    databaseUrl,
    nodeEnv,
    devLogin: source.DEV_LOGIN === 'true' && nodeEnv !== 'production',
  };
}
