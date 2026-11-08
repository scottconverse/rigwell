import { useEffect, useRef, useState } from "react";
import { bridge } from "../lib/rpc.ts";
import { rotateRight, zoomIn, zoomOut } from "../lib/imageview.ts";

/** Any browser-decodable image (gif and webp too) as a PNG data URL, which the main process can put on the clipboard. */
async function pngDataUrl(src: string): Promise<string> {
  const img = new Image();
  img.src = src;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  c.getContext("2d")!.drawImage(img, 0, 0);
  return c.toDataURL("image/png");
}

/** Full-window image preview with a toolbar: zoom in/out, fit, rotate, copy, remove (optional) and close. Esc closes. */
export function ImagePreview({ src, name, onClose, onRemove }: { src: string; name: string; onClose(): void; onRemove?(): void }) {
  const [zoom, setZoom] = useState(1);
  const [deg, setDeg] = useState(0);
  const [note, setNote] = useState("");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", h, true);
    return () => { window.removeEventListener("keydown", h, true); window.clearTimeout(timer.current); };
  }, [onClose]);
  const say = (t: string) => { setNote(t); window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setNote(""), 2000); };
  const copy = async () => {
    try { await bridge().clipboard.writeImage(await pngDataUrl(src)); say("Copied"); } catch { say("Copy failed"); }
  };
  return (
    <div className="overlay image-overlay" role="dialog" aria-label={`Image preview: ${name}`} onClick={onClose}>
      <div className="image-toolbar" role="toolbar" aria-label="Image tools" onClick={(e) => e.stopPropagation()}>
        <span className="image-name" title={name}>{name}</span>
        <button aria-label="Zoom out" title="Zoom out" onClick={() => setZoom(zoomOut)}>-</button>
        <span className="image-zoom" aria-live="polite" data-testid="image-zoom">{Math.round(zoom * 100)}%</span>
        <button aria-label="Zoom in" title="Zoom in" onClick={() => setZoom(zoomIn)}>+</button>
        <button aria-label="Fit" title="Fit to window" onClick={() => { setZoom(1); setDeg(0); }}>Fit</button>
        <button aria-label="Rotate" title="Rotate 90 degrees" onClick={() => setDeg(rotateRight)}>Rotate</button>
        <button aria-label="Copy image" title="Copy image" onClick={() => void copy()}>Copy</button>
        {onRemove && <button aria-label="Remove attachment" title="Remove attachment" onClick={() => { onRemove(); onClose(); }}>Remove</button>}
        <button aria-label="Close preview" title="Close (Esc)" onClick={onClose}>Close</button>
        {note && <span className="muted small" role="status">{note}</span>}
      </div>
      <div className="image-stage" onClick={(e) => e.stopPropagation()} onWheel={(e) => setZoom(e.deltaY < 0 ? zoomIn : zoomOut)}>
        <img alt={name} src={src} style={{ transform: `scale(${zoom}) rotate(${deg}deg)` }} />
      </div>
    </div>
  );
}
