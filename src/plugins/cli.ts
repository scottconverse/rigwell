import { createInterface } from "node:readline/promises";
import { PluginService } from "./service.ts";
import { readPluginState, type PluginSource } from "./store.ts";

export async function pluginMain(args: string[]) {
  const [action = "list", name, ...rest] = args, svc = new PluginService();
  const option = (key: string) => { const i = rest.indexOf(key); if (i < 0) return undefined; if (!rest[i + 1] || rest[i + 1]!.startsWith("--")) throw new Error(`${key} needs a value`); return rest[i + 1]; };
  const source = (path: string): PluginSource => ({ source: path, ...(option("--commit") ? { commit: option("--commit") } : {}), ...(option("--subdir") ? { subdir: option("--subdir") } : {}) });
  const confirm = async (preview: Awaited<ReturnType<PluginService["preview"]>>) => {
    console.log(JSON.stringify(preview, null, 2));
    if (!rest.includes("--yes")) {
      if (!process.stdin.isTTY) throw new Error("Review the preview and use --yes to trust these additions, hooks and MCP servers");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try { if ((await rl.question("Trust and install exactly this snapshot? [y/N] ")).trim().toLowerCase() !== "y") return { cancelled: true }; } finally { rl.close(); }
    }
    return svc.commit(preview.token, true);
  };
  try {
    let result: unknown;
    if (action === "list") result = svc.methods.list_plugins();
    else if (action === "install" && name) result = await confirm(await svc.preview(source(name)));
    else if (action === "update" && name) { const current = readPluginState().plugins.find((p) => p.name === name); if (!current) throw new Error("Unknown plugin"); const path = option("--source"); result = await confirm(await svc.preview(path ? source(path) : { ...current.source, ...(option("--commit") ? { commit: option("--commit") } : {}) }, name)); }
    else if (action === "enable" && name) result = await confirm(await svc.previewEnable(name));
    else if (action === "disable" && name) result = svc.disable(name);
    else if (action === "uninstall" && name) result = svc.uninstall(name, true);
    else if (action === "index-add" && name && rest[0]) result = await svc.addIndex(name, source(rest[0]), option("--file"));
    else if (action === "index-remove" && name) result = svc.removeIndex(name);
    else if (action === "install-index" && name && rest[0]) result = await confirm(await svc.previewIndex(name, rest[0]));
    else throw new Error("Usage: rigwell plugin list|install <path-or-url> [--commit SHA] [--subdir folder] [--yes]|update <name> [--source path-or-url] [--commit SHA] [--yes]|enable <name> [--yes]|disable <name>|uninstall <name>|index-add <name> <path-or-url> [--commit SHA] [--file relative.json]|index-remove <name>|install-index <index> <plugin> [--yes]");
    console.log(JSON.stringify(result));
  } finally { await svc.close(); }
}
