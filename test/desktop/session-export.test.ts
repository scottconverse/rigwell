import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpEnv } from "../storage/helpers.ts";
import { saveSessionExport } from "../../desktop/main/session-export.ts";
import { parseSharedSession, renderSharedSession, type SharedSession } from "../../src/sharing/format.ts";

test("desktop export rebuilds safe content and writes only after the user's chosen save path", async () => {
  const env = tmpEnv(), value: SharedSession = { schemaVersion: 1, title: "![external](https://example.invalid/pixel)", exportedAt: new Date().toISOString(), messages: [{ role: "user", text: '<script>window.evil=true</script>' }] };
  const content = renderSharedSession(value, "html"), file = join(env.root, "saved.html");
  let choices = 0;
  try {
    expect(await saveSessionExport("html", content, async () => { choices++; return null; })).toBeNull(); expect(existsSync(file)).toBe(false);
    const tampered = content.replace("<body>", '<body><script>untrusted caller code</script>');
    expect(await saveSessionExport("html", tampered, async () => file)).toBe(file);
    const saved = readFileSync(file, "utf8"); expect(saved).not.toContain("<script>"); expect(saved).not.toContain("untrusted caller code"); expect(parseSharedSession(saved)).toEqual(value);
    expect(renderSharedSession(value, "markdown")).not.toContain("# ![external](");
    let failure: unknown; try { await saveSessionExport("html", "<script>invalid payload</script>", async () => { choices++; return file; }); } catch (e) { failure = e; }
    expect(String(failure)).toContain("supported"); expect(choices).toBe(1);
  } finally { env.cleanup(); }
});
