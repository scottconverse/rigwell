import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { bridge } from "../lib/rpc.ts";
import { renderMarkdown } from "../lib/markdown.ts";
import { enhance } from "../lib/enhance.ts";
import { ImagePreview } from "./ImagePreview.tsx";
import { buildMailto, emailPlainText, parseEmail } from "../lib/email.ts";
import { dataUrl } from "../lib/imageview.ts";
import { mainArg, toolIcon, type Item } from "../lib/transcript.ts";

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
        const t = e.target as HTMLElement;
        const card = t.closest(".email-card") as HTMLElement | null;
        const btn = t.closest("[data-email-copy], [data-email-open]") as HTMLButtonElement | null;
        const draft = card && btn ? parseEmail(card.dataset.email ?? "") : null;
        if (btn && draft) {
          if (btn.hasAttribute("data-email-open")) void bridge().shell.openExternal(buildMailto(draft)).catch(() => {});
          else void bridge().clipboard.writeText(emailPlainText(draft)).then(() => { btn.textContent = "Copied"; setTimeout(() => { btn.textContent = "Copy"; }, 1500); }, () => { btn.textContent = "Copy failed"; });
          return;
        }
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

export function Transcript({ items, working }: { items: Item[]; working: string }) {
  const end = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [preview, setPreview] = useState<{ src: string; name: string } | null>(null);
  useEffect(() => { if (stick.current) end.current?.scrollIntoView({ block: "end" }); }, [items, working]);
  return (
    <div className="transcript" ref={box} onScroll={() => { const b = box.current!; stick.current = b.scrollHeight - b.scrollTop - b.clientHeight < 80; }}>
      {items.map((i) => {
        switch (i.kind) {
          case "user": return (
            <div key={i.id} className="bubble user">
              {i.images && i.images.length > 0 && <div className="bubble-images">{i.images.map((im, n) => (
                <button key={n} className="thumb" aria-label={`Preview image ${n + 1}`} title="Click to preview" onClick={() => setPreview({ src: dataUrl(im), name: `image ${n + 1}` })}><img alt={`image ${n + 1}`} src={dataUrl(im)} /></button>
              ))}</div>}
              {i.text}
            </div>
          );
          case "assistant": return <div key={i.id} className="assistant"><Markdown text={i.text} /></div>;
          case "thinking": return <details key={i.id} className="thinking"><summary>Thinking</summary><pre>{i.text}</pre></details>;
          case "tool": return <ToolRow key={i.id} item={i} />;
          case "info": return <div key={i.id} className={`notice ${i.level}`}>{i.text}</div>;
        }
      })}
      {working !== "idle" && <div className="working" aria-live="polite">{working === "waiting_for_tool_confirmation" ? "Waiting for your approval" : "Working"}<span className="dots" /></div>}
      <div ref={end} />
      {preview && <ImagePreview src={preview.src} name={preview.name} onClose={() => setPreview(null)} />}
    </div>
  );
}
