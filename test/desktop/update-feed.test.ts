// Update check (spec 14.5) against a local static feed served by Bun.serve. No real hosts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { checkForUpdate, compareVersions, describeCheck, feedDocumentUrl } from "../../desktop/main/update-feed.ts";

let srv: ReturnType<typeof Bun.serve>;
let base = "";
const hits: string[] = [];

beforeAll(() => {
  srv = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(req) {
      const p = new URL(req.url).pathname;
      hits.push(p);
      if (p === "/newer/latest-linux.yml" || p === "/newer/latest.yml" || p === "/newer/latest-mac.yml")
        return new Response("version: 1.4.0\nreleaseDate: '2026-11-01T00:00:00.000Z'\nreleaseNotes: Faster startup\nfiles:\n  - url: rigwell-1.4.0-x86_64.AppImage\n    sha512: abc\n    size: 10\npath: rigwell-1.4.0-x86_64.AppImage\n");
      if (p === "/same/latest-linux.yml") return new Response("version: 0.1.0\npath: rigwell-0.1.0.AppImage\n");
      if (p === "/older/latest-linux.yml") return new Response("version: 0.0.9\n");
      if (p === "/doc.json") return Response.json({ version: "2.0.0", files: [{ url: "https://dl.example/r.zip" }] });
      if (p === "/bad/latest-linux.yml") return new Response("not: a feed\n");
      if (p === "/garbage/latest-linux.yml") return new Response("{{{ : [");
      return new Response("nope", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${srv.port}`;
});
afterAll(() => srv.stop(true));

describe("compareVersions", () => {
  test("orders releases and prereleases", () => {
    expect(compareVersions("1.4.0", "0.1.0")).toBeGreaterThan(0);
    expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
    expect(compareVersions("0.1.10", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0-beta.2")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-beta.10", "1.0.0-beta.2")).toBeGreaterThan(0);
    expect(() => compareVersions("x", "1.0.0")).toThrow();
  });
});

describe("feed document url", () => {
  test("per platform file names; a document url is used as is", () => {
    expect(feedDocumentUrl("https://h/p/", "linux")).toBe("https://h/p/latest-linux.yml");
    expect(feedDocumentUrl("https://h/p", "darwin")).toBe("https://h/p/latest-mac.yml");
    expect(feedDocumentUrl("https://h/p", "win32")).toBe("https://h/p/latest.yml");
    expect(feedDocumentUrl("https://h/x/feed.json", "linux")).toBe("https://h/x/feed.json");
  });
});

describe("checkForUpdate against a local feed", () => {
  test("newer version: available, with notes, date and an absolute download url", async () => {
    const r = await checkForUpdate({ feedUrl: `${base}/newer`, currentVersion: "0.1.0", platform: "linux" });
    expect(r).toEqual({ status: "available", version: "1.4.0", releaseDate: "2026-11-01T00:00:00.000Z", notes: "Faster startup", downloadUrl: `${base}/newer/rigwell-1.4.0-x86_64.AppImage` });
    expect(describeCheck(r)).toContain("1.4.0 is available");
    expect(hits).toContain("/newer/latest-linux.yml");
  });
  test("same version and older feed: up to date", async () => {
    expect(await checkForUpdate({ feedUrl: `${base}/same`, currentVersion: "0.1.0", platform: "linux" })).toEqual({ status: "up-to-date", version: "0.1.0" });
    expect((await checkForUpdate({ feedUrl: `${base}/older`, currentVersion: "0.1.0", platform: "linux" })).status).toBe("up-to-date");
    expect(describeCheck({ status: "up-to-date", version: "0.1.0" })).toContain("up to date");
  });
  test("a JSON document url works", async () => {
    const r = await checkForUpdate({ feedUrl: `${base}/doc.json`, currentVersion: "1.9.9", platform: "linux" });
    expect(r).toMatchObject({ status: "available", version: "2.0.0", downloadUrl: "https://dl.example/r.zip" });
  });
  test("no feed, missing feed, bad documents and bad urls report clearly", async () => {
    expect(await checkForUpdate({ feedUrl: "", currentVersion: "0.1.0" })).toEqual({ status: "no-feed" });
    expect(await checkForUpdate({ feedUrl: undefined, currentVersion: "0.1.0" })).toEqual({ status: "no-feed" });
    expect(await checkForUpdate({ feedUrl: `${base}/missing`, currentVersion: "0.1.0", platform: "linux" })).toMatchObject({ status: "error", message: expect.stringContaining("404") });
    expect(await checkForUpdate({ feedUrl: `${base}/bad`, currentVersion: "0.1.0", platform: "linux" })).toMatchObject({ status: "error", message: expect.stringContaining("no version") });
    expect((await checkForUpdate({ feedUrl: `${base}/garbage`, currentVersion: "0.1.0", platform: "linux" })).status).toBe("error");
    expect((await checkForUpdate({ feedUrl: "file:///etc/passwd", currentVersion: "0.1.0" })).status).toBe("error");
    expect((await checkForUpdate({ feedUrl: "not a url", currentVersion: "0.1.0" })).status).toBe("error");
    expect((await checkForUpdate({ feedUrl: "http://127.0.0.1:1/", currentVersion: "0.1.0", platform: "linux", timeoutMs: 1000 })).status).toBe("error");
  });
});
