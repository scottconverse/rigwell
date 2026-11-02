// Secret scan before `git commit` (spec 5.5.1 confirmation type for secret scanning, 12.2 switch, 13.4 prompt).
//
// Rigwell names: setting `enableSecretScan` (default off), confirmation type `secret_scan_violation`, outcome
// `proceed_report_false_positive` (as in the spec's outcome list). When the setting is on and an Execute command contains
// a `git commit`, the changes that commit would record are scanned with a small original rule set. On a hit the user is
// asked: "Proceed anyway" (proceed_once), "Proceed & report false positive" (proceed_report_false_positive), "Cancel".
// A reported false positive is written to $RIGWELL_HOME/logs/secret-scan-false-positives.jsonl (local only, never sent
// anywhere) and is not asked about again. Only ADDED lines are scanned. The log never holds the secret itself: a short
// redacted preview and a SHA-256 fingerprint of the match.
//
// Scope: git commit only. The output of Execute commands is not scanned (the spec ties the scan to commits).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { rigwellHome } from "../storage/paths.ts";
import { splitSegments, unwrap, words } from "./command.ts";

export interface SecretFinding {
  rule: string;
  description: string;
  file: string;
  line: number;
  /** First characters of the match plus "..." (never the whole secret). */
  preview: string;
  fingerprint: string;
}

interface Rule { id: string; description: string; re: RegExp; group?: number; minEntropy?: number }

