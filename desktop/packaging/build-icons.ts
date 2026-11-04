// Generates the app and tray icons from desktop/assets/icon.svg (an original Rigwell design). Run from desktop/:
//   bun run packaging/build-icons.ts
// Output (committed, so a normal build needs no tools): assets/icons/<size>x<size>.png (electron-builder's Linux icon folder),
// assets/icon.png (512), assets/icon.ico (Windows), assets/icon.icns (macOS) and assets/tray/{idle,working,attention}.png (32 px).
// Rendering uses the Chromium that Playwright installs (a devDependency); ICO and ICNS are written here (PNG payloads).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const svg = readFileSync(join(root, "assets/icon.svg"), "utf8");
const { chromium } = createRequire(join(root, "package.json"))("playwright");

const SIZES = [16, 24, 32, 48, 64, 96, 128, 256, 512, 1024];
const dotted = (color: string) => svg.replace("</svg>", `<circle cx="790" cy="790" r="190" fill="#0e2a36"/><circle cx="790" cy="790" r="140" fill="${color}"/></svg>`);

const browser = await chromium.launch();
const page = await browser.newPage();
async function render(source: string, size: number): Promise<Buffer> {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${source}`);
  return (await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } })) as Buffer;
}

const pngs = new Map<number, Buffer>();
for (const s of SIZES) pngs.set(s, await render(svg, s));
mkdirSync(join(root, "assets/icons"), { recursive: true });
mkdirSync(join(root, "assets/tray"), { recursive: true });
for (const [s, buf] of pngs) writeFileSync(join(root, `assets/icons/${s}x${s}.png`), buf);
writeFileSync(join(root, "assets/icon.png"), pngs.get(512)!);
for (const [name, color] of [["idle", ""], ["working", "#e8a33d"], ["attention", "#e5484d"]] as const) {
  writeFileSync(join(root, `assets/tray/${name}.png`), await render(color ? dotted(color) : svg, 32));
  writeFileSync(join(root, `assets/tray/${name}@2x.png`), await render(color ? dotted(color) : svg, 64));
}
await browser.close();

// ICO: directory of PNG images (Windows Vista and later read PNG payloads; 256 is stored as width 0).
{
  const sizes = [16, 24, 32, 48, 64, 128, 256].filter((s) => pngs.has(s));
  const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
  const dir = Buffer.alloc(16 * sizes.length);
  let offset = 6 + dir.length;
  sizes.forEach((s, i) => {
    const png = pngs.get(s)!;
    dir.writeUInt8(s >= 256 ? 0 : s, i * 16); dir.writeUInt8(s >= 256 ? 0 : s, i * 16 + 1);
    dir.writeUInt16LE(1, i * 16 + 4); dir.writeUInt16LE(32, i * 16 + 6);
    dir.writeUInt32LE(png.length, i * 16 + 8); dir.writeUInt32LE(offset, i * 16 + 12);
    offset += png.length;
  });
  writeFileSync(join(root, "assets/icon.ico"), Buffer.concat([head, dir, ...sizes.map((s) => pngs.get(s)!)]));
}
// ICNS: 'icns' + length, then (type, length, PNG) entries.
{
  const types: [string, number][] = [["icp4", 16], ["icp5", 32], ["icp6", 64], ["ic07", 128], ["ic08", 256], ["ic09", 512], ["ic10", 1024]];
  const parts = types.map(([t, s]) => { const png = pngs.get(s)!; const h = Buffer.alloc(8); h.write(t, 0, "ascii"); h.writeUInt32BE(png.length + 8, 4); return Buffer.concat([h, png]); });
  const body = Buffer.concat(parts);
  const h = Buffer.alloc(8); h.write("icns", 0, "ascii"); h.writeUInt32BE(body.length + 8, 4);
  writeFileSync(join(root, "assets/icon.icns"), Buffer.concat([h, body]));
}
console.log("icons written to", join(root, "assets"));
