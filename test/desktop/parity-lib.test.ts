// Local-parity features, pure pieces: email draft cards (parse, mailto, markdown card), skill creation (name checks,
// SKILL.md text, the file the registry then loads) and the image preview helpers.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMailto, emailPlainText, parseEmail } from "../../desktop/renderer/lib/email.ts";
import { renderMarkdown } from "../../desktop/renderer/lib/markdown.ts";
import { buildSkillMd, validateNewSkill, validateSkillName } from "../../desktop/renderer/lib/skill-md.ts";
import { clampZoom, dataUrl, rotateRight, zoomIn, zoomOut, ZOOM_MAX, ZOOM_MIN } from "../../desktop/renderer/lib/imageview.ts";
import { fromMessages } from "../../desktop/renderer/lib/transcript.ts";
import { isAllowedExternal } from "../../desktop/main/security.ts";
import { createSkill, listSkillViews } from "../../desktop/main/skills.ts";
import { parseSkillFile } from "../../src/skills/skills.ts";

const DRAFT = "To: ann@example.com, bob@example.com\nCc: cy@example.com\nBcc: di@example.com\nSubject: Lunch & learn? 100%\n\nHi all,\n\nSee you at noon.\nThanks";

describe("email drafts", () => {
  test("parses headers and body", () => {
    const d = parseEmail(DRAFT)!;
    expect(d.to).toEqual(["ann@example.com", "bob@example.com"]);
    expect(d.cc).toEqual(["cy@example.com"]);
    expect(d.bcc).toEqual(["di@example.com"]);
    expect(d.subject).toBe("Lunch & learn? 100%");
    expect(d.body).toBe("Hi all,\n\nSee you at noon.\nThanks");
    expect(d.headers.map((h) => h.name)).toEqual(["To", "Cc", "Bcc", "Subject"]);
  });
  test("header names are case-insensitive; CRLF works; a block with no To or Subject is not an email", () => {
    expect(parseEmail("TO: a@b.co\r\nsubject: Hi\r\n\r\nBody")!.body).toBe("Body");
    expect(parseEmail("just some text\nmore")).toBeNull();
    expect(parseEmail("Name: x\n\nbody")).toBeNull();
  });
  test("mailto encodes subject, body, cc and bcc", () => {
    const url = buildMailto(parseEmail(DRAFT)!);
    expect(url.startsWith("mailto:ann@example.com,bob@example.com?")).toBe(true);
    expect(url).toContain("cc=cy@example.com");
    expect(url).toContain("bcc=di@example.com");
    expect(url).toContain("subject=Lunch%20%26%20learn%3F%20100%25");
    expect(url).toContain("body=Hi%20all%2C%0D%0A%0D%0ASee%20you%20at%20noon.%0D%0AThanks");
    const u = new URL(url);
    expect(u.searchParams.get("subject")).toBe("Lunch & learn? 100%");
    expect(u.searchParams.get("body")).toBe("Hi all,\r\n\r\nSee you at noon.\r\nThanks");
  });
  test("mailto with only a recipient has no query", () => {
    expect(buildMailto({ to: ["a@b.co"], cc: [], bcc: [], subject: "", body: "" })).toBe("mailto:a@b.co");
  });
  test("plain text copy keeps headers, a blank line and the body", () => {
    expect(emailPlainText(parseEmail(DRAFT)!)).toBe(DRAFT);
  });
  test("an email fence renders as a card; other fences and malformed email blocks render as before", () => {
    const html = renderMarkdown("Here:\n\n```email\n" + DRAFT + "\n```\n");
    expect(html).toContain('class="email-card"');
    expect(html).toContain("data-email-copy");
    expect(html).toContain("data-email-open");
    expect(html).toContain("Open in mail app");
    expect(html).not.toContain("<pre>");
    const code = renderMarkdown("```ts\nconst a = 1;\n```");
    expect(code).toContain('<pre><code data-lang="ts">');
    expect(code).not.toContain("email-card");
    const bad = renderMarkdown("```email\nnot an email\n```");
    expect(bad).toContain('<pre><code data-lang="email">');
  });
  test("html in an email is escaped", () => {
    const html = renderMarkdown("```email\nTo: a@b.co\nSubject: <b>x</b>\n\n<script>alert(1)</script>\n```");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
  test("the app may hand mailto: links to the OS", () => {
    expect(isAllowedExternal("mailto:a@b.co?subject=x")).toBe(true);
    expect(isAllowedExternal("javascript:alert(1)")).toBe(false);
  });
});

describe("skill names and SKILL.md", () => {
  test("names", () => {
    for (const ok of ["a", "code-review", "x1-y2"]) expect(validateSkillName(ok)).toBe("");
    for (const bad of ["", "Code", "a b", "a_b", "-a", "a-", "a--b", "../x", "a/b", "con", "nul", "x".repeat(65)]) expect(validateSkillName(bad)).not.toBe("");
  });
  test("form needs a description and instructions", () => {
    expect(validateNewSkill({ name: "ok", description: "d", body: "b" })).toEqual([]);
    expect(validateNewSkill({ name: "", description: " ", body: "" }).length).toBe(3);
  });
  test("buildSkillMd is parsed back by the registry parser", () => {
    const text = buildSkillMd({ name: "my-skill", description: 'Uses "quotes": and\nnewlines', body: "Step one.\r\nStep two." });
    const sk = parseSkillFile("x/SKILL.md", text, "user-dir");
    expect(sk.status).toBe("enabled");
    expect(sk.name).toBe("my-skill");
    expect(sk.description).toBe('Uses "quotes": and newlines');
    expect(sk.body).toBe("Step one.\nStep two.");
  });
});

describe("createSkill", () => {
  const saved = process.env.RIGWELL_HOME;
  afterEach(() => { if (saved === undefined) delete process.env.RIGWELL_HOME; else process.env.RIGWELL_HOME = saved; });

  test("writes a user skill that the list then shows; refuses to overwrite without confirm", () => {
    const home = mkdtempSync(join(tmpdir(), "rigwell-skill-home-"));
    process.env.RIGWELL_HOME = home;
    const cwd = mkdtempSync(join(tmpdir(), "rigwell-skill-cwd-"));
    const input = { name: "demo-skill", description: "Does the demo", body: "Do the demo steps carefully, one by one, and report.", scope: "user" as const };
    const r = createSkill(cwd, input);
    expect(r.ok).toBe(true);
    const file = join(home, "skills", "demo-skill", "SKILL.md");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("name: demo-skill");
    const v = listSkillViews(cwd).find((s) => s.name === "demo-skill")!;
    expect(v.bucket).toBe("user-dir");
    expect(v.status).toBe("enabled");
    expect(v.description).toBe("Does the demo");

    const again = createSkill(cwd, { ...input, body: "A different body for the second write, long enough." });
    expect(again).toMatchObject({ ok: false, exists: true });
    expect(readFileSync(file, "utf8")).toContain("Do the demo steps");
    expect(createSkill(cwd, { ...input, body: "Replaced body for the confirmed overwrite.", overwrite: true }).ok).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("Replaced body");
  });

  test("project scope needs a project folder; bad names never touch the disk", () => {
    const home = mkdtempSync(join(tmpdir(), "rigwell-skill-home-"));
    process.env.RIGWELL_HOME = home;
    const proj = mkdtempSync(join(tmpdir(), "rigwell-skill-proj-"));
    mkdirSync(join(proj, ".git"));
    writeFileSync(join(proj, ".git", "HEAD"), "ref: refs/heads/main\n");
    const r = createSkill(proj, { name: "proj-skill", description: "d", body: "Project instructions that are long enough to pass.", scope: "project" });
    expect(r).toMatchObject({ ok: true });
    expect(existsSync(join(proj, ".rigwell", "skills", "proj-skill", "SKILL.md"))).toBe(true);
    expect(listSkillViews(proj).find((s) => s.name === "proj-skill")!.bucket).toBe("project-dir");
    expect(createSkill(proj, { name: "../evil", description: "d", body: "b", scope: "user" }).ok).toBe(false);
    expect(existsSync(join(home, "evil"))).toBe(false);
    expect(createSkill("", { name: "p2", description: "d", body: "b", scope: "project" })).toMatchObject({ ok: false });
  });
});

describe("image preview helpers", () => {
  test("zoom is clamped and symmetric around fit", () => {
    expect(zoomIn(1)).toBeCloseTo(1.25);
    expect(zoomOut(zoomIn(1))).toBeCloseTo(1, 2);
    expect(clampZoom(100)).toBe(ZOOM_MAX);
    expect(clampZoom(0)).toBe(ZOOM_MIN);
    expect(rotateRight(270)).toBe(0);
    expect(dataUrl({ mediaType: "image/gif", data: "AAA" })).toBe("data:image/gif;base64,AAA");
  });
  test("stored user messages with images become a user item with images", () => {
    const items = fromMessages([{ id: "m1", role: "user", content: [{ type: "text", text: "look" }, { type: "image", mediaType: "image/png", data: "QUJD" }] }]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "user", text: "look", images: [{ mediaType: "image/png", data: "QUJD" }] });
  });
});
