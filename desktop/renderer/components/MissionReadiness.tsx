import { useEffect, useState } from "react";

export function MissionReadiness({ request, prepare }: { request(method: string): Promise<any>; prepare(): void }) {
  const [value, setValue] = useState<any>(), [error, setError] = useState("");
  const refresh = async () => { try { setValue(await request("mission_readiness_report")); setError(""); } catch (e) { setError((e as Error).message); } };
  useEffect(() => { void refresh(); }, []);
  return <section aria-label="Local mission readiness report"><h4>Local readiness report</h4>
    {error && <p role="alert">{error}</p>}
    {value && <><p>Readiness: {value.readiness?.status}. {value.readiness?.detail}</p>{value.report ? <><p>Recorded {value.report.generatedAt ?? "at an unknown time"}; level {value.report.level}. These checks apply to that point in time.</p><ul>{(Array.isArray(value.report.checks) ? value.report.checks : []).map((c: any, i: number) => <li key={i}>{String(c.name)}: {String(c.status)}{c.command ? ` (${String(c.command)})` : ""}</li>)}{(Array.isArray(value.report.tools) ? value.report.tools : []).map((t: any, i: number) => <li key={`t${i}`}>Tool {String(t.name)}: {String(t.status)}</li>)}</ul></> : <p>No saved report. Build and tests have not been checked here.</p>}</>}
    <button onClick={() => void refresh()}>Refresh readiness report</button><button onClick={prepare}>Prepare readiness checks</button>
    <p>Preparing fills the composer with the readiness skill. Send it to identify commands and request approval before executing repository code. You can continue without a passing report.</p>
  </section>;
}
