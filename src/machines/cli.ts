import { resolve } from "node:path";
import { MachineStore } from "./store.ts";
import { bootstrapMachine } from "./bootstrap.ts";
import { MachineFleet } from "./fleet.ts";

export async function machineMain(argv: string[]) {
  const [action, name, host, ...flags] = argv, store = new MachineStore();
  const fleet = new MachineFleet({ store });
  if (action === "list" && !name) { console.log(JSON.stringify({ machines: await fleet.list() }, null, 2)); return; }
  if (action === "update-all" && !name) {
    const result = await fleet.updateAll(); console.log(JSON.stringify(result, null, 2));
    if (result.results.some((r) => r.error)) process.exitCode = 1;
    return;
  }
  if (name && !host && ["stop", "restart", "update", "remove"].includes(action!)) {
    const result = action === "stop" ? await fleet.stop(name) : action === "restart" ? await fleet.restart(name) : action === "update" ? await fleet.update(name) : fleet.remove(name);
    console.log(JSON.stringify(result)); return;
  }
  if (action === "bootstrap" && name && !host) { console.log(JSON.stringify(await bootstrapMachine(name, { store }))); return; }
  if (action === "add" && name && host) {
    const row: Parameters<MachineStore["save"]>[0] = { name, host };
    for (let i = 0; i < flags.length; i++) {
      const key = flags[i], value = flags[++i];
      if (!value) throw new Error(`${key} needs a value`);
      if (key === "--port") row.port = Number(value);
      else if (key === "--identity") row.identityFile = resolve(value);
      else if (key === "--known-hosts") row.knownHostsFile = resolve(value);
      else throw new Error(`Unknown machine option: ${key}`);
    }
    console.log(JSON.stringify(store.save(row))); return;
  }
  throw new Error("Usage: rigwell machine add <name> <user@host> [--port <n>] [--identity <key-file>] [--known-hosts <file>] | bootstrap <name> | list | stop <name> | restart <name> | update <name> | update-all | remove <name>");
}
