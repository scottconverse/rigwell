// Final gap wave, protocol completeness (spec 3.1.5): tags and tool id lists on update_session_settings, list_tools
// params and real fields, load_session paging, gitRepo.
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readSessionSettings } from "../../src/storage/session-settings.ts";
import { findSession } from "../../src/storage/transcript.ts";
import { parseRemoteUrl } from "../../src/daemon/gitrepo.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import type { FakeServer, FakeTurn } from "../fakes/types.ts";
import { makeHome, makeRepo } from "../e2e/helpers.ts";
import { driver } from "./helpers.ts";

const servers: FakeServer[] = [];
afterEach(() => { servers.splice(0).forEach((s) => s.stop()); });

async function setup(turns: FakeTurn[], extraSettings: Record<string, unknown> = {}) {
  const model = await startFakeAnthropic(turns);
  servers.push(model);
  const home = makeHome([{ provider: "anthropic", url: model.url, displayName: "F" }]);
  const sf = join(home, "settings.json");
  writeFileSync(sf, JSON.stringify({ ...JSON.parse(readFileSync(sf, "utf8")), ...extraSettings }));
  process.env.RIGWELL_HOME = home;
  return { model, home, repo: makeRepo() };
}
const toolNames = (body: any) => (body.tools ?? []).map((t: any) => t.name);

describe("update_session_settings", () => {
  test("tags and the four tool id lists change the session, the notification and the settings file", async () => {
    const { model, repo } = await setup([{ text: "a" }, { text: "b" }]);
    const d = driver({ canPrompt: false });
    const init = await d.call("initialize_session", { cwd: repo, modelId: "custom:F-0", autonomyLevel: "high", tags: [{ name: "sdk", metadata: { language: "ts" } }] });
    expect(init.settings.tags).toEqual([{ name: "sdk", metadata: { language: "ts" } }]);
    await d.turn("hi");
    expect(toolNames(model.requests[0])).toContain("Execute");

    await d.call("update_session_settings", { tags: [{ name: "ci" }], disabledToolIds: ["Execute"], restrictToolIds: ["Read", "Execute", "Grep"] });
    const upd = d.notes("settings_updated").at(-1);
    expect(upd.settings).toMatchObject({ tags: [{ name: "ci" }], disabledToolIds: ["Execute"], restrictToolIds: ["Read", "Execute", "Grep"] });
    await d.turn("again");
    expect(toolNames(model.requests[1]).sort()).toEqual(["Grep", "Read"]);

    await d.call("update_session_settings", { restrictToolIds: null, disabledToolIds: [] });
    await d.call("close_session", {});
    const saved = readSessionSettings(findSession(init.sessionId, repo)!)!;
    expect(saved.tags).toEqual([{ name: "ci" }]);
    expect(saved.toolIds).toEqual({ disabled: [] });
  }, 30000);

  test("bad tags and lists are invalid params", async () => {
    const { repo } = await setup([]);
    const d = driver({ canPrompt: false });
    await d.call("initialize_session", { cwd: repo, modelId: "custom:F-0" });
    await expect(d.call("update_session_settings", { tags: [{ metadata: {} }] })).rejects.toThrow(/tags\[0\]\.name/);
    await expect(d.call("update_session_settings", { enabledToolIds: "Read" })).rejects.toThrow(/enabledToolIds/);
    await d.call("close_session", {});
  });
});

