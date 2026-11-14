export const MOBILE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rigwell phone</title><style>
body{font:16px system-ui;margin:0 auto;padding:1rem;max-width:54rem;background:#12151b;color:#f2f4f8}button,input,textarea,select{font:inherit;margin:.3rem 0;padding:.6rem;border-radius:.35rem;max-width:100%;box-sizing:border-box}button{cursor:pointer}input,textarea,select{width:100%;background:#202632;color:inherit;border:1px solid #697080}label{display:block}pre{white-space:pre-wrap;overflow-wrap:anywhere}section,article{border:1px solid #444c5a;border-radius:.5rem;padding:.8rem;margin:.7rem 0}#error{color:#ffbab1}#fingerprint{font-size:.8rem}textarea{min-height:5rem}[hidden]{display:none!important}
</style><script defer src="/app.js"></script></head><body><h1>Rigwell</h1><p id="status" role="status">Pair this device to connect.</p><p id="error" role="alert"></p>
<section id="pairing"><h2>Pair this phone</h2><p>Compare the certificate fingerprint with Rigwell on your computer before trusting the connection. Pairing codes expire after two minutes.</p><pre id="fingerprint"></pre><form id="pair-form"><label>Device name<input id="device-name" required maxlength="80" autocomplete="off"></label><label>One-time pairing code<input id="pair-code" required autocomplete="off"></label><button>Pair device</button></form></section>
<div id="workspace" hidden><button id="refresh">Refresh lists</button><button id="notifications">Enable notifications while open</button><div id="connection-prompts"></div><section><h2>Sessions</h2><div id="sessions"></div></section>
<section id="session" hidden><h2 id="session-title"></h2><div id="transcript"></div><pre id="stream"></pre><div id="prompts"></div><form id="message-form"><label>Message<textarea id="message" required></textarea></label><button>Send message</button><button type="button" id="interrupt">Stop current turn</button></form></section>
<section><h2>Workstreams</h2><div id="workstreams"></div><div id="roster"></div><div id="workstream-messages"></div><form id="workstream-form" hidden><label>Recipient<select id="recipient" aria-label="Recipient"></select></label><label>Priority<select id="priority" aria-label="Priority"><option value="later">Later</option><option value="next">Next</option><option value="now">Now</option></select></label><label>Workstream message<textarea id="workstream-message" required></textarea></label><button>Send Workstream message</button></form></section></div></body></html>`;

function mobileMain(protocolVersion: string) {
  const byId = (id: string) => document.getElementById(id)!;
  const value = (id: string) => (byId(id) as HTMLInputElement).value;
  const error = (e: unknown) => { byId("error").textContent = String((e as Error)?.message ?? e); };
  const run = (fn: () => Promise<unknown>) => { byId("error").textContent = ""; void fn().catch(error); };
  const element = (tag: string, text: string, parent: HTMLElement) => { const el = document.createElement(tag); el.textContent = text; parent.append(el); return el; };
  const button = (label: string, parent: HTMLElement, action: () => Promise<unknown>) => { const el = element("button", label, parent); el.addEventListener("click", () => run(action)); return el; };
  const announce = (message: string) => { if ("Notification" in window && Notification.permission === "granted") new Notification("Rigwell", { body: message }); };
  let sessionId = "", workstreamId = "", transcript = "", promptSignature = "";
  const sessions = new Map<string, any>(); let control: any;
  function rpc() {
    const credential = localStorage.getItem("rigwell-device"); if (!credential) throw new Error("Pair this device first");
    const ws = new WebSocket(location.origin.replace(/^https:/, "wss:") + "/rpc", ["rigwell", "rigwell-device." + credential.replace(":", ".")]), pending = new Map<string, { resolve(v: any): void; reject(e: Error): void }>(); let sequence = 0;
    const ready = new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("Connection failed. Pair this device and verify the server certificate.")); });
    ws.onclose = () => { for (const p of pending.values()) p.reject(new Error("Connection closed. The device may be revoked or the daemon stopped.")); pending.clear(); byId("status").textContent = "Disconnected. Reload to reconnect."; };
    ws.onmessage = (event) => {
      const m = JSON.parse(event.data);
      if (!m.method && pending.has(m.id)) { const p = pending.get(m.id)!; pending.delete(m.id); if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); return; }
      if (m.method?.endsWith("session_notification")) {
        const n = m.params.notification;
        if (m.params.sessionId === sessionId && n.type === "assistant_text_delta") byId("stream").textContent += n.textDelta;
        if (n.type === "error") error(new Error(n.message));
        if (n.type === "agent_turn_completed") { announce("A session turn finished."); if (m.params.sessionId === sessionId) void refreshSession().catch(error); }
        if (n.type === "agent_working_state_changed" && n.newState === "waiting_for_tool_confirmation") announce("A session needs your response.");
      }
      // A newly opened phone-owned session can ask on this connection. Its pending list is polled below.
      if (m.id !== undefined && m.method?.endsWith("request_trust")) {
        const panel = document.createElement("section"); byId("connection-prompts").append(panel); element("h2", "Trust this working folder?", panel); element("pre", JSON.stringify(m.params, null, 2), panel);
        const answer = async (trust: boolean) => { ws.send(JSON.stringify({ jsonrpc: "2.0", type: "response", protocolVersion, id: m.id, result: { trust, remember: false } })); panel.remove(); };
        button("Trust for this session", panel, () => answer(true)); button("Continue without trusting", panel, () => answer(false));
      } else if (m.id !== undefined && m.method) void refreshSession().catch(error);
    };
    return { async call(method: string, params: Record<string, unknown> = {}) { await ready; const id = String(++sequence); return new Promise<any>((resolve, reject) => { pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ jsonrpc: "2.0", type: "request", protocolVersion, id, method: "rigwell." + method, params })); }); }, ready };
  }
  function messages(data: any[]) {
    const content = JSON.stringify(data); if (content === transcript) return; transcript = content; byId("transcript").replaceChildren(); byId("stream").textContent = "";
    for (const message of data) {
      if (message.visibility === "llm_only") continue;
      const article = document.createElement("article"); byId("transcript").append(article); element("strong", String(message.role), article);
      const text = (message.content ?? []).filter((b: any) => b.type === "text" || b.type === "tool_result" || b.type === "tool_use").map((b: any) => b.type === "text" ? b.text : b.type === "tool_result" ? b.content : `${b.name}: ${JSON.stringify(b.input)}`).join("\n"); element("pre", text, article);
    }
  }
  function prompts(snapshot: any) {
    const all = [...(snapshot.pendingPermissions ?? []).map((p: any) => ({ kind: "permission", ...p })), ...(snapshot.pendingAskUserRequests ?? []).map((p: any) => ({ kind: "question", ...p }))];
    const signature = JSON.stringify(all); if (signature === promptSignature) return; promptSignature = signature; byId("prompts").replaceChildren();
    for (const p of all) {
      const panel = document.createElement("section"); panel.setAttribute("aria-label", p.kind === "permission" ? "Permission request" : "Agent question"); byId("prompts").append(panel);
      element("h3", p.kind === "permission" ? "Permission required" : "Your answer is needed", panel);
      const answer = async (answer: unknown) => { await sessions.get(sessionId).call("answer_request", { requestId: p.requestId, answer }); await refreshSession(); };
      if (p.kind === "permission") { element("pre", JSON.stringify(p.toolUses ?? p, null, 2), panel); for (const choice of p.options ?? [{ label: "Allow once", value: "proceed_once" }, { label: "Deny", value: "cancel" }]) button(choice.label, panel, () => answer({ selectedOption: choice.value })); }
      else {
        const answers: { index: number; question: string; input: HTMLInputElement }[] = [];
        for (const q of p.questions ?? []) {
          const label = element("label", q.question, panel), input = document.createElement("input"); input.setAttribute("aria-label", q.question); label.append(input); answers.push({ index: q.index, question: q.question, input });
          if (q.options?.length) element("p", "Choices: " + q.options.join(", "), panel);
        }
        button("Send answer", panel, () => answer({ answers: answers.map(({ input, ...a }) => ({ ...a, answer: input.value })) })); button("Cancel question", panel, () => answer({ cancelled: true, answers: [] }));
      }
    }
  }
  async function refreshSession() {
    if (!sessionId || !sessions.has(sessionId)) return;
    const id = sessionId, r = await sessions.get(id).call("owned_session_snapshot"); if (id !== sessionId) return; messages(r.messages ?? r.session?.messages ?? []); prompts(r);
  }
  async function openSession(id: string, cwd: string, title: string) {
    let connection = sessions.get(id);
    if (!connection) { if (sessions.size >= 12) throw new Error("Reload to close older phone views before opening more sessions"); connection = rpc(); await connection.call("load_session", { sessionId: id, cwd }); sessions.set(id, connection); }
    sessionId = id; transcript = ""; promptSignature = ""; byId("session-title").textContent = title; byId("session").hidden = false; await refreshSession();
  }
  async function refreshWorkstream() {
    if (!workstreamId) return; const id = workstreamId, r = await control.call("get_workstream", { id }); if (id !== workstreamId) return;
    byId("roster").replaceChildren(); for (const agent of r.roster ?? []) { element("p", `${agent.name}: ${agent.status}`, byId("roster")); button(`Open ${agent.name}`, byId("roster"), () => openSession(agent.sessionId, agent.cwd, agent.name)); }
    byId("workstream-messages").replaceChildren(); for (const m of r.messages ?? []) element("pre", `${m.from} → ${m.to}: ${m.text}`, byId("workstream-messages"));
    const select = byId("recipient") as HTMLSelectElement, selected = select.value; select.replaceChildren();
    for (const [id, name] of [["lead", "Lead"], ...(r.roster ?? []).filter((a: any) => a.status !== "archived").map((a: any) => [a.agentId, a.name])]) { const option = new Option(name, id); select.add(option); } if ([...select.options].some((o) => o.value === selected)) select.value = selected;
    byId("workstream-form").hidden = false;
  }
  async function lists() {
    const [s, w] = await Promise.all([control.call("list_sessions", { includeArchived: false }), control.call("list_workstreams")]); byId("sessions").replaceChildren(); byId("workstreams").replaceChildren();
    for (const row of s.sessions ?? []) button(row.title || row.sessionId, byId("sessions"), () => openSession(row.sessionId, row.cwd, row.title));
    for (const row of w.workstreams ?? []) button(row.title || row.id, byId("workstreams"), async () => { workstreamId = row.id; await refreshWorkstream(); });
  }
  async function connect() { control = rpc(); await control.ready; await lists(); byId("workspace").hidden = false; byId("pairing").hidden = true; byId("status").textContent = "Connected securely"; }
  const fragment = new URLSearchParams(location.hash.slice(1)); (byId("pair-code") as HTMLInputElement).value = fragment.get("pair") ?? ""; byId("fingerprint").textContent = fragment.get("fingerprint") ?? ""; history.replaceState(null, "", location.pathname);
  byId("pair-form").addEventListener("submit", (e) => { e.preventDefault(); run(async () => { const r = await fetch("/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: value("pair-code"), name: value("device-name") }) }); if (!r.ok) throw new Error(await r.text()); const paired = await r.json(); localStorage.setItem("rigwell-device", paired.credential); (byId("pair-code") as HTMLInputElement).value = ""; await connect(); }); });
  byId("message-form").addEventListener("submit", (e) => { e.preventDefault(); run(async () => { await sessions.get(sessionId).call("add_user_message", { text: value("message") }); (byId("message") as HTMLTextAreaElement).value = ""; await refreshSession(); }); });
  byId("workstream-form").addEventListener("submit", (e) => { e.preventDefault(); run(async () => { await control.call("workstream_send", { id: workstreamId, to: value("recipient"), priority: value("priority"), message: value("workstream-message") }); (byId("workstream-message") as HTMLTextAreaElement).value = ""; await refreshWorkstream(); }); });
  byId("refresh").addEventListener("click", () => run(lists)); byId("interrupt").addEventListener("click", () => run(() => sessions.get(sessionId).call("interrupt_session")));
  byId("notifications").addEventListener("click", () => run(async () => { if (!("Notification" in window)) throw new Error("This browser does not support notifications"); await Notification.requestPermission(); }));
  if (!value("pair-code")) void connect().catch(() => { byId("status").textContent = "Pair this device to connect."; byId("pairing").hidden = false; });
  setInterval(() => { if (control) { void refreshSession().catch(error); void refreshWorkstream().catch(error); } }, 2000);
}
import { PROTOCOL_VERSION } from "../protocol/rpc.ts";
export const MOBILE_JS = `(${mobileMain.toString()})(${JSON.stringify(PROTOCOL_VERSION)});`;
