import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { configureSync, restoreSyncedItem, syncedItem, syncNow, syncStatus } from "./service.ts";
export async function syncMain(args: string[]) {
  const [action = "status", key, ...rest] = args;
  let result: unknown;
  if (action === "status" && !key) result = syncStatus();
  else if (action === "configure" && key && !rest.length) result = await configureSync(JSON.parse(readFileSync(key, "utf8")));
  else if (action === "off" && !key) result = await configureSync(null);
  else if (action === "now" && !key) result = await syncNow();
  else if (action === "view" && key && rest.length <= 1) result = { readOnly: true, item: syncedItem(key, rest[0]) };
  else if (action === "restore" && key) {
    let hash: string | undefined, cwd: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--hash" && rest[i + 1]) hash = rest[++i];
      else if (rest[i] === "--cwd" && rest[i + 1]) cwd = resolve(rest[++i]!);
      else throw new Error(`Unknown sync restore option: ${rest[i]}`);
    }
    result = await restoreSyncedItem(key, { hash, cwd });
  } else throw new Error("Usage: rigwell sync status|configure <file.json>|off|now|view <kind/id> [hash]|restore <kind/id> [--hash <hash>] [--cwd <folder>]");
  console.log(JSON.stringify(result));
}
