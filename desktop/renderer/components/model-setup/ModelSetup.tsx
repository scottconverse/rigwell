// Settings > Model setup: the model-setup-kit screens, wired to Rigwell's daemon methods
// and to customModels storage. The kit files under ./kit are copies; change the kit, not them.
import { app } from "../../lib/app-model.ts";
import { bridge } from "../../lib/rpc.ts";
import { ModelSetupScreen } from "./kit/ModelSetupScreen.tsx";
import { createModelSetupClient } from "./rigwell-client.ts";
import "./kit/styles.css";

const client = createModelSetupClient({
  request: (method, params) => app.request(method, params),
  settings: () => app.getSnapshot().userSettings,
  updateSettings: (patch) => app.updateUserSettings(patch),
  readUserSettings: () => bridge().userSettings.get(),
  refresh: () => app.refresh(),
});

export function ModelSetup() {
  return (
    <div className="model-setup">
      <h2>Set up models</h2>
      <p className="muted">
        Find a server on this computer, sign in to Claude Code, Codex or Ollama, or add an API connection.
        The model you pick is saved as a normal custom model.
      </p>
      <ModelSetupScreen client={client} appName="Rigwell" />
    </div>
  );
}
