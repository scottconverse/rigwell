import { useEffect, useState } from "react";
import { app } from "../lib/app-model.ts";
import type { Machine } from "../../../src/machines/store.ts";

export function RemoteMachines() {
  const [machines, setMachines] = useState<Machine[]>([]), [error, setError] = useState(""), [busy, setBusy] = useState("");
  const [name, setName] = useState(""), [host, setHost] = useState(""), [port, setPort] = useState(""), [identity, setIdentity] = useState(""), [knownHosts, setKnownHosts] = useState("");
  const refresh = async () => setMachines((await app.request("machine_list")).machines ?? []);
  useEffect(() => { void refresh().catch((e) => setError(e.message)); }, []);
  const action = async (id: string, run: () => Promise<unknown>) => {
    setBusy(id); setError(""); try { await run(); await refresh(); } catch (e) { setError((e as Error).message); } finally { setBusy(""); }
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
    {machines.map((m) => <div className="card" key={m.name}><h3>{m.name}</h3><p>{m.host}{m.port ? `:${m.port}` : ""}</p><p>{m.build ? `Ready: ${m.platform}, Rigwell ${m.version}` : "Bootstrap to install and start Rigwell."}</p>
      <button disabled={!!busy} onClick={() => void action(m.name, () => app.request("machine_bootstrap", { name: m.name }))}>{busy === m.name ? "Bootstrapping" : "Bootstrap"}</button>
    </div>)}
    {error && <div role="alert" className="banner error">{error}</div>}
  </section>;
}
