// Final gap wave, desktop side: pure pieces (attachments, prompt answers, per-window zoom, project archive) and the
// session controller sending attachments to a real daemon.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import type { FakeServer } from "../fakes/types.ts";
import { makeRepo } from "../e2e/helpers.ts";
import { SocketTransport, type Transport } from "../../src/sdk/transport.ts";
import { classify, defaultText, looksLikeText, readAttachment, toParams, MAX_IMAGE } from "../../desktop/renderer/lib/attachments.ts";
import { answerText, permissionAnswer, questionOptions } from "../../desktop/renderer/lib/prompts.ts";
import { projectArchiveTargets, type SessionRow } from "../../desktop/renderer/lib/sessions.ts";
import { SessionController } from "../../desktop/renderer/lib/session.ts";
import { clampZoom, freeSlot, loadZoom, saveZoom, stepZoom, zoomFor } from "../../desktop/main/window-zoom.ts";
import { MODEL, sleep, startTestDaemon } from "./helpers.ts";

const file = (name: string, type: string, bytes: Uint8Array) => ({ name, type, size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer });
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

describe("attachments", () => {
  test("classify by type, then by extension", () => {
    expect(classify("a.png", "image/png")).toBe("image");
    expect(classify("shot", "image/webp")).toBe("image");
    expect(classify("a.PDF", "")).toBe("pdf");
    expect(classify("notes.md", "text/markdown")).toBe("text");
    expect(classify("a.bin", "application/octet-stream")).toBe("unknown");
  });

  test("images and PDFs are base64, text files stay text, unknown files are text only when they decode", async () => {
    const img = await readAttachment(file("a.png", "image/png", PNG));
    expect(img).toMatchObject({ ok: true, attachment: { kind: "image", mediaType: "image/png", data: Buffer.from(PNG).toString("base64") } });
    const txt = await readAttachment(file("main.ts", "", new TextEncoder().encode("const x = 1;\n")));
    expect(txt).toMatchObject({ ok: true, attachment: { kind: "text", mediaType: "text/plain", data: "const x = 1;\n" } });
    const bin = await readAttachment(file("blob.dat", "", new Uint8Array([0, 1, 2, 3])));
    expect(bin).toMatchObject({ ok: false });
    expect(looksLikeText(new Uint8Array([0xff, 0xfe, 0xfd]))).toBe(false);
  });

  test("oversized files are refused with the name", async () => {
    const big = { name: "big.png", type: "image/png", size: MAX_IMAGE + 1, arrayBuffer: async () => new ArrayBuffer(0) };
    expect(await readAttachment(big)).toEqual({ ok: false, name: "big.png", error: "is over 5 MiB" });
  });

  test("toParams splits images from files and defaultText names them", async () => {
    const a = (await readAttachment(file("a.png", "image/png", PNG))) as any;
    const b = (await readAttachment(file("n.txt", "text/plain", new TextEncoder().encode("hi")))) as any;
    const p = toParams([a.attachment, b.attachment]);
    expect(p.images).toEqual([{ mediaType: "image/png", data: a.attachment.data }]);
    expect(p.files).toEqual([{ name: "n.txt", mediaType: "text/plain", data: "hi" }]);
    expect(toParams([])).toEqual({});
    expect(defaultText([a.attachment, b.attachment])).toBe("Attached: a.png, n.txt");
  });
});

describe("prompt answers", () => {
  test("permission answers carry the comment, and the edited plan only with proceed_edit", () => {
    expect(permissionAnswer("proceed_once")).toEqual({ selectedOption: "proceed_once" });
    expect(permissionAnswer("cancel", { comment: "  use a dry run  " })).toEqual({ selectedOption: "cancel", comment: "use a dry run" });
    expect(permissionAnswer("proceed_edit", { comment: "go", editedSpec: "# New" })).toEqual({ selectedOption: "proceed_edit", comment: "go", editedSpecContent: "# New" });
    expect(permissionAnswer("proceed_once", { editedSpec: "# New" })).toEqual({ selectedOption: "proceed_once" });
  });
  test("free-text answers join with ticked options", () => {
    expect(answerText([], "duckdb")).toBe("duckdb");
    expect(answerText(["a", "b"], "  c ")).toBe("a, b, c");
    expect(answerText(["a"], "   ")).toBe("a");
    expect(questionOptions({ options: [] })).toEqual(["Yes", "No"]);
  });
});

