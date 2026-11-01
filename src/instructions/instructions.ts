// Instruction files: CLAUDE.md / AGENTS.md discovery (spec §12.2 "Instruction files (AGENTS.md)").
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { PROMPT_TEXT } from "../agent/prompt-text.generated.ts";
import { render } from "../agent/prompts.ts";
import { findGitRoot } from "../config/levels.ts";
import { rigwellHome, userHomeDir } from "../storage/paths.ts";

/** File names tried in this order in each folder; the first one present is used (one file per folder). */
export const INSTRUCTION_NAMES = ["CLAUDE.md", "Claude.md", "AGENTS.md", "Agents.md", "agents.md"] as const;
/** Sub-folders checked next to each visited folder `D` (besides `D` itself). */
export const INSTRUCTION_SUBDIRS = [".rigwell", ".agents", ".agent"] as const;
export const TOTAL_BUDGET = 80_000;
export const LAZY_PASS_BUDGET = 40_000;
export const LAZY_MAX_FOLDERS = 24;
/** A file that crosses the limit is cut only if more than this many characters of budget remain. */
export const MIN_TRUNCATE_ROOM = 200;

export interface InstructionFile {
  /** Label shown to the model: project-relative path, or `~/<dir>/<file>` for personal files. */
  path: string;
  absPath: string;
  content: string;
  truncated: boolean;
  shownChars: number;
  personal: boolean;
}
export interface SkippedInstruction { path: string; reason: string }

export interface LoadedInstructions {
  files: InstructionFile[];
  /** Files that exist but were not loaded (symlink rules, broken links, ...). */
  skipped: SkippedInstruction[];
  /** The prompts.md §4.2 block, or null when there is nothing to show. */
  block: string | null;
  /** True when the 80,000 budget ran out (loading stopped). */
  budgetExhausted: boolean;
}

export interface InstructionOptions {
  cwd: string;
  /** Override for tests; default $HOME. */
  homeDir?: string;
  totalBudget?: number;
}

const contains = (outer: string, inner: string) => {
  const rel = path.relative(outer, inner);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};
const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };

/** Find the instruction file in one folder, or null. */
function pickName(dir: string): string | null {
  let names: string[];
  try { names = readdirSync(dir); } catch { return null; }
  const set = new Set(names);
  for (const n of INSTRUCTION_NAMES) if (set.has(n)) return n;
  return null;
}

interface Candidate { absPath: string; personal: boolean }

/** Validate symlink and type rules. Returns a skip reason, or null when the file may load. */
function checkFile(c: Candidate, boundary: string): string | null {
  let ls;
  try { ls = lstatSync(c.absPath); } catch { return "cannot be read"; }
  let st;
  try { st = statSync(c.absPath); } catch { return "broken link"; }
  if (!st.isFile()) return "not a regular file";
  if (ls.isSymbolicLink()) {
    const target = real(c.absPath);
    if (!/\.md$/i.test(target)) return "link does not point at a .md file";
    if (!c.personal && !contains(real(boundary), target)) return "link points outside the project";
  }
  return null;
}

function labelFor(absPath: string, boundary: string, personal: boolean, home: string): string {
  if (personal) {
    const rel = path.relative(home, absPath);
    return !rel.startsWith("..") && !path.isAbsolute(rel) ? "~/" + rel.split(path.sep).join("/") : absPath;
  }
  return path.relative(boundary, absPath).split(path.sep).join("/") || path.basename(absPath);
}

/** Render the project_instructions block (prompts.md §4.2). Null when there is nothing to show. */
export function renderInstructions(files: InstructionFile[], skipped: SkippedInstruction[] = []): string | null {
  if (!files.length && !skipped.length) return null;
  const items = [
    ...files.map((f) => ({ PATH: f.path, TRUNCATED: f.truncated, SHOWN_CHARS: f.shownChars, CONTENT: f.content })),
    ...skipped.map((s) => ({ PATH: s.path, TRUNCATED: false, SHOWN_CHARS: 0, CONTENT: `not loaded: ${s.reason}` })),
  ];
  return render(PROMPT_TEXT.ctx_project, { INSTRUCTION_FILES: items });
}

export class InstructionLoader {
  private home: string;
  private boundary: string;
  private cwd: string;
  private startSet = new Set<string>();
  private loaded = new Set<string>();
  private scanned = new Set<string>();
  private startScanned = new Set<string>();
  private pending: InstructionFile[] = [];
  private pendingSkipped: SkippedInstruction[] = [];
  private used = 0;

  constructor(private o: InstructionOptions) {
    this.cwd = path.resolve(o.cwd);
    this.home = path.resolve(o.homeDir ?? userHomeDir());
    const gitRoot = findGitRoot(this.cwd);
    // Outside a repo, or when the home folder is inside the git root: cwd is the boundary.
    this.boundary = gitRoot && !contains(gitRoot, this.home) ? gitRoot : this.cwd;
  }