describe("list_tools", () => {
  test("honors autonomyLevel, interactionMode and skipPermissionsUnsafe, and reports currentlyAllowed", async () => {
    const { repo } = await setup([]);
    const d = driver({ canPrompt: false });
    await d.call("initialize_session", { cwd: repo, modelId: "custom:F-0", autonomyLevel: "off" });
    const byId = (r: any) => Object.fromEntries(r.tools.map((t: any) => [t.id, t]));
    const off = byId(await d.call("list_tools", {}));
    expect(off.Read).toMatchObject({ currentlyAllowed: true, source: "native" });
    expect(off.Edit.currentlyAllowed).toBe(false); // read-only at autonomy off, but known
    const high = byId(await d.call("list_tools", { autonomyLevel: "high" }));
    expect(high.Edit.currentlyAllowed).toBe(true);
    const skip = byId(await d.call("list_tools", { skipPermissionsUnsafe: true }));
    expect(skip.Edit.currentlyAllowed).toBe(true);
    const spec = byId(await d.call("list_tools", { interactionMode: "spec" }));
    expect(spec.ExitSpecMode).toBeUndefined(); // headless: nobody to approve a plan
    const dis = byId(await d.call("list_tools", { autonomyLevel: "high", disabledToolIds: ["Execute"] }));
    expect(dis.Execute.currentlyAllowed).toBe(false);
    expect(dis.Read.currentlyAllowed).toBe(true);
    const one = await d.call("list_tools", { toolIds: ["Read"] });
    expect(one.tools.map((t: any) => t.id)).toEqual(["Read"]);
    await expect(d.call("list_tools", { modelId: "custom:Nope-9" })).rejects.toThrow(/Unknown model/);
    await expect(d.call("list_tools", { depth: -1 })).rejects.toThrow(/depth/);
    // The session itself is unchanged by the previews.
    expect((await d.call("list_tools", {})).tools.find((t: any) => t.id === "Edit").currentlyAllowed).toBe(false);
    await d.call("close_session", {});
  });

  test("depth beyond the subagent limit removes Task", async () => {
    const { repo } = await setup([]);
    const d = driver({ canPrompt: false });
    await d.call("initialize_session", { cwd: repo, modelId: "custom:F-0", autonomyLevel: "high" });
    const task = async (p: object) => (await d.call("list_tools", p)).tools.find((t: any) => t.id === "Task");
    expect(await task({ depth: 0 })).toMatchObject({ currentlyAllowed: true });
    const deep = await task({ depth: 99 });
    expect(deep === undefined || deep.currentlyAllowed === false).toBe(true);
    await d.call("close_session", {});
  });
});

describe("load_session paging and gitRepo", () => {
  test("messageLimit keeps the newest messages and sets hasOlderMessages; loadAllMessages returns everything", async () => {
    const { repo } = await setup([{ text: "r1" }, { text: "r2" }, { text: "r3" }]);
    execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/widgets.git"], { cwd: repo });
    const d = driver({ canPrompt: false });
    const init = await d.call("initialize_session", { cwd: repo, modelId: "custom:F-0" });
    expect(init.gitRepo).toEqual({ owner: "acme", repoName: "widgets" });
    await d.turn("q1"); await d.turn("q2"); await d.turn("q3");
    await d.call("close_session", {});

    const text = (m: any) => m.content.map((b: any) => b.text ?? "").join("");
    const all = driver({ canPrompt: false });
    const full = await all.call("load_session", { sessionId: init.sessionId, cwd: repo });
    expect(full.hasOlderMessages).toBe(false);
    expect(full.gitRepo).toEqual({ owner: "acme", repoName: "widgets" });
    const n = full.session.messages.length;
    expect(n).toBeGreaterThanOrEqual(6);
    await all.call("close_session", {});

    const lim = driver({ canPrompt: false });
    const part = await lim.call("load_session", { sessionId: init.sessionId, cwd: repo, messageLimit: 2 });
    expect(part.session.messages.map(text)).toEqual(["q3", "r3"]);
    expect(part.hasOlderMessages).toBe(true);
    await lim.call("close_session", {});

    const everything = driver({ canPrompt: false });
    const forced = await everything.call("load_session", { sessionId: init.sessionId, cwd: repo, messageLimit: 2, loadAllMessages: true });
    expect(forced.session.messages.length).toBe(n);
    expect(forced.hasOlderMessages).toBe(false);
    await expect(everything.call("close_session", {}).then(() => driver({ canPrompt: false }).call("load_session", { sessionId: init.sessionId, cwd: repo, messageLimit: 0 }))).rejects.toThrow(/messageLimit/);
  }, 30000);

  test("remote url parsing; no origin means no gitRepo", async () => {
    expect(parseRemoteUrl("https://github.com/acme/widgets.git")).toEqual({ owner: "acme", repoName: "widgets" });
    expect(parseRemoteUrl("ssh://git@host.example:2222/team/sub/app")).toEqual({ owner: "sub", repoName: "app" });
    expect(parseRemoteUrl("git@gitlab.com:grp/proj.git")).toEqual({ owner: "grp", repoName: "proj" });
    expect(parseRemoteUrl("/srv/git/solo.git")).toEqual({ owner: "git", repoName: "solo" });
    expect(parseRemoteUrl("")).toBeUndefined();
    const { repo } = await setup([]);
    const d = driver({ canPrompt: false });
    const init = await d.call("initialize_session", { cwd: repo, modelId: "custom:F-0" });
    expect(init.gitRepo).toBeUndefined();
    await d.call("close_session", {});
  });
});
