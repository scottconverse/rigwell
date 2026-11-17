// Tray model (spec 14.2): icon state, tooltip counts and menu items. The real Tray is checked in the Electron test.
import { describe, expect, test } from "bun:test";
import { trayModel } from "../../desktop/main/tray.ts";
import { DaemonBroker } from "../../desktop/main/broker.ts";
import { startDaemon } from "../../src/daemon/daemon.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import { tmpEnv, writeJson } from "../storage/helpers.ts";
import { join } from "node:path";

const ids = (m: ReturnType<typeof trayModel>) => m.items.map((i) => ("id" in i ? i.id : "-"));

describe("tray model", () => {
  test("idle: show or hide follows window visibility, counts are zero", () => {
    const shown = trayModel({ visible: true, active: 0, attention: 0 });
    expect(shown.icon).toBe("idle");
    expect(shown.tooltip).toBe("Rigwell: No sessions working");
    expect(shown.items[0]).toEqual({ id: "toggle", label: "Hide Rigwell" });
    expect(trayModel({ visible: false, active: 0, attention: 0 }).items[0]).toEqual({ id: "toggle", label: "Show Rigwell" });
    expect(ids(shown)).toEqual(["toggle", "-", "active", "attention", "-", "quit"]);
  });
  test("working: icon, count and tooltip", () => {
    const m = trayModel({ visible: true, active: 2, attention: 0 });
    expect(m.icon).toBe("working");
    expect(m.tooltip).toBe("Rigwell: 2 sessions working");
    expect(m.items.find((i) => "id" in i && i.id === "active")).toMatchObject({ label: "Active sessions: 2", enabled: false });
    expect(trayModel({ visible: true, active: 1, attention: 0 }).tooltip).toBe("Rigwell: 1 session working");
  });
  test("attention badge wins over working", () => {
    const m = trayModel({ visible: false, active: 1, attention: 3 });
    expect(m.icon).toBe("attention");
    expect(m.tooltip).toBe("Rigwell: 1 session working, 3 need your attention");
    expect(m.items.find((i) => "id" in i && i.id === "attention")).toMatchObject({ label: "3 requests need your attention" });
    expect(trayModel({ visible: true, active: 0, attention: 1 }).items.find((i) => "id" in i && i.id === "attention")).toMatchObject({ label: "1 request needs your attention" });
  });
  test("Quit is always present and enabled", () => {
    for (const a of [0, 4]) expect(trayModel({ visible: true, active: a, attention: a }).items.find((i) => "id" in i && i.id === "quit")).toEqual({ id: "quit", label: "Quit Rigwell" });
  });
});

test("real streamed assistant text reaches the tray broker while the setup turn is still active", async () => {
  const env = tmpEnv(), fake = await startFakeAnthropic([{ text: "setup hello" }]);
  writeJson(join(env.rigwellHome, "settings.json"), { customModels: [{ provider: "anthropic", model: "fake", displayName: "Fixture", baseUrl: fake.url, apiKey: "fake" }] });
  const daemon = await startDaemon({ socketPath: join(env.root, "daemon.sock"), ws: { port: 0 }, automations: false, backgroundServices: false });
  let textActive: number | undefined, response!: () => void, becameIdle!: () => void;
  const initialized = new Promise<void>((r) => response = r), idle = new Promise<void>((r) => becameIdle = r);
  const broker = new DaemonBroker(() => ({ wsUrl: daemon.wsUrl!, token: daemon.wsToken! }), {
    deliver(_w, channel, payload: any) {
      if (channel !== "daemon:message") return;
      const m = JSON.parse(payload.message);
      if (m.id === "init" && m.result) response();
      if (m.params?.notification?.type === "assistant_text_delta") textActive = broker.activeCount;
    },
    onAttention() {}, onActivity(active) { if (active === 0 && textActive !== undefined) becameIdle(); },
  });
  try {
    const conn = await broker.openConnection(1);
    const send = (id: string, method: string, params: unknown) => broker.send(1, conn, JSON.stringify({ jsonrpc: "2.0", type: "request", id, method: `rigwell.${method}`, params }));
    send("init", "initialize_session", { cwd: env.root, autonomyLevel: "high" }); await initialized;
    send("start", "add_user_message", { text: "Start setup" }); await idle;
    expect(textActive).toBe(1);
    expect(trayModel({ visible: true, active: textActive!, attention: 0 }).icon).toBe("working");
    expect(broker.activeCount).toBe(0);
    expect(trayModel({ visible: true, active: broker.activeCount, attention: 0 }).icon).toBe("idle");
  } finally { broker.closeAll(); await daemon.stop(); fake.stop(); env.cleanup(); }
}, 10_000);
