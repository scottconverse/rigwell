import { resolve } from "node:path";
import { MachineStore } from "./store.ts";
import { bootstrapMachine } from "./bootstrap.ts";

export async function machineMain(argv: string[]) {
  const [action, name, host, ...flags] = argv, store = new MachineStore();
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
  throw new Error("Usage: rigwell machine add <name> <user@host> [--port <n>] [--identity <key-file>] [--known-hosts <file>] | bootstrap <name>");
}
