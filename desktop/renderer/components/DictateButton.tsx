// Microphone button of the composer (voice dictation, Ctrl+Shift+D). Offline first: with no backend configured the button
// explains how to enable one instead of recording.
import { useEffect, useRef, useState } from "react";
import { startRecording, type Recording } from "../lib/dictation.ts";
import { bridge } from "../lib/rpc.ts";

type Phase = "idle" | "recording" | "working";

export function DictateButton({ onText, disabled, shortcut }: { onText(text: string): void; disabled?: boolean; shortcut?: boolean }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [note, setNote] = useState<{ text: string; help?: boolean } | null>(null);
  const rec = useRef<Recording | null>(null);

  const toggle = async () => {
    if (phase === "working") return;
    if (phase === "recording") {
      setPhase("working");
      try {
        const wav = await rec.current!.stop();
        rec.current = null;
        const r = await bridge().dictation.transcribe(wav);
        if (r.text) { onText(r.text); setNote(null); } else setNote({ text: r.error ?? "No speech was recognized.", help: r.code === "not-configured" });
      } catch (e) { setNote({ text: (e as Error).message }); }
      setPhase("idle");
      return;
    }
    setNote(null);
    const st = await bridge().dictation.status();
    if (!st.ready) { setNote({ text: st.message, help: true }); return; }
    try { rec.current = await startRecording(); setPhase("recording"); if (st.remote) setNote({ text: st.message }); } catch (e) { setNote({ text: (e as Error).message }); }
  };

  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;
  useEffect(() => {
    if (!shortcut) return;
    const h = (e: KeyboardEvent) => { if (e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === "d") { e.preventDefault(); void toggleRef.current(); } };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [shortcut]);
  useEffect(() => () => rec.current?.cancel(), []);

  return (
    <div className="chip-wrap">
      <button className={phase === "recording" ? "chip rec" : "chip"} aria-label={phase === "recording" ? "Stop dictation" : "Dictate"} aria-pressed={phase === "recording"} disabled={disabled || phase === "working"}
        title="Voice dictation (Ctrl+Shift+D)" onClick={() => void toggle()}>
        {phase === "recording" ? "Stop" : phase === "working" ? "Listening..." : "Dictate"}
      </button>
      {note && (
        <div className="menu note" role="status" aria-label="Dictation">
          <div className="small">{note.text}</div>
          <div className="dialog-actions">
            {note.help && <button onClick={() => { window.location.hash = "/settings/voice"; setNote(null); }}>Open voice settings</button>}
            <button onClick={() => setNote(null)}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}