  /** Candidate files in a visited folder `D`: D, D/.rigwell, D/.agents, D/.agent (first matching name each). */
  private candidatesIn(dir: string): Candidate[] {
    const out: Candidate[] = [];
    for (const sub of ["", ...INSTRUCTION_SUBDIRS]) {
      const d = sub ? path.join(dir, sub) : dir;
      const n = pickName(d);
      if (n) out.push({ absPath: path.join(d, n), personal: false });
    }
    return out;
  }

  private personalCandidates(): Candidate[] {
    const out: Candidate[] = [];
    for (const d of [rigwellHome(), path.join(this.home, ".agents"), path.join(this.home, ".agent")]) {
      const n = pickName(d);
      if (n) out.push({ absPath: path.join(d, n), personal: true });
    }
    return out;
  }

  /** Session start: cwd up to the boundary (nearest first), then personal files. */
  load(): LoadedInstructions {
    const cands: Candidate[] = [];
    for (let d = this.cwd; ; d = path.dirname(d)) {
      this.startScanned.add(d);
      if (d !== this.home) cands.push(...this.candidatesIn(d));
      if (d === this.boundary || path.dirname(d) === d) break;
    }
    cands.push(...this.personalCandidates());
    const budget = this.o.totalBudget ?? TOTAL_BUDGET;
    const r = this.consume(cands, budget);
    this.startSet = new Set(this.loaded);
    this.scanned = new Set(this.startScanned);
    this.used = r.used;
    return { files: r.files, skipped: r.skipped, block: renderInstructions(r.files, r.skipped), budgetExhausted: r.exhausted };
  }

  private consume(cands: Candidate[], budget: number) {
    const files: InstructionFile[] = [], skipped: SkippedInstruction[] = [];
    let used = 0, exhausted = false;
    for (const c of cands) {
      const rp = real(c.absPath);
      if (this.loaded.has(rp)) continue;
      const label = labelFor(c.absPath, this.boundary, c.personal, this.home);
      const why = checkFile(c, this.boundary);
      if (why) { skipped.push({ path: label, reason: why }); continue; }
      let text: string;
      try { text = readFileSync(c.absPath, "utf8"); } catch { skipped.push({ path: label, reason: "cannot be read" }); continue; }
      const room = budget - used;
      if (text.length > room) {
        if (room > MIN_TRUNCATE_ROOM) {
          const shown = text.slice(0, room);
          files.push({ path: label, absPath: c.absPath, content: shown + "\n[truncated: instruction budget reached]", truncated: true, shownChars: shown.length, personal: c.personal });
          this.loaded.add(rp);
          used += room;
        }
        exhausted = true;
        break;
      }
      files.push({ path: label, absPath: c.absPath, content: text, truncated: false, shownChars: text.length, personal: c.personal });
      this.loaded.add(rp);
      used += text.length;
    }
    return { files, skipped, used, exhausted };
  }

  /**
   * A file tool (Read/Create/Edit) touched `filePath`: scan the folders between the boundary and its folder
   * (at most 24 folders, 40,000 chars per pass). New finds are queued for the next-turn reminder; returns them.
   */
  discoverForPath(filePath: string): InstructionFile[] {
    let target = path.resolve(this.cwd, filePath);
    try { if (statSync(target).isFile()) target = path.dirname(target); } catch { target = path.dirname(target); }
    if (!contains(this.boundary, target)) return [];
    const dirs = [this.boundary];
    let cur = this.boundary;
    for (const seg of path.relative(this.boundary, target).split(path.sep).filter(Boolean)) { cur = path.join(cur, seg); dirs.push(cur); }
    const cands: Candidate[] = [];
    let n = 0;
    for (const d of dirs) {
      if (this.scanned.has(d)) continue;
      if (n++ >= LAZY_MAX_FOLDERS) break;
      this.scanned.add(d);
      if (d !== this.home) cands.push(...this.candidatesIn(d));
    }
    const r = this.consume(cands, LAZY_PASS_BUDGET);
    this.pending.push(...r.files);
    this.pendingSkipped.push(...r.skipped);
    return r.files;
  }

  /** Queued finds as a reminder block (same template), or null. Clears the queue. */
  takePending(): string | null {
    const block = renderInstructions(this.pending, this.pendingSkipped);
    this.pending = []; this.pendingSkipped = [];
    return block;
  }
  hasPending(): boolean { return this.pending.length > 0 || this.pendingSkipped.length > 0; }

  /** After compaction the loaded set resets to the session-start set, so deeper files can be found again. */
  afterCompaction() {
    this.loaded = new Set(this.startSet);
    this.scanned = new Set(this.startScanned);
    this.pending = []; this.pendingSkipped = [];
  }

  /** Header summary: how many instruction files are loaded ("Loaded" / "Not found" / "+N"). */
  loadedCount(): number { return this.loaded.size; }
}
