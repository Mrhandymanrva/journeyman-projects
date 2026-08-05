export interface Env {
  port: number;
  databaseUrl: string;
  nodeEnv: string;
}

export function readEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const databaseUrl = source.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required (PostgreSQL 15 or later).');
  }
  return {
    port: Number(source.PORT ?? 3200),
    databaseUrl,
    nodeEnv: source.NODE_ENV ?? 'development',
  };
}
