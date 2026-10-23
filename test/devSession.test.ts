import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { createApp } from '../src/app.js';
import { MemoryStaffSessions } from '../src/http/memoryStaffSessions.js';
import { readEnv, MissingConfigError } from '../src/env.js';
import { createTenant, SCHEMA_FILES, startHarness, type Harness } from './support/harness.js';

/**
 * The dev sign-in is the only way into a deployed console today, and it mints
 * an owner session from an email address. These are the conditions that keep
 * that from being an open door.
 */

let h: Harness;

beforeAll(async () => {
  h = await startHarness(SCHEMA_FILES);
  const t=await createTenant(h, { slug: 'devlogin', displayName: 'Dev Login Co' });
  await h.db.withTenant(t.id,db=>db.query('UPDATE projects.staff SET login_bootstrap=true'));
});

afterAll(async () => {
  await h?.close();
});

const TOKEN = 'a-long-shared-secret';

function appWithDevLogin(nodeEnv = 'staging', accessToken = TOKEN) {
  const sessions = new MemoryStaffSessions();
  return supertest(
    createApp({
      database: h.db,
      staffSessions: sessions,
      serveConsole: false,
      devLogin: { enabled: true, sessions, nodeEnv, accessToken },
    }),
  );
}

describe('dev sign-in gating', () => {
  it('refuses to mount at all when NODE_ENV is production', () => {
    expect(() => appWithDevLogin('production')).toThrow(/production/i);
  });

  it('refuses to mount without an access token', () => {
    expect(() => appWithDevLogin('staging', '')).toThrow(/DEV_LOGIN_TOKEN/);
  });

  it('readEnv refuses the same combination before the app is built', () => {
    expect(() =>
      readEnv({
        DATABASE_URL: 'postgres://x/y',
        NODE_ENV: 'staging',
        DEV_LOGIN: 'true',
      } as NodeJS.ProcessEnv),
    ).toThrow(MissingConfigError);
  });

  it('is off entirely when NODE_ENV is production, whatever DEV_LOGIN says', () => {
    const env = readEnv({
      DATABASE_URL: 'postgres://x/y',
      NODE_ENV: 'production',
      DEV_LOGIN: 'true',
    } as NodeJS.ProcessEnv);
    expect(env.devLogin).toBe(false);
  });

  it('rejects a wrong token with 401 and no hint about what was wrong', async () => {
    const res = await appWithDevLogin()
      .post('/api/v1/dev/session')
      .send({ email: 'owner@example.test', tenant_slug: 'devlogin', access_token: 'nope' });
    expect(res.status).toBe(401);
    expect(res.body.error.message).not.toMatch(/tenant|email|account/i);
  });

  it('rejects a missing token as a validation error, not a sign-in', async () => {
    const res = await appWithDevLogin()
      .post('/api/v1/dev/session')
      .send({ email: 'owner@example.test', tenant_slug: 'devlogin' });
    expect(res.status).toBe(400);
  });

  it('a token that is a prefix of the real one does not pass', async () => {
    const res = await appWithDevLogin()
      .post('/api/v1/dev/session')
      .send({
        email: 'owner@example.test',
        tenant_slug: 'devlogin',
        access_token: TOKEN.slice(0, -1),
      });
    expect(res.status).toBe(401);
  });

  it('issues a session with the right token', async () => {
    const res = await appWithDevLogin()
      .post('/api/v1/dev/session')
      .send({
        email: 'owner@example.test',
        tenant_slug: 'devlogin',
        access_token: TOKEN,
      });
    expect(res.status).toBe(200);
    expect(res.body.data.token).toBeTruthy();
    expect(res.body.data.staff.role).toBe('owner');
  });

  it('a valid token still cannot invent a staff member or an account', async () => {
    const request = appWithDevLogin();
    const noSuchStaff = await request
      .post('/api/v1/dev/session')
      .send({
        email: 'nobody@example.test',
        tenant_slug: 'devlogin',
        access_token: TOKEN,
      });
    expect(noSuchStaff.status).toBe(404);

    const noSuchTenant = await request
      .post('/api/v1/dev/session')
      .send({
        email: 'owner@example.test',
        tenant_slug: 'not-a-tenant',
        access_token: TOKEN,
      });
    expect(noSuchTenant.status).toBe(404);
  });
});
