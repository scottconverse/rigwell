import { afterEach, expect, test } from "bun:test";
import { clearProviderLimits, parseDurationMs, parseProviderLimits, readProviderLimits, recordProviderLimits } from "../../src/adapters/provider-limits.ts";
import { sseRequest } from "../../src/adapters/sse.ts";
import { spendPeriodResetAt } from "../../src/spend/config.ts";

const NOW = Date.parse("2026-11-21T12:00:00Z");
afterEach(clearProviderLimits);

const ANTHROPIC = new Headers({
  "anthropic-ratelimit-requests-limit": "50", "anthropic-ratelimit-requests-remaining": "49", "anthropic-ratelimit-requests-reset": "2026-11-21T12:00:30Z",
  "anthropic-ratelimit-tokens-limit": "80000", "anthropic-ratelimit-tokens-remaining": "79000", "anthropic-ratelimit-tokens-reset": "2026-11-21T12:01:00Z",
  "x-api-key": "must-not-be-kept",
});
const OPENAI = new Headers({
  "x-ratelimit-limit-requests": "60", "x-ratelimit-remaining-requests": "59", "x-ratelimit-reset-requests": "1s",
  "x-ratelimit-limit-tokens": "150000", "x-ratelimit-remaining-tokens": "149984", "x-ratelimit-reset-tokens": "6m0s",
});

test("reads the recorded Anthropic sample with absolute reset times", () => {
  expect(parseProviderLimits(ANTHROPIC, NOW)).toEqual([
    { name: "Requests", limit: 50, remaining: 49, resetAt: NOW + 30_000 },
    { name: "Tokens", limit: 80000, remaining: 79000, resetAt: NOW + 60_000 },
  ]);
});

test("reads the recorded OpenAI sample and turns durations into absolute times", () => {
  expect(parseProviderLimits(OPENAI, NOW)).toEqual([
    { name: "Requests", limit: 60, remaining: 59, resetAt: NOW + 1000 },
    { name: "Tokens", limit: 150000, remaining: 149984, resetAt: NOW + 360_000 },
  ]);
  expect(parseDurationMs("120ms")).toBe(120);
  expect(parseDurationMs("1h2m3s")).toBe(3_723_000);
  expect(parseDurationMs("soon")).toBeNull();
});

test("a provider without limit headers is not available and is never estimated", () => {
  recordProviderLimits("https://generativelanguage.googleapis.com/v1beta/models/x", new Headers({ "content-type": "text/event-stream" }), NOW);
  expect(readProviderLimits(NOW)).toEqual([{ provider: "generativelanguage.googleapis.com", capturedAt: NOW, available: false, limits: [] }]);
});

test("malformed values are dropped", () => {
  expect(parseProviderLimits(new Headers({ "x-ratelimit-limit-requests": "many", "x-ratelimit-remaining-requests": "-1" }), NOW)).toEqual([]);
});

test("a reset time in the past hides the old remaining count", () => {
  recordProviderLimits("https://api.openai.com/v1/responses", OPENAI, NOW);
  const later = readProviderLimits(NOW + 2000)[0]!.limits;
  expect(later[0]).toMatchObject({ name: "Requests", remaining: null, resetPassed: true });
  expect(later[1]).toMatchObject({ name: "Tokens", remaining: 149984, resetPassed: false });
});

test("keeps only the host, and a later response without headers keeps the last report", () => {
  recordProviderLimits("https://user:secret@api.anthropic.com/v1/messages?key=abc", ANTHROPIC, NOW);
  recordProviderLimits("https://api.anthropic.com/v1/messages", new Headers(), NOW + 1000);
  const [entry] = readProviderLimits(NOW + 1000);
  expect(entry).toMatchObject({ provider: "api.anthropic.com", capturedAt: NOW, available: true });
  expect(JSON.stringify(readProviderLimits(NOW))).not.toMatch(/secret|key=abc|must-not-be-kept/);
});

test("a bad URL does not throw", () => {
  expect(() => recordProviderLimits("not a url", OPENAI, NOW)).not.toThrow();
  expect(readProviderLimits(NOW)).toEqual([]);
});

test("the request path captures limits from a refused response", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("slow down", { status: 429, headers: { "x-ratelimit-limit-requests": "60", "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "30s" } }) });
  try {
    await expect((async () => { for await (const _ of sseRequest(`http://127.0.0.1:${server.port}/v1/x`, { headers: {}, body: "{}" }, undefined, 5000)) { /* no events */ } })()).rejects.toBeDefined();
    expect(readProviderLimits()[0]).toMatchObject({ provider: `127.0.0.1:${server.port}`, available: true, limits: [{ name: "Requests", limit: 60, remaining: 0 }] });
  } finally { await server.stop(true); }
});

test("spend periods reset at the next UTC day and month", () => {
  expect(spendPeriodResetAt("day", new Date("2026-11-30T23:59:00Z"))).toBe(Date.parse("2026-12-01T00:00:00Z"));
  expect(spendPeriodResetAt("month", new Date("2026-12-15T08:00:00Z"))).toBe(Date.parse("2027-01-01T00:00:00Z"));
});
