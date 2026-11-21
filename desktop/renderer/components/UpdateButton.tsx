// The visible Update button in the title bar. All update work stays in the main process.
import { useEffect, useState } from "react";
import { updateButtonLabel, type UpdateState } from "../../main/update-state.ts";
import { bridge } from "../lib/rpc.ts";

export function UpdateButton() {
  const [state, setState] = useState<UpdateState>({ phase: "idle" });
  useEffect(() => {
    let live = true;
    const off = bridge().updates.onState((next) => { live = false; setState(next); });
    void bridge().updates.state().then((s) => { if (live) setState(s); }, () => {});
    return off;
  }, []);
  const label = updateButtonLabel(state);
  if (!label) return null;
  const title = state.phase === "error" ? `${state.message ?? label}. Click to try again.` : state.version ? `Rigwell ${state.version}` : label;
  const act = () => { void (state.phase === "ready" ? bridge().updates.install() : bridge().updates.download()).catch(() => {}); };
  return <button className={`update-button ${state.phase}`} title={title} disabled={state.phase === "downloading"} onClick={act}>{label}</button>;
}
