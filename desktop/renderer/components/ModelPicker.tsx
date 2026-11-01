// Model picker (spec §14.3): search, "auto" first, a pinned short list, then groups by provider.
import { useEffect, useMemo, useRef, useState } from "react";
import { pickerSections, type ModelRow } from "../lib/models.ts";

export function ModelPicker({ models, value, autoAvailable, pinned, onPick }: { models: ModelRow[]; value?: string; autoAvailable?: boolean; pinned?: string[]; onPick(id: string): void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) input.current?.focus(); else setQ(""); }, [open]);
  const sections = useMemo(() => pickerSections(models, { query: q, autoAvailable, pinned }), [models, q, autoAvailable, pinned]);
  const current = value === "auto" ? "Auto" : models.find((m) => m.id === value)?.displayName ?? value ?? "Model";
  return (
    <div className="chip-wrap">
      <button className="chip" onClick={() => setOpen(!open)} aria-haspopup="listbox" aria-expanded={open} title="Model">{current}</button>
      {open && (
        <div className="menu model-menu" role="listbox" aria-label="Models">
          <input ref={input} className="menu-search" placeholder="Search models" aria-label="Search models" value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); if (e.key === "Enter") { const first = sections[0]?.models[0]; if (first && !first.unavailable) { onPick(first.id); setOpen(false); } } }} />
          {sections.map((s) => (
            <div key={s.title || "auto"}>
              {s.title && <div className="menu-group">{s.title}</div>}
              {s.models.map((m) => (
                <button key={m.id} role="option" aria-selected={m.id === value} disabled={m.unavailable} className={`menu-item ${m.unavailable ? "greyed" : ""}`}
                  onClick={() => { onPick(m.id); setOpen(false); }}>{m.displayName ?? m.id}</button>
              ))}
            </div>
          ))}
          {!sections.length && <div className="menu-group">{models.length ? "No models match" : "No models configured"}</div>}
        </div>
      )}
    </div>
  );
}
