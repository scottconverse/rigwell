import * as path from "node:path";
import type { CommandLists } from "../core/types.ts";
import {
  BUILTIN_ALLOW_RULES,
  FORK_BOMBS,
  IGNORED_FOR_ALLOW,
  RM_PROTECTED_TARGETS,
  SAFEGUARDS,
} from "./lists.ts";

export interface Match {
  /** Human-readable reason, e.g. "Built-in safety: rm-protected-target". */
  reason: string;
  /** Segment (normalized) that matched. */
  segment: string;
}

export type Classification =
  | { kind: "block"; match: Match }
  | { kind: "ask"; match: Match }
  | { kind: "allow"; match: Match }
  | { kind: "none" };

export interface Segments {
  segments: string[];
  /** False when quoting is unbalanced; the whole command is then not auto-allowed. */
  parseable: boolean;
}

/** Splits on ; && || | & and newlines outside simple quotes. */
export function splitSegments(cmd: string): Segments {
  const segments: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  const push = () => {
    if (cur.trim()) segments.push(cur.trim());
    cur = "";
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (quote) {
      cur += c;
      if (c === "\\" && quote === '"' && i + 1 < cmd.length) cur += cmd[++i];
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "\\" && i + 1 < cmd.length) {
      cur += c + cmd[++i];
    } else if (c === "'" || c === '"') {
      quote = c;
      cur += c;
    } else if (c === ";" || c === "\n" || c === "|") {
      if (c === "|" && cmd[i + 1] === "|") i++;
      push();
    } else if (c === "&") {
      const prev = cmd[i - 1];
      const next = cmd[i + 1];
      if (next === "&") {
        i++;
        push();
      } else if (prev === ">" || prev === "<" || next === ">") {
        cur += c; // redirection such as 2>&1 or &>file
      } else {
        push();
      }
    } else {
      cur += c;
    }
  }
  if (quote) return { segments: [cmd.trim()], parseable: false };
  push();
  return { segments, parseable: true };
}

/** Shell-like words with quotes removed. Returns null if quoting is unbalanced. */
export function words(seg: string): string[] | null {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < seg.length) cur += seg[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (c === "\\" && i + 1 < seg.length) {
      cur += seg[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += c;
    }
  }
  if (quote) return null;
  if (has || cur) out.push(cur);
  return out;
}

const WRAPPER = /^(?:npx|bunx|pnpm\s+dlx|npm\s+exec)\s+((?:-\S+\s+)*)/i;

/** Removes npx / bunx / pnpm dlx / npm exec (and their flags) from the start of a segment. */
export function unwrap(seg: string): string {
  let s = seg.trim();
  for (let i = 0; i < 4; i++) {
    const m = WRAPPER.exec(s);
    if (!m) break;
    s = s.slice(m[0].length).replace(/^--\s+/, "");
  }
  return s;
}

