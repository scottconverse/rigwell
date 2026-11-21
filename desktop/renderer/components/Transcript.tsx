import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { bridge } from "../lib/rpc.ts";
import { renderMarkdown } from "../lib/markdown.ts";
import { enhance } from "../lib/enhance.ts";
import { mainArg, toolIcon, type Item } from "../lib/transcript.ts";
import { activityLabel, groupActivity, liveStep, type TranscriptRow } from "../lib/activity.ts";

export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  const ref = useRef<HTMLDivElement>(null);
  // The HTML is written here, not with dangerouslySetInnerHTML: React rewrites that on every render, which would throw away the
  // upgraded nodes (shiki, KaTeX, mermaid). It is written only when the text changes, then upgraded after paint.
  // `stale` stops upgrades for text that has since changed (streaming).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = html;
    let stale = false;
    if (/data-lang=|data-tex=/.test(html)) void enhance(el, () => stale).catch(() => {});
    return () => { stale = true; };
  }, [html]);
  return (
    <div
      ref={ref}
      className="md"
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest("a[data-ext]") as HTMLAnchorElement | null;
        if (a) { e.preventDefault(); void bridge().shell.openExternal(a.href); }
      }}
    />
  );
}

function ToolRow({ item }: { item: Extract<Item, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const arg = mainArg(item.name, item.input);
  const body = item.output ?? item.live ?? "";
  return (
    <div className={`tool ${item.status}`}>
      <button className="tool-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="tool-icon" aria-hidden>{toolIcon(item.name)}</span>
        <span className="tool-name">{item.name}</span>
        <span className="tool-arg">{arg}</span>
        <span className="tool-state">{item.status === "running" ? (item.phase ?? "running") : item.status === "error" ? "failed" : ""}</span>
      </button>
      {open && <pre className="tool-body">{body || JSON.stringify(item.input, null, 2)}</pre>}
    </div>
  );
}

function ItemRow({ item: i }: { item: Item }) {
  switch (i.kind) {
    case "user": return <div className="bubble user">{i.text}</div>;
    case "assistant": return <div className="assistant"><Markdown text={i.text} /></div>;
    case "thinking": return <details className="thinking"><summary>Thinking</summary><pre>{i.text}</pre></details>;
    case "tool": return <ToolRow item={i} />;
    case "info": return <div className={`notice ${i.level}`}>{i.text}</div>;
  }
}

function ActivityGroup({ group }: { group: Extract<TranscriptRow, { kind: "group" }> }) {
  const [choice, setChoice] = useState<boolean>();
  const open = choice ?? group.autoOpen;
  return (
    <div className={`activity${group.failed ? " error" : ""}`}>
      <button className="activity-head" onClick={() => setChoice(!open)} aria-expanded={open}>
        <span className="activity-caret" aria-hidden>{open ? "v" : ">"}</span>
        <span>{activityLabel(group)}</span>
      </button>
      {open && <div className="activity-body">{group.items.map((x) => <ItemRow key={x.id} item={x} />)}</div>}
    </div>
  );
}

export function Transcript({ items, working }: { items: Item[]; working: string }) {
  const end = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const rows = useMemo(() => groupActivity(items, working !== "idle"), [items, working]);
  useEffect(() => { if (stick.current) end.current?.scrollIntoView({ block: "end" }); }, [items, working]);
  return (
    <div className="transcript" ref={box} onScroll={() => { const b = box.current!; stick.current = b.scrollHeight - b.scrollTop - b.clientHeight < 80; }}>
      {rows.map((r) => r.kind === "group" ? <ActivityGroup key={r.id} group={r} /> : <ItemRow key={r.item.id} item={r.item} />)}
      {working !== "idle" && <div className="working" aria-live="polite">{working === "waiting_for_tool_confirmation" ? "Waiting for your approval" : liveStep(items)}<span className="dots" /></div>}
      <div ref={end} />
    </div>
  );
}
