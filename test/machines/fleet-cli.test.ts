import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MachineStore } from "../../src/machines/store.ts";
import { tmpEnv } from "../storage/helpers.ts";
const cli = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const command = (args: string[]) => new Promise<string>((resolve, reject) => execFile(process.execPath, [cli, "machine", ...args], { windowsHide: true, timeout: 3000 }, (error, stdout) => error ? reject(error) : resolve(stdout)));

test("machine list uses the fleet status shape and remove only forgets its connection", async () => {
  const env = tmpEnv(), store = new MachineStore(); store.save({ name: "uninstalled", host: "owner@fixture" });
  try {
    const list = JSON.parse(await command(["list"]));
    expect(list.machines[0]).toMatchObject({ name: "uninstalled", online: false, runningSessions: null, load: null });
    expect(list.machines[0].error).toContain("Bootstrap");
    expect(JSON.parse(await command(["remove", "uninstalled"]))).toEqual({ removed: true });
    expect(JSON.parse(await command(["list"]))).toEqual({ machines: [] });
  } finally { env.cleanup(); }
}, 5000);
