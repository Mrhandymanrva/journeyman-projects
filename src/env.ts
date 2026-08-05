export interface Env {
  port: number;
  databaseUrl: string;
  nodeEnv: string;
  /** Mounts the passwordless dev sign-in. Refused when nodeEnv is production. */
  devLogin: boolean;
}

export function readEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const databaseUrl = source.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required (PostgreSQL 15 or later).');
  }
  const nodeEnv = source.NODE_ENV ?? 'development';
  return {
    port: Number(source.PORT ?? 3200),
    databaseUrl,
    nodeEnv,
    devLogin: source.DEV_LOGIN === 'true' && nodeEnv !== 'production',
  };
}
