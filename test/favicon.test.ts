import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import supertest from "supertest";
import { createApp } from "../src/app.js";
import { ICON_LINK_TAGS } from "../src/http/icons.js";
import { MemoryStaffSessions } from "../src/http/memoryStaffSessions.js";
import { SCHEMA_FILES, startHarness, type Harness } from "./support/harness.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(here, "../client");

/** SHA-256 of the Command Center files copied into client/. */
const ICONS: Record<string, { file: string; type: string; sha256?: string }> = {
  "/favicon.svg": {
    file: "favicon.svg",
    type: "image/svg+xml",
    sha256: "50f8dbc468e37a490b3a1047d6303c853809696d9e0549840b60cd6359494b9b",
  },
  "/favicon.ico": {
    file: "favicon.ico",
    type: "image/x-icon",
    sha256: "6e925f9f25993f590fb15cd1c3042aa643f26259242597ead98e03973987d76e",
  },
  "/apple-touch-icon.png": {
    file: "apple-touch-icon.png",
    type: "image/png",
    sha256: "d96b88a497b23cf4ca0fc8c4f6e9436563a0bdb9b53d2e5cd36683c8a4789a78",
  },
  "/icon-192.png": {
    file: "icon-192.png",
    type: "image/png",
    sha256: "c695140e87812c8628ef7d251fa73b9e8727d1a00e5d690b4c8b5824ea198440",
  },
  "/icon-512.png": {
    file: "icon-512.png",
    type: "image/png",
    sha256: "9dc318e78ff3b519ffa3362a290d2c9dd41ef61cc87866cb8a93545753e73c61",
  },
  "/manifest.webmanifest": {
    file: "manifest.webmanifest",
    type: "application/manifest+json",
  },
};

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function expectIconLinks(html: string): void {
  for (const tag of ICON_LINK_TAGS) expect(html).toContain(tag);
}

function readBody(
  res: supertest.Response,
  done: (err: Error | null, body: Buffer) => void,
): void {
  const chunks: Buffer[] = [];
  res.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  res.on("end", () => done(null, Buffer.concat(chunks)));
}

let h: Harness;

beforeAll(async () => {
  h = await startHarness(SCHEMA_FILES);
});
afterAll(async () => {
  await h?.close();
});

describe("Command Center favicon", () => {
  it("puts the icon links on every served HTML page", async () => {
    for (const file of ["index.html", "bid-response.html"]) {
      expectIconLinks(readFileSync(path.join(clientDir, file), "utf8"));
    }

    const app = supertest(
      createApp({
        database: h.db,
        staffSessions: new MemoryStaffSessions(),
        serveConsole: true,
        sso: {
          url: "https://command.example.test",
          clientId: "jp-favicon",
          clientSecret: "jp-favicon-secret",
          tenantId: "00000000-0000-4000-8000-000000000001",
        },
      }),
    );

    const home = await app.get("/");
    expect(home.status).toBe(200);
    expect(home.type).toBe("text/html");
    expectIconLinks(home.text);
    expect(home.text).toContain("Project Console — Journeyman Projects");

    const bid = await app.get("/bid-response.html");
    expect(bid.status).toBe(200);
    expectIconLinks(bid.text);

    const signInError = await app.get("/sso/callback");
    expect(signInError.status).toBe(400);
    expect(signInError.type).toBe("text/html");
    expectIconLinks(signInError.text);
    expect(signInError.text).toContain("Sign-in did not complete");
  });

  it("serves the icon files to a request with no session", async () => {
    const app = supertest(
      createApp({
        database: h.db,
        staffSessions: new MemoryStaffSessions(),
        serveConsole: true,
      }),
    );

    for (const [route, icon] of Object.entries(ICONS)) {
      const onDisk = readFileSync(path.join(clientDir, icon.file));
      if (icon.sha256) expect(sha256(onDisk)).toBe(icon.sha256);

      const res = await app.get(route).buffer(true).parse(readBody);
      expect(res.status, route).toBe(200);
      expect(res.type, route).toBe(icon.type);
      const body = res.body as Buffer;
      expect(Buffer.isBuffer(body), route).toBe(true);
      expect(sha256(body), route).toBe(icon.sha256 ?? sha256(onDisk));
      if (route === "/manifest.webmanifest") {
        expect(JSON.parse(body.toString("utf8"))).toMatchObject({
          name: "Journeyman Projects",
          short_name: "Projects",
          start_url: "/",
          background_color: "#141e2c",
          theme_color: "#141e2c",
          icons: [
            { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
            { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
            { src: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
          ],
        });
      }

      const authed = await app
        .get(route)
        .set("Authorization", "Bearer not-a-staff-session")
        .buffer(true)
        .parse(readBody);
      expect(authed.status, route).toBe(200);
      expect(sha256(authed.body as Buffer), route).toBe(icon.sha256 ?? sha256(onDisk));
    }
  });
});
