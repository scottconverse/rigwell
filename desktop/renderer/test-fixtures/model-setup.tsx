import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Home } from "../components/Home.tsx";
import { Accounts } from "../components/SettingsAccess.tsx";
import { CustomModels } from "../components/SettingsAgent.tsx";
import { app } from "../lib/app-model.ts";

const request = async (method: string, params: Record<string, unknown> = {}) => {
  const response = await fetch("/rpc", { method: "POST", body: JSON.stringify({ method, params }) });
  const data = await response.json(); if (data.error) throw new Error(data.error.message); return data.result;
};
app.request = request;
app.refresh = async () => { const result = await request("list_models"); (app as any).set({ models: result.models, userSettings: await request("fixture_read_settings") }); };
app.updateUserSettings = async (patch) => { (app as any).set({ userSettings: await request("fixture_update_settings", patch) }); };
(window as any).rigwell = { org: { async managed() { return { managed: false, keys: [] }; } }, shell: { async openExternal() { throw new Error("Visible browsers are forbidden in this fixture"); } } };
(app as any).set({ daemon: { state: "running" }, userSettings: (window as any).fixtureSettings, models: [] });
function Fixture() {
  const [route, go] = useState("/");
  return <><nav><button onClick={() => go("/")}>Fixture home</button><button onClick={() => go("/settings/accounts")}>Fixture accounts</button></nav>
    {route === "/settings/custom-models" ? <CustomModels /> : route === "/settings/accounts" ? <Accounts /> : <Home go={go} />}</>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
