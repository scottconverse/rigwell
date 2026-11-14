import React from "react";
import { createRoot } from "react-dom/client";
import { McpLoginPanel, ServerList, useMcp } from "../components/Dialogs.tsx";
const request = async (method: string, params: Record<string, unknown> = {}) => {
  const response = await fetch("/rpc", { method: "POST", body: JSON.stringify({ method, params }) });
  const data = await response.json(); if (data.error) throw new Error(data.error); return data.result;
};
(window as any).rigwell = { shell: { async openExternal() { throw new Error("Visible browser launch is forbidden in this fixture"); } } };
function Fixture() {
  const m = useMcp(request);
  return <><ServerList servers={m.servers} busy={m.busy} onRemove={(n) => void m.remove(n)} onSignIn={(n) => void m.signIn(n)} onSignOut={(n) => void m.signOut(n)} />
    <McpLoginPanel login={m.login} onCancel={() => void m.cancelLogin()} />
    <button onClick={() => void m.refresh()}>Refresh</button>{m.error && <p role="alert">{m.error}</p>}</>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
