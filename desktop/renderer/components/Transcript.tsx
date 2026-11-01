import { useEffect, useMemo, useRef, useState } from "react";
import { bridge } from "../lib/rpc.ts";
import { renderMarkdown } from "../lib/markdown.ts";
import { mainArg, toolIcon, type Item } from "../lib/transcript.ts";

export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return (
    <div
      className="md"
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest("a[data-ext]") as HTMLAnchorElement | null;
        if (a) { e.preventDefault(); void bridge().shell.openExternal(a.href); }
      }}
      dangerouslySetInnerHTML={{ __html: html }}
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

export function Transcript({ items, working }: { items: Item[]; working: string }) {
  const end = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => { if (stick.current) end.current?.scrollIntoView({ block: "end" }); }, [items, working]);
  return (
    <div className="transcript" ref={box} onScroll={() => { const b = box.current!; stick.current = b.scrollHeight - b.scrollTop - b.clientHeight < 80; }}>
      {items.map((i) => {
        switch (i.kind) {
          case "user": return <div key={i.id} className="bubble user">{i.text}</div>;
          case "assistant": return <div key={i.id} className="assistant"><Markdown text={i.text} /></div>;
          case "thinking": return <details key={i.id} className="thinking"><summary>Thinking</summary><pre>{i.text}</pre></details>;
          case "tool": return <ToolRow key={i.id} item={i} />;
          case "info": return <div key={i.id} className={`notice ${i.level}`}>{i.text}</div>;
        }
      })}
      {working !== "idle" && <div className="working" aria-live="polite">{working === "waiting_for_tool_confirmation" ? "Waiting for your approval" : "Working"}<span className="dots" /></div>}
      <div ref={end} />
    </div>
  );
}
