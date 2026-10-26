import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import supertest from "supertest";
import { createApp } from "../src/app.js";
import type { Database } from "../src/db/database.js";
import { MissingConfigError, readEnv, type Env } from "../src/env.js";
import { MemoryStaffSessions } from "../src/http/memoryStaffSessions.js";

/**
 * An incomplete Command Center sign-in must not refuse to boot. These cases
 * log one warning that names settings, leave SSO off, and keep the regular
 * login. DEV_LOGIN and DATABASE_URL stay strict.
 */

const SECRET = "jp-secret-value";
const CLIENT_ID = "jp-client";
const TENANT = "11111111-1111-4111-8111-111111111111";
const PORTFOLIO_TENANT = "22222222-2222-4222-8222-222222222222";

const database: Database = {
  withTenant: async () => {
    throw new Error("no db");
  },
  withoutTenant: async () => {
    throw new Error("no db");
  },
  tryAdvisoryLock: async () => null,
  close: async () => {},
};

function source(
  overrides: Record<string, string | undefined> = {},
  base = true,
): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {
    DATABASE_URL: "postgres://x/y",
  };
  if (base) {
    env.CC_SSO_URL = "https://command.example.test";
    env.CC_SSO_CLIENT_ID = CLIENT_ID;
    env.CC_SSO_CLIENT_SECRET = SECRET;
    env.SSO_TENANT_ID = TENANT;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env as NodeJS.ProcessEnv;
}

function requestFor(env: Env) {
  return supertest(
    createApp({
      database,
      staffSessions: new MemoryStaffSessions(),
      serveConsole: false,
      sso: env.sso,
      ssoConfigIssue: env.ssoConfigIssue,
    }),
  );
}

function warning(issues: string[]) {
  return `Sign in with Command Center is off: ${issues.join(", ")}. Regular login is unchanged.`;
}

async function expectDisabled(
  overrides: Record<string, string | undefined>,
  issues: string[],
) {
  const configured = source(overrides);
  const env = readEnv(configured);
  expect(env.sso).toBeUndefined();
  expect(env.ssoConfigIssue).toEqual(issues);
  expect(console.warn).toHaveBeenCalledTimes(1);
  const printed = String(vi.mocked(console.warn).mock.calls[0]?.[0]);
  expect(printed).toBe(warning(issues));
  for (const value of Object.values(configured)) {
    if (!value?.trim()) continue;
    expect(printed).not.toContain(value.trim());
  }
  const request = requestFor(env);
  const cfg = await request.get("/api/v1/auth/config");
  expect(cfg.status).toBe(200);
  expect(cfg.headers["cache-control"]).toBe("no-store");
  expect(cfg.body.data).toEqual({
    devLoginEnabled: false,
    ssoEnabled: false,
    ssoStart: null,
    ssoConfigIssue: issues,
  });
  expect((await request.get("/sso/start")).status).toBe(404);
}