describe("Archive Project targets", () => {
  const row = (id: string, cwd: string, extra: Partial<SessionRow> = {}): SessionRow => ({ id, title: id, cwd, updatedAt: 1, ...extra });
  test("only the project's visible, unarchived sessions", () => {
    const rows = [row("a", "/p"), row("b", "/p", { archivedAt: 5 }), row("c", "/q"), row("d", "/p", { isSubagent: true }), row("e", "/p")];
    expect(projectArchiveTargets(rows, "/p").map((r) => r.id)).toEqual(["a", "e"]);
  });
});

describe("per-window zoom (window-zoom.json)", () => {
  test("slots are the lowest free number; levels are saved per slot and read back", () => {
    expect(freeSlot([])).toBe(0);
    expect(freeSlot([0, 1, 3])).toBe(2);
    const home = mkdtempSync(join(tmpdir(), "rigwell-zoom-"));
    expect(loadZoom(home)).toEqual({});
    saveZoom(home, 0, 1);
    saveZoom(home, 1, -0.5);
    expect(JSON.parse(readFileSync(join(home, "window-zoom.json"), "utf8"))).toEqual({ "0": 1, "1": -0.5 });
    expect(zoomFor(home, 0, 0)).toBe(1);
    expect(zoomFor(home, 2, 0.5)).toBe(0.5); // no entry: the app-wide level
    saveZoom(home, 1, 0);
    expect(zoomFor(home, 1, 2)).toBe(0); // an explicit reset stays
  });
  test("steps and limits", () => {
    expect(stepZoom(0, 1)).toBe(0.5);
    expect(stepZoom(2, 0)).toBe(0);
    expect(stepZoom(5, 1)).toBe(5);
    expect(clampZoom(-99)).toBe(-3);
    expect(clampZoom("x")).toBe(0);
  });
  test("a damaged file is ignored", () => {
    const home = mkdtempSync(join(tmpdir(), "rigwell-zoom-"));
    writeFileSync(join(home, "window-zoom.json"), "{not json");
    expect(loadZoom(home)).toEqual({});
    writeFileSync(join(home, "window-zoom.json"), JSON.stringify({ "0": 1, x: 2, "1": "no" }));
    expect(loadZoom(home)).toEqual({ "0": 1 });
    expect(existsSync(home)).toBe(true);
  });
});

// ---- the controller sends attachments to the harness (renderer code run in bun over the daemon socket)
const servers: FakeServer[] = [];
afterAll(() => { servers.forEach((s) => s.stop()); delete (globalThis as any).window; });
const target = { socketPath: "" };
const conns = new Map<number, Transport>();
const listeners: ((e: { connId: number; message: string }) => void)[] = [];
const closedL: ((e: { connId: number }) => void)[] = [];
let connN = 0;
const bridge = {
  rigwell: {
    daemon: {
      open: async () => {
        const id = ++connN;
        const t = await SocketTransport.connect(target.socketPath);
        t.onMessage = (message) => listeners.forEach((l) => l({ connId: id, message }));
        t.onClose = () => closedL.forEach((l) => l({ connId: id }));
        conns.set(id, t);
        return id;
      },
      sendMessage: async (id: number, message: string) => { conns.get(id)?.write(message); },
      close: async (id: number) => { await conns.get(id)?.close(); },
      onMessage: (cb: any) => { listeners.push(cb); return () => {}; },
      onClosed: (cb: any) => { closedL.push(cb); return () => {}; },
    },
    view: { set: async () => {} },
    browser: { cdpUrl: async () => null },
  },
};

describe("desktop controller: attachments", () => {
  test("images[] and files[] reach the model", async () => {
    const model = await startFakeAnthropic([{ text: "seen" }]);
    servers.push(model);
    const { d } = await startTestDaemon(model.url);
    target.socketPath = d.socketPath;
    (globalThis as any).window = bridge;
    const repo = makeRepo();
    const ctl = await SessionController.create({ cwd: repo, modelId: MODEL, autonomyLevel: "high" });
    await ctl.send("look at these", {
      images: [{ mediaType: "image/png", data: Buffer.from(PNG).toString("base64") }],
      files: [{ name: "notes.txt", mediaType: "text/plain", data: "remember the milk" }],
    });
    const t0 = Date.now();
    while (!model.requests.length && Date.now() - t0 < 20000) await sleep(20);
    const body = JSON.stringify(model.requests[0]);
    expect(body).toContain('"type":"image"');
    expect(body).toContain(Buffer.from(PNG).toString("base64"));
    expect(body).toContain("remember the milk");
    expect(body).toContain("notes.txt");
    expect(JSON.stringify(ctl.getSnapshot().items)).toContain("[Attached: image 1, notes.txt]");
    ctl.close();
    d.stop();
  }, 40000);
});
