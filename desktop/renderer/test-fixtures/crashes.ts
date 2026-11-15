import { installRendererCrashCapture } from "../lib/crashes.ts";
installRendererCrashCapture(async (value) => { const response = await fetch("/fixture-crash", { method: "POST", body: JSON.stringify(value) }); if (!response.ok) throw new Error("Fixture capture refused"); });
document.body.innerHTML = '<button id="error">Trigger error</button><button id="rejection">Trigger rejection</button>';
document.querySelector("#error")!.addEventListener("click", () => { setTimeout(() => { throw new Error("renderer-crash-fixture"); }, 0); });
document.querySelector("#rejection")!.addEventListener("click", () => { void Promise.reject(new Error("renderer-rejection-fixture")); });
