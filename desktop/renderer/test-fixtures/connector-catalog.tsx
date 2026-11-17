import React from "react";
import { createRoot } from "react-dom/client";
import { ConnectorsDialog } from "../components/Dialogs.tsx";
import { app } from "../lib/app-model.ts";
import type { SessionController } from "../lib/session.ts";
const request = async (method: string, params: Record<string, unknown> = {}) => {
  const r = await (await fetch("/rpc", { method: "POST", body: JSON.stringify({ method, params }) })).json();
  if (r.error) throw new Error(r.error); return r.result;
};
(window as any).rigwell = {
  shell: { async openExternal() { throw new Error("Visible browser launch is forbidden in this fixture"); } },
  userSettings: {
    get: async () => (await fetch("/settings")).json(),
    update: async (patch: unknown) => (await fetch("/settings", { method: "POST", body: JSON.stringify(patch) })).json(),
  },
};
await app.refreshUserSettings();
createRoot(document.getElementById("root")!).render(<ConnectorsDialog ctl={{ request } as SessionController} onClose={() => {}} />);
