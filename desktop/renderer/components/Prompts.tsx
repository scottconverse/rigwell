// Permission, question and picker panels (spec §13.4 behaviour, desktop presentation).
import { useState } from "react";
import type { Prompt } from "../lib/session.ts";

function describe(params: any): { title: string; lines: string[] } {
  const uses: any[] = params.toolUses ?? [];
  if (uses.length > 1) return { title: `Approve ${uses.length} operations`, lines: uses.map((u) => `${u.toolUse?.name}: ${u.details?.filePath ?? u.details?.fullCommand ?? JSON.stringify(u.toolUse?.input ?? {})}`) };
  const u = uses[0] ?? {};
  const d = u.details ?? {};
  switch (u.confirmationType) {
    case "exec": return { title: u.toolUse?.name === "Browser" ? "Use the browser pane" : "Command to approve", lines: [String(d.fullCommand ?? d.command ?? JSON.stringify(u.toolUse?.input ?? {})), ...(d.impactLevel ? [`${d.impactLevel} risk`] : []), ...(d.riskLevelReason ? [String(d.riskLevelReason)] : [])] };
    case "edit": return { title: `Edit ${d.fileName ?? ""}`, lines: [String(d.filePath ?? ""), ...diff(d.oldContent, d.newContent)] };
    case "create": return { title: `Create ${d.fileName ?? ""}`, lines: [String(d.filePath ?? ""), ...diff(undefined, d.content)] };
    case "exit_spec_mode": return { title: "Specification for approval", lines: String(d.plan ?? d.specContent ?? d.content ?? "").split("\n") };
    default: return { title: `Approve ${u.toolUse?.name ?? "action"}`, lines: [JSON.stringify(u.toolUse?.input ?? d, null, 2)] };
  }
}

function diff(a?: string, b?: string): string[] {
  const out: string[] = [];
  for (const l of (a ?? "").split("\n").filter(() => a !== undefined && a !== "")) out.push(`- ${l}`);
  for (const l of (b ?? "").split("\n").filter(() => b !== undefined && b !== "")) out.push(`+ ${l}`);
  return out.slice(0, 80);
}

function Permission({ p, onAnswer }: { p: Prompt; onAnswer: (r: unknown) => void }) {
  const d = describe(p.params);
  const options: { label: string; value: string }[] = p.params.options ?? [];
  return (
    <div className="prompt" role="alertdialog" aria-label={d.title}>
      <div className="prompt-title">{d.title}</div>
      <pre className="prompt-body">{d.lines.join("\n")}</pre>
      <div className="prompt-actions">
        {options.map((o) => (
          <button key={o.value} className={o.value === "proceed_once" ? "primary" : o.value === "cancel" ? "danger" : ""} onClick={() => onAnswer({ selectedOption: o.value })}>{o.label}</button>
        ))}
      </div>
    </div>
  );
}

function Questions({ p, onAnswer }: { p: Prompt; onAnswer: (r: unknown) => void }) {
  const qs: any[] = p.params.questions ?? [];
  const [i, setI] = useState(0);
  const [answers, setAnswers] = useState<{ index: number; question: string; answer: string }[]>([]);
  const [checked, setChecked] = useState<string[]>([]);
  const q = qs[i];
  if (!q) return null;
  const options: string[] = q.options?.length ? q.options : ["Yes", "No"];
  const next = (answer: string) => {
    const all = [...answers, { index: q.index ?? i, question: q.question, answer }];
    if (i + 1 >= qs.length) onAnswer({ answers: all });
    else { setAnswers(all); setI(i + 1); setChecked([]); }
  };
  return (
    <div className="prompt" role="alertdialog" aria-label="Question">
      <div className="prompt-title">{q.topic ? `[${q.topic}] ` : ""}{q.question}</div>
      <div className="prompt-sub">Question {i + 1} of {qs.length}</div>
      <div className="prompt-actions wrap">
        {options.map((o) => q.multiSelect
          ? <label key={o} className="check"><input type="checkbox" checked={checked.includes(o)} onChange={() => setChecked(checked.includes(o) ? checked.filter((x) => x !== o) : [...checked, o])} />{o}</label>
          : <button key={o} onClick={() => next(o)}>{o}</button>)}
        {q.multiSelect && <button className="primary" onClick={() => next(checked.join(", "))}>Continue</button>}
        <button className="danger" onClick={() => onAnswer({ cancelled: true, answers: [] })}>Cancel</button>
      </div>
    </div>
  );
}

function Picker({ p, onAnswer }: { p: Prompt; onAnswer: (r: unknown) => void }) {
  const rows: { id: string; label: string; detail?: string }[] = p.params.rows ?? [];
  const [sel, setSel] = useState<string[]>(p.params.preselectedIds ?? []);
  const multi = !!p.params.multi;
  return (
    <div className="prompt" role="alertdialog" aria-label={String(p.params.title ?? "Pick")}>
      <div className="prompt-title">{String(p.params.title ?? "Pick")}</div>
      {p.params.hint && <div className="prompt-sub">{String(p.params.hint)}</div>}
      <div className="picker">
        {rows.map((r) => (
          <label key={r.id} className="check">
            <input type={multi ? "checkbox" : "radio"} checked={sel.includes(r.id)} onChange={() => setSel(multi ? (sel.includes(r.id) ? sel.filter((x) => x !== r.id) : [...sel, r.id]) : [r.id])} />
            {r.label}{r.detail ? <span className="muted"> {r.detail}</span> : null}
          </label>
        ))}
      </div>
      <div className="prompt-actions">
        <button className="primary" onClick={() => onAnswer({ selectedIds: sel })}>Select</button>
        <button className="danger" onClick={() => onAnswer({ cancelled: true, selectedIds: [] })}>Cancel</button>
      </div>
    </div>
  );
}

export function Prompts({ prompts, onAnswer }: { prompts: Prompt[]; onAnswer: (requestId: string, result: unknown) => void }) {
  const p = prompts[0];
  if (!p) return null;
  const answer = (r: unknown) => onAnswer(p.requestId, r);
  return p.method === "request_permission" ? <Permission key={p.requestId} p={p} onAnswer={answer} /> : p.method === "ask_user" ? <Questions key={p.requestId} p={p} onAnswer={answer} /> : <Picker key={p.requestId} p={p} onAnswer={answer} />;
}
