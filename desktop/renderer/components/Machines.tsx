import { useEffect, useState } from "react";
import { app } from "../lib/app-model.ts";
import type { Machine } from "../../../src/machines/store.ts";
import type { FleetMachine } from "../../../src/machines/fleet.ts";
import { ConfirmDialog } from "./Dialogs.tsx";

export function RemoteMachines({ hideList = false, onChanged }: { hideList?: boolean; onChanged?: () => Promise<void> } = {}) {
  const [machines, setMachines] = useState<Machine[]>([]), [error, setError] = useState(""), [busy, setBusy] = useState("");
  const [name, setName] = useState(""), [host, setHost] = useState(""), [port, setPort] = useState(""), [identity, setIdentity] = useState(""), [knownHosts, setKnownHosts] = useState("");
  const refresh = async () => setMachines((await app.request("machine_list")).machines ?? []);
  useEffect(() => { void refresh().catch((e) => setError(e.message)); }, []);
  const action = async (id: string, run: () => Promise<unknown>) => {
    setBusy(id); setError(""); try { await run(); await refresh(); await onChanged?.(); } catch (e) { setError((e as Error).message); } finally { setBusy(""); }
  };
  return <section aria-label="Remote machines"><h2>Remote machines</h2>
    <p>Connect to your computers through SSH. Host keys must already be trusted in known_hosts. Use your SSH agent or a key file.</p>
    <form onSubmit={(e) => { e.preventDefault(); void action("add", async () => { await app.request("machine_add", { name, host, ...(port ? { port: Number(port) } : {}), ...(identity ? { identityFile: identity } : {}), ...(knownHosts ? { knownHostsFile: knownHosts } : {}) }); setName(""); setHost(""); }); }}>
      <label>Name<input required aria-label="Machine name" value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label>SSH destination<input required aria-label="SSH destination" placeholder="user@host" value={host} onChange={(e) => setHost(e.target.value)} /></label>
      <label>Port<input aria-label="SSH port" type="number" min={1} max={65535} value={port} onChange={(e) => setPort(e.target.value)} placeholder="22" /></label>
      <label>Key file<input aria-label="SSH key file" value={identity} onChange={(e) => setIdentity(e.target.value)} placeholder="Optional absolute path" /></label>
      <label>Known hosts file<input aria-label="Known hosts file" value={knownHosts} onChange={(e) => setKnownHosts(e.target.value)} placeholder="Optional absolute path" /></label>
      <button type="submit" disabled={!!busy}>Add machine</button>
    </form>
    {!hideList && machines.map((m) => <div className="card" key={m.name}><h3>{m.name}</h3><p>{m.host}{m.port ? `:${m.port}` : ""}</p><p>{m.build ? `Ready: ${m.platform}, Rigwell ${m.version}` : "Bootstrap to install and start Rigwell."}</p>
      <button disabled={!!busy} onClick={() => void action(m.name, () => app.request("machine_bootstrap", { name: m.name }))}>{busy === m.name ? "Bootstrapping" : "Bootstrap"}</button>
    </div>)}
    {error && <div role="alert" className="banner error">{error}</div>}
  </section>;
}

export function FleetMachines() {
  const [machines, setMachines] = useState<FleetMachine[]>([]), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ title: string; body: string; method: string; name?: string }>();
  const refresh = async () => setMachines((await app.request("machine_fleet")).machines ?? []);
  const run = async (method?: string, name?: string) => {
    setBusy(true); setError("");
    try {
      if (method) {
        const result = await app.request(method, name ? { name } : {});
        const failures = result.results?.filter((r: any) => r.error) ?? [];
        if (failures.length) setError(failures.map((r: any) => `${r.name}: ${r.error}`).join("\n"));
      }
      await refresh();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  useEffect(() => { void run(); }, []);
  const confirm = (method: string, title: string, body: string, name?: string) => setPending({ method, title, body, name });
  return <div className="page" aria-label="Machines page"><h1>Machines</h1>
    <p>Manage Rigwell on your saved SSH machines. Status is checked when you open or refresh this page.</p>
    <button disabled={busy} onClick={() => void run()}>Refresh machines</button>
    <button disabled={busy || !machines.length} onClick={() => confirm("machine_update_all", "Update all machines", "Install this Rigwell build on every saved machine. Machines with running sessions are refused; other machines continue independently.")}>Update all</button>
    {busy && <p role="status">Checking machines or applying your action...</p>}
    {error && <div role="alert" className="banner error pre">{error}</div>}
    {!busy && !machines.length && <p>No saved machines. Add one below.</p>}
    {machines.map((m) => <article className="card" key={m.name} aria-label={`Machine ${m.name}`}><h2>{m.name}</h2><p>{m.host}</p><dl>
      <dt>Status</dt><dd>{m.online ? "Online" : "Offline"}</dd>
      <dt>OS</dt><dd>{m.platform ?? "Unknown"}</dd><dt>Rigwell version</dt><dd>{m.version ?? "Not installed"}</dd>
      <dt>Running sessions</dt><dd>{m.runningSessions ?? "Unknown"}</dd>
      <dt>Load</dt><dd>{m.load ? `${m.load.average ? `1-minute load ${m.load.average[0]?.toFixed(2)}` : "CPU load unavailable on Windows"}; ${Math.round(m.load.memoryUsed / m.load.memoryTotal * 100)}% memory used; ${m.load.cpuCount} CPUs` : "Unknown"}</dd>
      <dt>Last seen</dt><dd>{m.lastSeen ? new Date(m.lastSeen).toLocaleString() : "Never"}</dd>
    </dl>{m.error && <p className="muted">{m.error}</p>}
      <button disabled={busy} onClick={() => confirm("machine_update", `Update ${m.name}`, "Install this Rigwell build. Stop running sessions first. A failed installation attempts to restart the previous verified build.", m.name)}>Update Rigwell</button>
      <button disabled={busy || !m.online} onClick={() => confirm("machine_restart", `Restart ${m.name}`, "Restart the verified daemon. Running sessions must be stopped first; transcripts and worktrees are preserved.", m.name)}>Restart daemon</button>
      <button disabled={busy || !m.online} onClick={() => confirm("machine_stop", `Stop sessions on ${m.name}`, "Interrupt current sessions and background jobs and pause mission and Workstream owners. Transcripts and worktrees are preserved.", m.name)}>Stop all sessions</button>
      <button disabled={busy} onClick={() => confirm("machine_remove", `Remove ${m.name}`, "Forget this SSH connection only. Remote files, credentials and its daemon are preserved.", m.name)}>Remove machine</button>
    </article>)}
    <RemoteMachines hideList onChanged={refresh} />
    {pending && <ConfirmDialog title={pending.title} body={pending.body} action="Continue" onCancel={() => setPending(undefined)} onConfirm={() => { const action = pending; setPending(undefined); void run(action.method, action.name); }} />}
  </div>;
}
