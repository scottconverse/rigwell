import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpEnv, writeJson } from "../storage/helpers.ts";

test("sync CLI configures, transfers selected settings, views read-only and turns off", async () => {
  const env = tmpEnv(), input = join(env.root, "sync.json"), cli = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
  const command = (args: string[]) => new Promise<any>((resolve, reject) => execFile(process.execPath, [cli, "sync", ...args], { windowsHide: true, timeout: 3000, env: { ...process.env, RIGWELL_CREDENTIALS: "file" } }, (e, out) => e ? reject(e) : resolve(JSON.parse(out))));
  try {
    writeJson(input, { version: 1, folderIsAuthority: true, target: { kind: "folder", path: join(env.root, "target") }, kinds: ["settings"], settings: ["diffMode"] });
    writeJson(join(env.rigwellHome, "settings.json"), { diffMode: "unified", apiKey: "not-exported" });
    expect((await command(["configure", input])).config.target.kind).toBe("folder");
    expect((await command(["now"])).items).toHaveLength(1);
    const view = await command(["view", "settings/user"]); expect(view.readOnly).toBe(true); expect(view.item.files["settings.json"]).toBe('{"diffMode":"unified"}');
    expect((await command(["off"])).config).toBeUndefined(); expect((await command(["status"])).config).toBeUndefined();
  } finally { env.cleanup(); }
}, 5000);
