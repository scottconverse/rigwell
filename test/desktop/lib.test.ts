// Pure pieces of the desktop app: markdown, transcript model, syntax highlighting, security helpers, sounds, settings.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { highlight } from "../../desktop/renderer/lib/highlight.ts";
import { renderMarkdown } from "../../desktop/renderer/lib/markdown.ts";
import { fromMessages, mainArg, reduce, toMarkdown, type Item } from "../../desktop/renderer/lib/transcript.ts";
import { browserPermission, buildCsp, isAllowedExternal, isTrustedSender, normalizeBrowserUrl, parseDeepLink } from "../../desktop/main/security.ts";
import { loadDesktopSettings, updateDesktopSettings } from "../../desktop/main/settings.ts";
import { synthWav } from "../../desktop/main/sounds.ts";

describe("markdown", () => {
  test("renders common blocks and escapes everything else", () => {
    const html = renderMarkdown("# Title\n\nSome **bold** and `code <b>` and [link](https://example.com).\n\n- a\n- b\n\n| h1 | h2 |\n|----|----|\n| 1 | 2 |\n\n```ts\nconst x = '<script>';\n```");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>code &lt;b&gt;</code>");
    expect(html).toContain('<a href="https://example.com"');
    expect(html).toContain("<li>a</li>");
    expect(html).toContain("<th>h1</th>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
  test("drops unsafe link schemes and raw html", () => {
    const html = renderMarkdown("[x](javascript:alert(1)) <img src=x onerror=alert(1)>");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<img");
  });
});

describe("transcript model", () => {
  test("stored messages become bubbles, text and tool rows; hidden ones are skipped", () => {
    const items = fromMessages([
      { id: "c", role: "user", visibility: "llm_only", content: [{ type: "text", text: "context" }] },
      { id: "u", role: "user", content: [{ type: "text", text: "fix it" }] },
      { id: "a", role: "assistant", content: [{ type: "text", text: "Looking." }, { type: "tool_use", id: "t1", name: "Read", input: { path: "a.js" } }] },
      { id: "r", role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file body" }] },
    ]);
    expect(items.map((i) => i.kind)).toEqual(["user", "assistant", "tool"]);
    const tool = items[2] as Extract<Item, { kind: "tool" }>;
    expect(tool).toMatchObject({ name: "Read", status: "ok", output: "file body" });
    expect(mainArg("Read", tool.input)).toBe("a.js");
    expect(toMarkdown(items)).toContain("> Read `a.js`");
  });
  test("notifications stream text, replace tool calls by id and finish them", () => {
    let items: Item[] = [];
    items = reduce(items, { type: "assistant_text_delta", messageId: "m", blockIndex: 0, textDelta: "Hel" });
    items = reduce(items, { type: "assistant_text_delta", messageId: "m", blockIndex: 0, textDelta: "lo" });
    items = reduce(items, { type: "tool_call", toolUse: { id: "t", name: "Execute", input: {} } });
    items = reduce(items, { type: "tool_call", toolUse: { id: "t", name: "Execute", input: { command: "ls" } } });
    items = reduce(items, { type: "tool_progress_update", toolUseId: "t", toolName: "Execute", update: { fullOutput: "partial" } });
    expect(items.length).toBe(2);
    expect((items[0] as any).text).toBe("Hello");
    expect((items[1] as any)).toMatchObject({ status: "running", live: "partial", input: { command: "ls" } });
    items = reduce(items, { type: "tool_result", toolUseId: "t", content: "done", isError: true });
    expect((items[1] as any)).toMatchObject({ status: "error", output: "done" });
    items = reduce(items, { type: "agent_turn_completed", reason: "cancelled" });
    expect((items.at(-1) as any).text).toBe("Turn ended: cancelled");
  });
});

describe("highlight", () => {
  test("marks keywords, strings, comments and numbers, and escapes the rest", () => {
    const h = highlight("const a = 'x<y'; // note\nreturn 42 < 1", "x.ts");
    expect(h).toContain('<span class="tk-k">const</span>');
    expect(h).toContain('<span class="tk-s">&#39;x&lt;y&#39;</span>');
    expect(h).toContain('<span class="tk-c">// note</span>');
    expect(h).toContain('<span class="tk-n">42</span>');
    expect(h).toContain("</span> &lt; <span");
  });
});

describe("security helpers (spec 14.6)", () => {
  test("external links: web, files and editor schemes only", () => {
    for (const ok of ["https://a.test", "http://a.test", "file:///x", "vscode://file/x", "cursor://file/x", "zed://file/x"]) expect(isAllowedExternal(ok)).toBe(true);
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "ms-msdt:/x", "smb://host/x", "not a url"]) expect(isAllowedExternal(bad)).toBe(false);
  });
  test("CSP allows only self, the loopback daemon port and configured model hosts", () => {
    const csp = buildCsp({ daemonPort: 4000, modelHosts: ["https://api.example.com/v1"] });
    expect(csp).toContain("connect-src 'self' ws://127.0.0.1:4000 http://127.0.0.1:4000 https://api.example.com");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toContain("frame-src 'none'");
  });
  test("IPC sender must be the app page", () => {
    const page = "file:///app/dist/renderer/index.html";
    expect(isTrustedSender(page + "#/sessions/1", [page])).toBe(true);
    expect(isTrustedSender("https://evil.test/", [page])).toBe(false);
    expect(isTrustedSender(undefined, [page])).toBe(false);
    expect(isTrustedSender("file:///app/dist/renderer/index.html.evil/x", [page])).toBe(false);
  });
  test("browser permissions: device access is always denied", () => {
    expect(browserPermission("media")).toBe("deny");
    expect(browserPermission("hid")).toBe("deny");
    expect(browserPermission("geolocation")).toBe("prompt");
    expect(browserPermission("fullscreen")).toBe("allow");
  });
  test("address bar input and deep links", () => {
    expect(normalizeBrowserUrl("localhost:3000/x")).toBe("http://localhost:3000/x");
    expect(normalizeBrowserUrl("example.com")).toBe("https://example.com");
    expect(normalizeBrowserUrl("how to cook rice")).toContain("duckduckgo.com");
    expect(parseDeepLink("rigwell://sessions/abc")).toEqual({ kind: "navigate", route: "/sessions/abc" });
    expect(parseDeepLink("rigwell://mcp-callback?code=c&state=s")).toEqual({ kind: "mcp-callback", code: "c", state: "s" });
    expect(parseDeepLink("rigwell://mcp-callback?code=c")).toBeUndefined();
    expect(parseDeepLink("rigwell://sessions/../../x%00")).toBeUndefined();
    expect(parseDeepLink("https://example.com")).toBeUndefined();
  });
});

describe("sounds and settings", () => {
  test("built-in sounds are valid WAV files", () => {
    for (const id of ["ok", "ack"] as const) {
      const w = synthWav(id);
      expect(w.subarray(0, 4).toString()).toBe("RIFF");
      expect(w.subarray(8, 12).toString()).toBe("WAVE");
      expect(w.readUInt32LE(40)).toBe(w.length - 44);
      expect(w.length).toBeGreaterThan(2000);
    }
  });
  test("settings: defaults, deep-merge updates, persistence and sanitizing", () => {
    const home = mkdtempSync(join(tmpdir(), "rigwell-set-"));
    expect(loadDesktopSettings(home).sounds.awaitingInputSound).toBe("ack");
    const s = updateDesktopSettings(home, { sounds: { soundVolume: 250, soundFocusMode: "bogus" }, notifications: { finished: false } });
    expect(s.sounds.soundVolume).toBe(100);
    expect(s.sounds.soundFocusMode).toBe("always");
    expect(s.notifications).toEqual({ finished: false, needsInput: true });
    expect(loadDesktopSettings(home).notifications.finished).toBe(false);
  });
});

describe("markdown math and diagrams (spec 14.7)", () => {
  test("inline and block math become data-tex nodes, escaped; prices stay text", () => {
    const html = renderMarkdown("Euler $e^{i\\pi}+1=0$ costs $5 and $6.\n\n$$\n\\frac{a}{b}\n$$\n\n$$x<y$$");
    expect(html).toContain('<span class="math" data-tex="e^{i\\pi}+1=0">');
    expect(html).toContain("costs $5 and $6.");
    expect(html).toContain('<div class="math-block" data-tex="\\frac{a}{b}">');
    expect(html).toContain('data-tex="x&lt;y"');
    expect(html).not.toContain("<y");
  });
  test("math is not taken from code, and mermaid fences keep their language for the renderer", () => {
    expect(renderMarkdown("`$a$ and $b$`")).not.toContain("data-tex");
    expect(renderMarkdown("```mermaid\ngraph TD\n A-->B\n```")).toContain('<code data-lang="mermaid">graph TD\n A--&gt;B</code>');
  });
});
