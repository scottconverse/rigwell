import { expect, test } from "bun:test";
import { UpdateController, updateButtonLabel, type UpdateFetched, type UpdateState } from "../../desktop/main/update-state.ts";
import type { UpdateCheck } from "../../desktop/main/update-feed.ts";

class Refused extends Error {}
const offer: UpdateCheck = { status: "available", version: "9.9.9", downloadUrl: "http://127.0.0.1/app.exe" } as UpdateCheck;

function setup(check: UpdateCheck, fetch: (progress: (percent: number) => void) => Promise<UpdateFetched>) {
  const seen: UpdateState[] = [];
  const box = { check };
  const c = new UpdateController({ check: async () => box.check, fetch: (_o, p) => fetch(p), isRefusal: e => e instanceof Refused, publish: s => seen.push(s) });
  return { c, seen, box };
}

test("no update keeps the button hidden", async () => {
  const { c } = setup({ status: "up-to-date", version: "1.0.0" }, async () => ({ kind: "handed-off" }));
  await c.check();
  expect(c.state.phase).toBe("idle");
  expect(updateButtonLabel(c.state)).toBeUndefined();
});

test("available, downloading, then restart waits for the click", async () => {
  let installs = 0;
  const { c, seen } = setup(offer, async p => { p(41.6); return { kind: "ready", install: () => { installs++; } }; });
  await c.check();
  expect(updateButtonLabel(c.state)).toBe("Update available");
  await c.download();
  expect(seen.map(updateButtonLabel)).toEqual(["Update available", "Downloading", "Downloading 42%", "Restart to install"]);
  expect(installs).toBe(0);
  c.install();
  expect(installs).toBe(1);
});

test("a download failure shows the error and can try again", async () => {
  let tries = 0;
  const { c } = setup(offer, async () => { if (++tries === 1) throw new Error("connection lost"); return { kind: "ready", install() {} }; });
  await c.check();
  await c.download();
  expect(c.state).toMatchObject({ phase: "error", message: "connection lost", refused: false });
  expect(updateButtonLabel(c.state)).toBe("Update failed");
  await c.download();
  expect(c.state.phase).toBe("ready");
});

test("a refused signature never reaches the install step", async () => {
  let installs = 0;
  const { c } = setup(offer, async () => { throw new Refused("bad signature"); });
  await c.check();
  await c.download();
  expect(c.state).toMatchObject({ phase: "error", refused: true });
  expect(updateButtonLabel(c.state)).toBe("Update refused");
  c.install();
  expect(installs).toBe(0);
});

test("a refusal at the install click does not leave a usable install", async () => {
  let installs = 0;
  const { c } = setup(offer, async () => ({ kind: "ready", install: () => { installs++; throw new Refused("file changed"); } }));
  await c.check();
  await c.download();
  c.install();
  expect(c.state).toMatchObject({ phase: "error", refused: true });
  c.install();
  expect(installs).toBe(1);
});

test("a check during a download or at restart does not change the state", async () => {
  let finish!: (f: UpdateFetched) => void;
  const { c, box } = setup(offer, () => new Promise(r => { finish = r; }));
  await c.check();
  const running = c.download();
  box.check = { status: "up-to-date", version: "9.9.9" };
  await c.check();
  expect(c.state.phase).toBe("downloading");
  await c.download();
  finish({ kind: "ready", install() {} });
  await running;
  await c.check();
  expect(c.state.phase).toBe("ready");
});

test("a handed-off download clears the button", async () => {
  const { c } = setup(offer, async () => ({ kind: "handed-off" }));
  await c.check();
  await c.download();
  expect(c.state.phase).toBe("idle");
});
