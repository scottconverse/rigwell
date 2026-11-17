import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { sourceSymbols } from "../review/semantic.ts";

const hash = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const PAGE = /^(?:overview|architecture|glossary|module-[a-f0-9]{16})\.md$/;
const CODE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|cs|c|cpp|cc|cxx|h|hpp|php|rb|ps1|sh)$/i;
const EXCLUDED = /(?:^|\/)(?:evidence|node_modules|vendor|dist|build|release|coverage|\.git|\.rigwell)(?:\/|$)|(?:^|\/)(?:[^/]*\.generated\.[^/]+|[^/]*\.min\.[^/]+|\.env[^/]*|credentials\.json|secrets\.json|settings\.json)$/i;
export interface WikiPage { file: string; title: string; sources: string[]; inputHash: string; contentHash: string }
export interface WikiIndex { version: 1; head: string; files: number; modules: number; pages: WikiPage[]; warnings: string[] }
interface Source { path: string; text: string; digest: string; module: string; symbols: Awaited<ReturnType<typeof sourceSymbols>>["symbols"]; warning?: string; imports: string[] }
const md = (s: string) => s.replace(/[\r\n]/g, " ").replace(/[\\`*_{}\[\]<>|]/g, "\\$&");
const cite = (p: string, line = 1) => `\`${p.replaceAll("`", "")}:${line}\``;

/** Only the explicitly selected project may contain wiki writes. Never follow wiki/source links. */
export function wikiPath(cwd: string, file?: string) {
  const project = realpathSync(resolve(cwd));
  if (!lstatSync(project).isDirectory()) throw new Error("Choose an existing project folder");
  const target = join(project, ".rigwell", "wiki", ...(file ? [file] : []));
  const rel = relative(project, target);
  if (isAbsolute(rel) || rel.startsWith("..") || file && !/^[a-zA-Z0-9._-]+$/.test(file)) throw new Error("Invalid wiki path");
  let current = project;
  for (const part of rel.split(/[\\/]/)) {
    current = join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) throw new Error("Wiki paths cannot contain links"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  return target;
}
function sourcePath(project: string, name: string) {
  const file = resolve(project, name), rel = relative(project, file);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Invalid repository source path");
  let path = project;
  for (const part of rel.split(/[\\/]/)) { path = join(path, part); if (lstatSync(path).isSymbolicLink()) throw new Error(`Wiki source links are not read: ${name}`); }
  return file;
}
function git(cwd: string, ...args: string[]) { return execFileSync("git", ["-c", "core.fsmonitor=false", ...args], { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }); }
function head(cwd: string) { try { return git(cwd, "rev-parse", "HEAD").trim(); } catch { return "uncommitted"; } }
export function readWikiIndex(cwd: string): WikiIndex | undefined {
  const file = wikiPath(cwd, "index.json"); if (!existsSync(file)) return;
  if (lstatSync(file).size > 4 * 1024 * 1024) throw new Error("Wiki index is too large");
  const index = JSON.parse(readFileSync(file, "utf8"));
  if (index.version !== 1 || !Array.isArray(index.pages) || index.pages.length > 2003 || index.pages.some((p: WikiPage) => !PAGE.test(p.file) || typeof p.title !== "string" || !Array.isArray(p.sources))) throw new Error("Invalid wiki index");
  return index;
}
export function readWikiPage(cwd: string, file: string) {
  if (!PAGE.test(file) || !readWikiIndex(cwd)?.pages.some((p) => p.file === file)) throw new Error("Unknown wiki page");
  return pageText(cwd, file);
}
function pageText(cwd: string, file: string) {
  const path = wikiPath(cwd, file); if (lstatSync(path).size > 2 * 1024 * 1024) throw new Error("Wiki page exceeds 2 MiB");
  return readFileSync(path, "utf8");
}
export function searchWiki(cwd: string, query = "") {
  const index = readWikiIndex(cwd); const q = query.trim().toLowerCase().slice(0, 300);
  return { index, pages: (index?.pages ?? []).flatMap((p) => { const text = pageText(cwd, p.file), at = q ? (p.title + "\n" + text).toLowerCase().indexOf(q) : 0; return at < 0 ? [] : [{ ...p, excerpt: text.slice(Math.max(0, at - 60), Math.max(0, at - 60) + 240) }]; }) };
}
function atomic(cwd: string, file: string, content: string) {
  const tmp = `${file}.${randomUUID()}.tmp`, path = wikiPath(cwd, tmp);
  try { writeFileSync(path, content, { flag: "wx", mode: 0o600 }); renameSync(path, wikiPath(cwd, file)); }
  finally { if (existsSync(path)) unlinkSync(path); }
}
export async function withWikiLock<T>(cwd: string, work: () => Promise<T>): Promise<T> {
  mkdirSync(wikiPath(cwd), { recursive: true }); const lock = wikiPath(cwd, ".lock");
  try { writeFileSync(lock, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }), { flag: "wx", mode: 0o600 }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Wiki is busy; a crash lock may be removed only after its recorded process has stopped"); throw e; }
  try { return await work(); } finally { unlinkSync(lock); }
}

async function sources(cwd: string) {
  const project = realpathSync(cwd);
  const paths = [...new Set(git(project, "ls-files", "--cached", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean))].map((p) => p.replaceAll("\\", "/")).sort();
  const found: Source[] = []; let bytes = 0; const warnings: string[] = [];
  for (const path of paths) {
    if (EXCLUDED.test(path) || !(CODE.test(path) || /(?:^|\/)readme(?:\.[\w-]+)?\.md$/i.test(path) || path === "package.json")) continue;
    const full = resolve(project, path); if (!existsSync(full)) continue; // staged deletion
    const file = sourcePath(project, path), st = lstatSync(file);
    if (!st.isFile()) continue;
    if (st.size > 512 * 1024) { warnings.push(`${path}: excluded, larger than 512 KiB`); continue; }
    bytes += st.size; if (found.length >= 2000 || bytes > 16 * 1024 * 1024) throw new Error("Wiki source limit exceeded (2000 files / 16 MiB); no pages changed");
    const text = readFileSync(file, "utf8"); if (text.includes("\0")) { warnings.push(`${path}: excluded binary content`); continue; }
    const parsed = CODE.test(path) ? await sourceSymbols(path, text) : { symbols: [] };
    const imports = [...text.matchAll(/(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|\bimport\s*)["']([^"'\r\n]+)["']/g)].map((m) => m[1]!).filter((s) => s.startsWith("."));
    found.push({ path, text, digest: hash(text), module: dirname(path).replaceAll("\\", "/"), symbols: parsed.symbols, warning: parsed.warning, imports });
    if (parsed.warning) warnings.push(`${path}: ${parsed.warning}`);
  }
  return { found, warnings };
}
const intro = (text: string) => text.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n\s*\r?\n/).find((p) => p.trim() && !/^(?:#|```|<|\[!|!\[)/.test(p.trim()))?.trim().slice(0, 1200) ?? "No introductory README paragraph is available.";
const header = (title: string) => `# ${title}\n\nGenerated locally from repository sources. Declarations and import edges are observed facts; this is not a runtime or security assessment. Re-run wiki update after changing source files.\n\n`;
function graph(modules: string[], edges: [string, string][]) {
  const omitted = Math.max(0, modules.length - 80); modules = modules.slice(0, 80); edges = edges.filter(([a, b]) => modules.includes(a) && modules.includes(b));
  const ids = new Map(modules.map((m, i) => [m, `m${i}`]));
  return "```mermaid\ngraph TD\n" + (modules.length ? modules.map((m) => `  ${ids.get(m)}["${m.replace(/[^\w./ -]/g, "_")}"]`).join("\n") : '  empty["No source modules"]') + "\n" + edges.map(([a, b]) => `  ${ids.get(a)} --> ${ids.get(b)}`).join("\n") + "\n```\n" + (omitted ? `\nDiagram limited to 80 modules; ${omitted} additional modules remain in the repository map and module pages.\n` : "");
}
export async function buildWiki(cwd: string, options: { afterCommit?: boolean } = {}) {
  return withWikiLock(cwd, async () => {
    const project = realpathSync(cwd), previous = readWikiIndex(project), commit = head(project);
    if (options.afterCommit && previous?.head === commit) return { changed: [], removed: [], skipped: true, index: previous };
    const { found, warnings } = await sources(project), modules = [...new Set(found.filter((s) => CODE.test(s.path)).map((s) => s.module))].sort();
    const byPath = new Map(found.map((s) => [s.path, s])); const edges: [string, string][] = [];
    for (const s of found) for (const imp of s.imports) {
      const path = join(dirname(s.path), imp).replaceAll("\\", "/");
      const target = [path, ...[".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.js"].map((ext) => path + ext)].map((p) => byPath.get(p)).find(Boolean);
      if (target && target.module !== s.module && modules.includes(s.module) && modules.includes(target.module) && !edges.some(([a, b]) => a === s.module && b === target.module)) edges.push([s.module, target.module]);
    }
    edges.sort(([a, b], [c, d]) => a.localeCompare(c) || b.localeCompare(d));
    const generated: { page: WikiPage; text: string }[] = [];
    const add = (file: string, title: string, inputs: Source[], body: string) => {
      const text = header(title) + body;
      generated.push({ page: { file, title, sources: inputs.map((s) => s.path), inputHash: hash(JSON.stringify(inputs.map((s) => [s.path, s.digest]))), contentHash: hash(text) }, text });
    };
    const readme = found.find((s) => /^readme\.md$/i.test(s.path)), pkg = found.find((s) => s.path === "package.json"); let description = "";
    if (pkg) { try { const p = JSON.parse(pkg.text); description = `${typeof p.name === "string" ? md(p.name) : "Project"}${typeof p.description === "string" ? ": " + md(p.description) : ""}\n\nSource: ${cite(pkg.path)}\n\n`; } catch { warnings.push("package.json: invalid JSON"); } }
    add("overview.md", "Project overview", found, description + (readme ? `${intro(readme.text)}\n\nSource: ${cite(readme.path)}\n\n` : "No root README was found.\n\n") + `## Repository map\n\n${found.length} eligible files across ${modules.length} code modules. A module is a directory containing supported source code. Ignored files, dependencies, build output, private configuration and evidence folders are excluded.\n\n` + modules.map((m) => `- ${md(m)}: ${found.filter((s) => s.module === m && CODE.test(s.path)).length} source files`).join("\n") + (warnings.length ? "\n\n## Coverage warnings\n\n" + warnings.map((w) => `- ${md(w)}`).join("\n") : "") + "\n");
    add("architecture.md", "Architecture", found.filter((s) => CODE.test(s.path)), "## Module dependencies\n\nArrows follow resolved relative JavaScript/TypeScript imports from the importing module to its dependency. Dynamic paths, external packages and other language imports are not resolved. Unconnected modules remain visible.\n\n" + graph(modules, edges) + "\n## Observed edges\n\n" + (edges.map(([a, b]) => `- ${md(a)} depends on ${md(b)}`).join("\n") || "No cross-module relative imports were resolved.") + "\n");
    for (const mod of modules) {
      const files = found.filter((s) => s.module === mod), code = files.filter((s) => CODE.test(s.path)), docs = files.find((s) => /readme/i.test(basename(s.path)));
      const neighbors = edges.filter(([a, b]) => a === mod || b === mod), nodes = [...new Set([mod, ...neighbors.flat()])].sort();
      add(`module-${hash(mod).slice(0, 16)}.md`, `Module: ${md(mod)}`, files, (docs ? `${intro(docs.text)}\n\nSource: ${cite(docs.path)}\n\n` : "") + `## Responsibilities visible in source\n\nThis directory defines the declarations below. Names and locations describe the source surface; consult implementations and tests for behavior.\n\n` + code.map((s) => `### ${md(basename(s.path))}\n\nSource: ${cite(s.path)}\n\n${s.symbols.length ? s.symbols.map((sym) => `- ${md(sym.kind)} **${md(sym.name)}**: ${cite(s.path, sym.line)} through line ${sym.endLine}`).join("\n") : "No named function/class declarations were found."}${s.warning ? "\n\n" + md(s.warning) : ""}`).join("\n\n") + "\n\n## Dependencies\n\n" + graph(nodes, neighbors));
    }
    add("glossary.md", "Glossary", found.filter((s) => CODE.test(s.path)), "Names below are declared symbols, not inferred definitions.\n\n" + found.flatMap((s) => s.symbols.map((sym) => ({ name: sym.name, text: `- **${md(sym.name)}**: ${md(sym.kind)} in ${md(s.module)}, ${cite(s.path, sym.line)}` }))).sort((a, b) => a.name.localeCompare(b.name)).map((s) => s.text).join("\n") + "\n");
    const old = new Map(previous?.pages.map((p) => [p.file, p]) ?? []), changed: string[] = [], removed: string[] = [];
    // Preflight all collisions before changing any page. Preserve user-authored files.
    for (const { page, text } of generated) {
      if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error(`Wiki page exceeds 2 MiB: ${page.file}; no pages changed`);
      if (!old.has(page.file) && existsSync(wikiPath(project, page.file))) throw new Error(`Refusing to replace an unmanaged wiki page: ${page.file}`);
    }
    for (const { page, text } of generated) {
      const prior = old.get(page.file), path = wikiPath(project, page.file);
      if (!prior || prior.inputHash !== page.inputHash || prior.contentHash !== page.contentHash || !existsSync(path) || hash(readFileSync(path)) !== page.contentHash) { atomic(project, page.file, text); changed.push(page.file); }
      old.delete(page.file);
    }
    for (const file of old.keys()) { const path = wikiPath(project, file); if (existsSync(path)) unlinkSync(path); removed.push(file); }
    const index: WikiIndex = { version: 1, head: commit, files: found.length, modules: modules.length, pages: generated.map((g) => g.page), warnings };
    if (JSON.stringify(index) !== JSON.stringify(previous)) atomic(project, "index.json", JSON.stringify(index, null, 2) + "\n");
    return { changed, removed, skipped: false, index };
  });
}

export const wikiMethods = {
  list_wiki: (p: any) => searchWiki(String(p.cwd), typeof p.query === "string" ? p.query : ""),
  read_wiki_page: (p: any) => ({ text: readWikiPage(String(p.cwd), String(p.file)) }),
  build_wiki: (p: any) => buildWiki(String(p.cwd)),
};
