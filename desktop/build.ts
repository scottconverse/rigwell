// Builds the desktop app into desktop/dist: main and preload as CommonJS for Electron, the renderer as browser ESM.
// Run with: bun run build.ts   (from desktop/)
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dir;
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "renderer"), { recursive: true });

async function build(cfg: Parameters<typeof Bun.build>[0]) {
  const r = await Bun.build(cfg);
  if (!r.success) { for (const l of r.logs) console.error(String(l)); process.exit(1); }
}

await build({
  entrypoints: [join(root, "main/main.ts")], outdir: dist, naming: "main.cjs", target: "node", format: "cjs",
  external: ["electron", "bufferutil", "utf-8-validate"], minify: false,
});
await build({
  entrypoints: [join(root, "preload/preload.ts")], outdir: dist, naming: "preload.cjs", target: "node", format: "cjs",
  external: ["electron"],
});
await build({
  entrypoints: [join(root, "renderer/App.tsx")], outdir: join(dist, "renderer"), naming: "app.[ext]", target: "browser", format: "esm",
  define: { "process.env.NODE_ENV": '"production"' }, splitting: true, minify: true,
});
await build({
  entrypoints: [join(root, "renderer/boot.ts")], outdir: join(dist, "renderer"), naming: "boot.js", target: "browser", format: "iife",
});
// KaTeX stylesheet and fonts ship with the app (the CSP allows only our own files).
cpSync(join(root, "node_modules/katex/dist/katex.min.css"), join(dist, "renderer/katex.min.css"));
cpSync(join(root, "node_modules/katex/dist/fonts"), join(dist, "renderer/fonts"), { recursive: true });
cpSync(join(root, "renderer/index.html"), join(dist, "renderer/index.html"));
console.log("built", dist);