function esc(t: string): string {
  return t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const LEAD = "(?<![^\\s;|&(])";
const TRAIL = "(?=\\s|$)";
const PREFIXES = "(?:(?:sudo|doas|env|command|exec|nohup|time)\\s+(?:-\\S+\\s+)*)*(?:\\S*/)?";

function tokensOf(entry: string): string[] {
  return entry.trim().split(/\s+/).filter(Boolean);
}

function between(tokens: string[]): string {
  return tokens.map(esc).join("[\\s\\S]{0,100}?");
}

/**
 * Entry match for deny/block lists. Single-token entries (shutdown, mkfs) must be at
 * the command position, so `grep reboot log` does not match; multi-token entries match
 * anywhere in the segment, with up to 100 characters between tokens.
 */
export function matchesEntryAnywhere(segment: string, entry: string): boolean {
  const toks = tokensOf(entry);
  if (toks.length === 0) return false;
  // A last token that names a path (`of=/dev`) also covers paths under it (`of=/dev/sda`). A bare `/` stays exact.
  const sub = /\/[^/]+$/.test(toks[toks.length - 1]) ? "(?:/\\S*)?" : "";
  const body = between(toks) + sub;
  const re = toks.length === 1
    ? new RegExp(`^\\s*${PREFIXES}${body}${TRAIL}`, "i")
    : new RegExp(`${LEAD}${body}${TRAIL}`, "i");
  return re.test(segment);
}

/** Entry match for allow lists: anchored at the start, tokens adjacent (no gap, so `git commit -m status` is not `git status`). */
export function matchesEntryPrefix(segment: string, entry: string, caseSensitive = false): boolean {
  const toks = tokensOf(entry);
  if (toks.length === 0) return false;
  return new RegExp(`^\\s*${toks.map(esc).join("\\s+")}${TRAIL}`, caseSensitive ? "" : "i").test(segment);
}

/** rm -r/-R/--recursive aimed at a protected target. rm of only /tmp paths is exempt. */
export function rmProtected(segment: string): boolean {
  const w = words(segment);
  if (!w) return false;
  const i = w.findIndex((x) => x === "rm" || x.endsWith("/rm"));
  if (i === -1) return false;
  const args = w.slice(i + 1);
  const recursive = args.some((a) => /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(a) || a === "--recursive");
  if (!recursive) return false;
  const targets = args.filter((a) => !a.startsWith("-") || a === "-");
  if (targets.length > 0 && targets.every(isTmpPath)) return false;
  return targets.some((t) => RM_PROTECTED_TARGETS.includes(t) || RM_PROTECTED_TARGETS.includes(normTarget(t)) || /^\/+$/.test(t) || /^(\$HOME|\$\{HOME\}|~)\/\*?$/.test(t));
}

function normTarget(t: string): string {
  if (!t.startsWith("/") && !t.startsWith("~")) return t;
  const n = path.posix.normalize(t);
  return n.length > 1 && n.endsWith("/") ? n.slice(0, -1) : n;
}

function isTmpPath(t: string): boolean {
  return /^\/tmp\/[^\s]+$/.test(t) && !t.split("/").includes("..");
}

const SUBST = /\$\(([^()]*)\)|`([^`]*)`|<\(([^()]*)\)|>\(([^()]*)\)/g;

function hasSubstitution(seg: string): boolean {
  SUBST.lastIndex = 0;
  return SUBST.test(seg);
}

/** Inner commands of $(...) / backticks, so they are checked for block and ask too. */
function innerSegments(seg: string): string[] {
  const out: string[] = [];
  SUBST.lastIndex = 0;
  for (const m of seg.matchAll(SUBST)) {
    const body = m[1] ?? m[2] ?? m[3] ?? m[4] ?? "";
    out.push(...splitSegments(body).segments);
  }
  return out;
}

/** True if the segment redirects output to something other than /dev/null or an fd. */
function writesViaRedirect(seg: string): boolean {
  const stripped = seg.replace(/\d*>&\d+|&>\s*\/dev\/null|\d*>>?\s*\/dev\/null/g, " ");
  return stripped.includes(">");
}

function normalize(seg: string): string {
  const w = words(seg);
  return unwrap(w ? w.join(" ") : seg);
}

function safeguardMatch(seg: string): Match | null {
  if (rmProtected(seg)) return { reason: "Built-in safety: rm-protected-target", segment: seg };
  for (const g of SAFEGUARDS) {
    for (const e of g.entries) {
      if (matchesEntryAnywhere(seg, e)) return { reason: `Built-in safety: ${g.id}`, segment: seg };
    }
  }
  return null;
}

function allowMatch(seg: string, lists: CommandLists): Match | null {
  if (hasSubstitution(seg) || writesViaRedirect(seg)) return null;
  for (const rule of BUILTIN_ALLOW_RULES) {
    for (const p of rule.prefixes) {
      if (matchesEntryPrefix(seg, p.join(" "), rule.caseSensitive)) return { reason: `Rule: ${rule.id}`, segment: seg };
    }
  }
  for (const e of lists.allow) {
    if (matchesEntryPrefix(seg, e)) return { reason: `Allowlist: ${e}`, segment: seg };
  }
  return null;
}

/**
 * Classifies a command. Precedence: block > ask (deny list, safeguards) > allow > none.
 */
export function classifyCommand(command: string, lists: CommandLists): Classification {
  const squashed = command.replace(/\s+/g, "");
  if (FORK_BOMBS.some((f) => squashed.includes(f))) {
    return { kind: "ask", match: { reason: "Built-in safety: fork-bomb", segment: command.trim() } };
  }
  const { segments, parseable } = splitSegments(command);
  const checked: string[] = [];
  for (const raw of segments) {
    checked.push(normalize(raw), ...innerSegments(raw).map(normalize));
  }
  for (const seg of checked) {
    for (const e of lists.block) {
      if (matchesEntryAnywhere(seg, e)) return { kind: "block", match: { reason: `Blocklist: ${e}`, segment: seg } };
    }
  }
  for (const seg of checked) {
    const g = safeguardMatch(seg);
    if (g) return { kind: "ask", match: g };
    for (const e of lists.deny) {
      if (matchesEntryAnywhere(seg, e)) return { kind: "ask", match: { reason: `Denylist: ${e}`, segment: seg } };
    }
  }
  if (!parseable || segments.length === 0) return { kind: "none" };
  let first: Match | null = null;
  for (const raw of segments) {
    const seg = normalize(raw);
    const firstWord = words(seg)?.[0]?.toLowerCase();
    const ignorable = firstWord !== undefined && IGNORED_FOR_ALLOW.includes(firstWord);
    if (ignorable && !writesViaRedirect(raw) && !hasSubstitution(raw)) continue;
    const m = allowMatch(seg, lists);
    if (!m) return { kind: "none" };
    first ??= m;
  }
  return first ? { kind: "allow", match: first } : { kind: "none" };
}