export const SECRET_RULES: Rule[] = [
  { id: "private-key", description: "Private key block", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/ },
  { id: "aws-access-key-id", description: "AWS access key id", re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/ },
  { id: "aws-secret-access-key", description: "AWS secret access key", re: /aws.{0,20}secret.{0,20}?['"=: ]\s*['"]?([A-Za-z0-9/+=]{40})\b/i, group: 1 },
  { id: "github-token", description: "GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/ },
  { id: "anthropic-api-key", description: "Anthropic-style API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { id: "openai-api-key", description: "OpenAI-style API key", re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/ },
  { id: "slack-token", description: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { id: "google-api-key", description: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: "stripe-live-key", description: "Stripe live key", re: /\b[rs]k_live_[0-9A-Za-z]{20,}/ },
  { id: "jwt", description: "JSON Web Token", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  {
    id: "generic-credential", description: "Hard-coded credential assignment",
    re: /\b(?:api[_-]?key|secret|token|passwd|password|auth[_-]?key|access[_-]?key)\w*\s*[:=]\s*['"]([A-Za-z0-9/+_\-=.]{16,})['"]/i, group: 1, minEntropy: 3.3,
  },
];

const PLACEHOLDER = /example|placeholder|changeme|change-me|your[_-]|<.*>|xxxx|\*{4}|\$\{|%\(|test|dummy|sample|fake|todo/i;

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}

export const fingerprintOf = (rule: string, match: string) => createHash("sha256").update(`${rule}\0${match}`).digest("hex").slice(0, 32);
const preview = (m: string) => `${m.slice(0, Math.min(4, Math.max(1, Math.floor(m.length / 4))))}...`;

/** Scans one line of text. A span claimed by an earlier (more specific) rule is not reported again. */
export function scanLine(text: string): { rule: Rule; match: string }[] {
  const out: { rule: Rule; match: string }[] = [];
  const claimed: [number, number][] = [];
  for (const rule of SECRET_RULES) {
    const m = rule.re.exec(text);
    if (!m) continue;
    const match = rule.group ? m[rule.group] ?? "" : m[0];
    if (!match) continue;
    const at = m.index + (rule.group ? m[0].indexOf(match) : 0);
    if (claimed.some(([a, b]) => at < b && at + match.length > a)) continue;
    if (rule.minEntropy !== undefined && (entropy(match) < rule.minEntropy || PLACEHOLDER.test(match))) continue;
    if (rule.id === "aws-access-key-id" && /EXAMPLE$/.test(match)) continue; // the documentation sample key
    claimed.push([at, at + match.length]);
    out.push({ rule, match });
  }
  return out;
}

/** Scans a unified diff (added lines only). */
export function scanDiff(diff: string): SecretFinding[] {
  const found: SecretFinding[] = [];
  let file = "";
  let line = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+++ ")) { file = l.slice(4).replace(/^b\//, "").trim(); if (file === "/dev/null") file = ""; continue; }
    if (l.startsWith("--- ") || l.startsWith("diff ") || l.startsWith("index ")) continue;
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) { line = Number(h[1]); continue; }
    if (l.startsWith("+")) {
      for (const f of scanLine(l.slice(1))) {
        found.push({ rule: f.rule.id, description: f.rule.description, file, line, preview: preview(f.match), fingerprint: fingerprintOf(f.rule.id, f.match) });
      }
      line++;
    } else if (!l.startsWith("-") && !l.startsWith("\\")) line++;
  }
  return found;
}

/** Scans whole-file content (untracked files a commit command is about to add). */
export function scanFileText(file: string, text: string): SecretFinding[] {
  const found: SecretFinding[] = [];
  text.split("\n").forEach((l, i) => {
    for (const f of scanLine(l)) found.push({ rule: f.rule.id, description: f.rule.description, file, line: i + 1, preview: preview(f.match), fingerprint: fingerprintOf(f.rule.id, f.match) });
  });
  return found;
}

export interface CommitIntent {
  /** The command runs `git commit` in some segment. */
  commit: boolean;
  /** `-a` / `--all`: tracked changes are staged by the commit itself. */
  all: boolean;
  /** An earlier segment stages files (`git add`, `git rm`, `git mv`, `git stash pop`, `git apply --index`): the index is not final yet. */
  stages: boolean;
}

/** Finds `git commit` in a shell command, through `;` `&&` `||` `|` and newlines, `-C <dir>` / `-c k=v` options and sudo-like prefixes. */
export function commitIntent(command: string): CommitIntent {
  const res: CommitIntent = { commit: false, all: false, stages: false };
  for (const raw of splitSegments(command).segments) {
    const w = words(unwrap(raw));
    if (!w) continue;
    let g = 0;
    while (g < w.length && (/^(?:sudo|doas|env|command|exec|nohup|time)$/.test(w[g]!) || /^[A-Za-z_]\w*=/.test(w[g]!) || (g > 0 && w[g]!.startsWith("-")))) g++;
    if (g >= w.length || !(w[g] === "git" || w[g]!.endsWith("/git"))) continue;
    let i = g + 1;
    while (i < w.length && w[i]!.startsWith("-")) i += ["-C", "-c", "--git-dir", "--work-tree"].includes(w[i]!) ? 2 : 1;
    const sub = w[i];
    if (sub === "commit") {
      res.commit = true;
      for (const a of w.slice(i + 1)) {
        if (a === "--all" || (/^-[a-zA-Z]+$/.test(a) && a.slice(1).includes("a"))) res.all = true;
      }
    } else if (sub && !res.commit && ["add", "rm", "mv", "apply", "stash", "checkout", "restore", "merge", "cherry-pick"].includes(sub)) {
      res.stages = true;
    }
  }
  return res;
}

const git = (cwd: string, args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 20_000 });
const MAX_FILE = 256 * 1024;

/** The changes `git commit` would record, scanned. `intent.all` and `intent.stages` widen it to the working tree. */
export function scanForCommit(cwd: string, intent: CommitIntent): SecretFinding[] {
  const inside = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.status !== 0) return [];
  const wide = intent.all || intent.stages;
  const hasHead = git(cwd, ["rev-parse", "--verify", "-q", "HEAD"]).status === 0;
  const found = scanDiff(git(cwd, wide && hasHead ? ["diff", "HEAD", "--no-color", "-U0"] : ["diff", "--cached", "--no-color", "-U0"]).stdout ?? "");
  if (intent.stages) {
    const top = git(cwd, ["rev-parse", "--show-toplevel"]).stdout.trim() || cwd;
    for (const f of (git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]).stdout ?? "").split("\0").filter(Boolean)) {
      const abs = path.join(top, f);
      try {
        if (!statSync(abs).isFile() || statSync(abs).size > MAX_FILE) continue;
        const buf = readFileSync(abs);
        if (buf.includes(0)) continue; // binary
        found.push(...scanFileText(f, buf.toString("utf8")));
      } catch { /* unreadable: skip */ }
    }
  }
  return found;
}

// ---- reported false positives (local log) ----

export function falsePositiveLog(): string {
  return path.join(rigwellHome(), "logs", "secret-scan-false-positives.jsonl");
}

export function reportedFingerprints(): Set<string> {
  const out = new Set<string>();
  const f = falsePositiveLog();
  if (!existsSync(f)) return out;
  try {
    for (const l of readFileSync(f, "utf8").split("\n")) {
      if (!l.trim()) continue;
      try { const j = JSON.parse(l); if (typeof j.fingerprint === "string") out.add(j.fingerprint); } catch { /* skip a bad line */ }
    }
  } catch { /* unreadable log: nothing reported */ }
  return out;
}

export function reportFalsePositives(sessionId: string, findings: SecretFinding[]): void {
  const f = falsePositiveLog();
  try {
    mkdirSync(path.dirname(f), { recursive: true });
    const at = new Date().toISOString();
    appendFileSync(f, findings.map((x) => JSON.stringify({ at, sessionId, rule: x.rule, file: x.file, line: x.line, preview: x.preview, fingerprint: x.fingerprint })).join("\n") + "\n");
  } catch { /* logging must never fail the commit */ }
}

/** Findings for this command that have not been reported as false positives. Empty when the command is not a commit. */
export function secretFindingsFor(command: string, cwd: string): SecretFinding[] {
  const intent = commitIntent(command);
  if (!intent.commit) return [];
  const reported = reportedFingerprints();
  return scanForCommit(cwd, intent).filter((x) => !reported.has(x.fingerprint));
}
