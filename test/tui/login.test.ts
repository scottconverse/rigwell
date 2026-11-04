// /login and /logout in the TUI: the reducer asks for a view, and the view drives the real auth protocol methods against
// the fake OAuth server (device flow, so no browser is needed).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { AuthManager, setAuthManager } from "../../src/auth/oauth.ts";
import { CredentialStore, FileBackend, setCredentialStore } from "../../src/storage/credentials.ts";
import { matchCommands } from "../../src/tui/commands.ts";
import { buildView } from "../../src/tui/views.ts";
import { initialState } from "../../src/tui/reducer.ts";
import { startFakeOAuth, type FakeOAuth } from "../fakes/fake-oauth.ts";
import { inproc } from "../e2e/inproc.ts";
import { tmpEnv } from "../storage/helpers.ts";
import { driver, key, type } from "./helpers.ts";

let env: ReturnType<typeof tmpEnv>;
let idp: FakeOAuth;
beforeEach(() => {
  env = tmpEnv();
  setCredentialStore(new CredentialStore([new FileBackend()]));
  idp = startFakeOAuth();
  writeFileSync(path.join(env.rigwellHome, "settings.json"), JSON.stringify({
    oauthProviders: { acme: { clientId: "own-client", authorizationEndpoint: `${idp.url}/authorize`, tokenEndpoint: `${idp.url}/token`, deviceAuthorizationEndpoint: `${idp.url}/device`, scopes: ["models.read"] } },
  }));
  setAuthManager(new AuthManager({ intervalUnitMs: 5, loginTimeoutMs: 10_000 }));
});
afterEach(() => { idp.stop(); setAuthManager(undefined); setCredentialStore(undefined); env.cleanup(); });

describe("commands", () => {
  test("/login and /logout are listed and ask the app for a view", () => {
    expect(matchCommands("log").map((c) => c.name).sort()).toEqual(["login", "logout"]);
    for (const name of ["login", "logout"]) {
      const d = key(type(driver(), `/${name} acme --device`), "enter");
      expect(d.effects).toEqual([{ type: "view", name: name as any, args: "acme --device" }]);
    }
  });
});

describe("views against the real auth methods", () => {
  const ctx = (c: ReturnType<typeof inproc>, notes: string[]) => ({
    request: (m: string, p: Record<string, unknown>) => c.call(m, p), state: initialState({ cwd: "/", rows: 24, cols: 80 } as any), connection: "in-process",
    notify: (t: string, l?: string) => notes.push(`${l ?? "info"}: ${t}`), openUrl: () => {}, loginPollMs: 10,
  });

  test("/login lists providers; the device flow shows the code, finishes, and /logout signs out", async () => {
    const c = inproc();
    const notes: string[] = [];
    const list = await buildView("login", "", ctx(c, notes) as any);
    expect(list.lines.join("\n")).toContain("acme");
    expect(list.lines.join("\n")).toContain("signed out");

    const started = await buildView("login", "acme --device", ctx(c, notes) as any);
    expect(started.lines.join("\n")).toContain("ABCD-1234");
    for (let i = 0; i < 300 && !notes.length; i++) await Bun.sleep(10);
    expect(notes).toEqual(["info: Signed in to acme."]);

    expect((await buildView("login", "", ctx(c, notes) as any)).lines.join("\n")).toMatch(/acme\s+signed in/);
    expect((await buildView("logout", "acme", ctx(c, notes) as any)).lines[0]).toBe("Signed out of acme.");
    expect((await buildView("logout", "acme", ctx(c, notes) as any)).lines[0]).toBe("acme was not signed in.");
    expect((await buildView("logout", "", ctx(c, notes) as any)).lines[0]).toContain("Usage");
  });

  test("the browser flow prints the URL and opens it; an unknown provider is explained", async () => {
    const c = inproc();
    let opened = "";
    const x = { ...ctx(c, []), openUrl: (u: string) => { opened = u; } };
    const v = await buildView("login", "acme", x as any);
    expect(opened).toStartWith(`${idp.url}/authorize`);
    expect(v.lines.join("\n")).toContain(opened);
    expect((await buildView("login", "nope", ctx(c, []) as any)).lines[0]).toContain("No OAuth provider");
  });
});
