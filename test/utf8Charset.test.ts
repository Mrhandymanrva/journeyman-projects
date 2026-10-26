import supertest from "supertest";
import { describe, expect, it } from "vitest";
import type { Database } from "../src/db/database.js";
import { createApp } from "../src/app.js";
import { MemoryStaffSessions } from "../src/http/memoryStaffSessions.js";
import { contentTypeWithUtf8 } from "../src/http/utf8Charset.js";

const MINUS = "\u2212";

function app() {
  return supertest(
    createApp({
      database: {} as Database,
      staffSessions: new MemoryStaffSessions(),
      serveConsole: true,
    }),
  );
}

function signedFrom(source: string): (n: number) => string {
  const match = /const signed = \(n\) =>\s*([\s\S]*?);/.exec(source);
  if (!match?.[1]) throw new Error("served console.js has no signed()");
  return new Function(`return (n) => (${match[1]});`)() as (n: number) => string;
}

describe("utf-8 responses", () => {
  it("names charset=utf-8 on a content type that is text, script, or json", () => {
    expect(contentTypeWithUtf8("text/html")).toBe("text/html; charset=utf-8");
    expect(contentTypeWithUtf8("application/javascript; charset=UTF-8")).toBe(
      "application/javascript; charset=utf-8",
    );
    expect(contentTypeWithUtf8("text/css; charset=iso-8859-1")).toBe("text/css; charset=utf-8");
    expect(contentTypeWithUtf8("application/json")).toBe("application/json; charset=utf-8");
    expect(contentTypeWithUtf8("text/csv")).toBe("text/csv");
    expect(contentTypeWithUtf8("application/pdf")).toBe("application/pdf");
  });

  it("serves the console in utf-8 and renders the over-budget minus as −$250", async () => {
    const request = app();
    const script = await request.get("/console.js");
    expect(script.status).toBe(200);
    expect(script.headers["content-type"]).toBe("application/javascript; charset=utf-8");
    expect(script.text).not.toContain("\u00e2\u02c6\u2019");
    const signed = signedFrom(script.text);
    expect(signed(-250)).toBe(`${MINUS}$250`);
    expect(signed(250)).toBe("+$250");

    const page = await request.get("/");
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(page.text).toContain('<meta charset="utf-8">');

    const bid = await request.get("/bid-response.html");
    expect(bid.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(bid.text).toContain('<meta charset="utf-8">');

    const css = await request.get("/tokens.css");
    expect(css.status).toBe(200);
    expect(css.headers["content-type"]).toBe("text/css; charset=utf-8");

    const health = await request.get("/health");
    expect(health.status).toBe(200);
    expect(health.headers["content-type"]).toBe("application/json; charset=utf-8");
  });
});