describe("command center sso config", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("enables sso when the url, client, secret, and tenant are set", async () => {
    const env = readEnv(
      source({
        CC_SSO_URL: "https://command.example.test/",
        PM_PORTFOLIO_TENANT_ID: PORTFOLIO_TENANT,
      }),
    );
    expect(env.sso).toEqual({
      url: "https://command.example.test",
      clientId: CLIENT_ID,
      clientSecret: SECRET,
      tenantId: TENANT,
    });
    expect(env.ssoConfigIssue).toBeUndefined();
    expect(console.warn).not.toHaveBeenCalled();
    const request = requestFor(env);
    expect((await request.get("/api/v1/auth/config")).body.data).toEqual({
      devLoginEnabled: false,
      ssoEnabled: true,
      ssoStart: "/sso/start",
    });
    const start = await request.get("/sso/start");
    expect(start.status).toBe(303);
    const loc = new URL(start.headers.location!);
    expect(loc.origin + loc.pathname).toBe("https://command.example.test/sso/authorize");
    expect(loc.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(start.headers.location).not.toContain(SECRET);
  });

  it("accepts an http url and PM_PORTFOLIO_TENANT_ID as the tenant", async () => {
    const env = readEnv(
      source({
        CC_SSO_URL: "http://127.0.0.1:8080/",
        SSO_TENANT_ID: undefined,
        PM_PORTFOLIO_TENANT_ID: PORTFOLIO_TENANT,
      }),
    );
    expect(env.sso).toEqual({
      url: "http://127.0.0.1:8080",
      clientId: CLIENT_ID,
      clientSecret: SECRET,
      tenantId: PORTFOLIO_TENANT,
    });
    expect(console.warn).not.toHaveBeenCalled();
    const start = await requestFor(env).get("/sso/start");
    expect(start.status).toBe(303);
    expect(new URL(start.headers.location!).origin).toBe("http://127.0.0.1:8080");
  });

  it.each([
    ["CC_SSO_URL", undefined],
    ["CC_SSO_URL", ""],
    ["CC_SSO_URL", "   "],
    ["CC_SSO_CLIENT_ID", undefined],
    ["CC_SSO_CLIENT_ID", ""],
    ["CC_SSO_CLIENT_ID", "   "],
    ["CC_SSO_CLIENT_SECRET", undefined],
    ["CC_SSO_CLIENT_SECRET", ""],
    ["CC_SSO_CLIENT_SECRET", "   "],
  ] as const)("leaves sso off when %s is missing (%j)", async (key, value) => {
    await expectDisabled({ [key]: value }, [`${key} missing`]);
  });

  it("leaves sso off when no tenant is named", async () => {
    await expectDisabled(
      { SSO_TENANT_ID: undefined, PM_PORTFOLIO_TENANT_ID: "   " },
      ["SSO_TENANT_ID or PM_PORTFOLIO_TENANT_ID missing"],
    );
  });

  it.each(["not a url", "ftp://files.example/do-not-print", "javascript:alert(1)"])(
    "leaves sso off when CC_SSO_URL is not an http(s) url (%j)",
    async (url) => {
      await expectDisabled({ CC_SSO_URL: url }, ["CC_SSO_URL invalid"]);
    },
  );

  it("names every problem in one warning", async () => {
    await expectDisabled(
      {
        CC_SSO_URL: "ftp://files.example/do-not-print",
        CC_SSO_CLIENT_ID: undefined,
        SSO_TENANT_ID: undefined,
      },
      [
        "CC_SSO_URL invalid",
        "CC_SSO_CLIENT_ID missing",
        "SSO_TENANT_ID or PM_PORTFOLIO_TENANT_ID missing",
      ],
    );
  });

  it("leaves sso off and stays quiet when nothing is set", async () => {
    const env = readEnv(source({}, false));
    expect(env.sso).toBeUndefined();
    expect(env.ssoConfigIssue).toBeUndefined();
    expect(console.warn).not.toHaveBeenCalled();
    const request = requestFor(env);
    expect((await request.get("/api/v1/auth/config")).body.data).toEqual({
      devLoginEnabled: false,
      ssoEnabled: false,
      ssoStart: null,
    });
    expect((await request.get("/sso/start")).status).toBe(404);
  });

  it("still refuses to boot when DEV_LOGIN has no token", () => {
    const boom = () =>
      readEnv(source({ NODE_ENV: "staging", DEV_LOGIN: "true" }));
    expect(boom).toThrow(MissingConfigError);
    expect(boom).toThrow("DEV_LOGIN is on but DEV_LOGIN_TOKEN is not set.");
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("does not let an incomplete sso config hide a missing DEV_LOGIN_TOKEN", () => {
    expect(() =>
      readEnv(
        source({
          NODE_ENV: "staging",
          DEV_LOGIN: "true",
          CC_SSO_CLIENT_SECRET: undefined,
        }),
      ),
    ).toThrow("DEV_LOGIN is on but DEV_LOGIN_TOKEN is not set.");
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(warning(["CC_SSO_CLIENT_SECRET missing"]));
    const printed = String(vi.mocked(console.warn).mock.calls[0]?.[0]);
    expect(printed).not.toContain(SECRET);
    expect(printed).not.toContain(CLIENT_ID);
  });

  it("still refuses to boot when DATABASE_URL is missing", () => {
    expect(() =>
      readEnv({
        CC_SSO_URL: "https://command.example.test",
        CC_SSO_CLIENT_ID: CLIENT_ID,
        CC_SSO_CLIENT_SECRET: SECRET,
      } as NodeJS.ProcessEnv),
    ).toThrow(/DATABASE_URL/);
    expect(console.warn).not.toHaveBeenCalled();
  });
});
