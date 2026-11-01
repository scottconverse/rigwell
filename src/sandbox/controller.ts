// Per-session sandbox controller: status, wrapping an Execute command, violation prompts and "allow always".
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolContext, ToolOutput } from "../core/types.ts";
import { rigwellHome } from "../storage/paths.ts";
import { loadSettings } from "../storage/settings.ts";
import { bwrapCommand, buildSeatbeltProfile, detectEngine, proxyEnv, PROXY_INNER_PORT, type EngineInfo, type EngineProbe } from "./engine.ts";
import {
  buildPolicy, contains, defaultHome, mergeSandboxOrg, protectedPaths, type SandboxMode, type SandboxPolicy, type SandboxSettings, type SessionGrants,
} from "./policy.ts";
import { startProxy, type ProxyHandle } from "./proxy.ts";
import { describeViolation, detectDeniedReads, detectFromStderr, ViolationLog, type SandboxViolation } from "./violations.ts";

/** Session status for SessionSettings.sandbox (spec 3: reported as status only). */
export interface SandboxStatus {
  enabled: boolean;
  mode: SandboxMode;
  /** True when commands really run inside the sandbox (enabled and an engine works). */
  active: boolean;
  available: boolean;
  engine: string;
  reason?: string;
  note?: string;
}

export type AskPermission = (params: Record<string, unknown>) => Promise<{ selectedOption: string }>;

export interface SandboxRun {
  file: string;
  args: string[];
  /** Extra environment for the child. */
  env: Record<string, string>;
  error?: string;
  /** Appends violation notes and runs the violation prompts. */
  finalize(out: ToolOutput, stderr: string): Promise<ToolOutput>;
  cleanup(): Promise<void>;
}

export interface ControllerOptions extends EngineProbe {
  /** Org-managed sandbox settings (merged: stricter wins). */
  org?: SandboxSettings;
  vendorHosts?: string[];
  ask?: AskPermission;
  /** Test hook: settings instead of the settings files. */
  settings?: () => SandboxSettings | undefined;
  home?: string;
}

const MAX_PROMPTS_PER_COMMAND = 5;

export function userSettingsFile(): string {
  return path.join(rigwellHome(), "settings.json");
}

/** Reads, mutates and atomically writes the user settings file (the "allow always" target). */
export function saveUserSandbox(mutate: (s: SandboxSettings) => void): void {
  const file = userSettingsFile();
  let root: Record<string, unknown> = {};
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    if (j && typeof j === "object" && !Array.isArray(j)) root = j as Record<string, unknown>;
  } catch { /* new file */ }
  const sb = (root.sandbox && typeof root.sandbox === "object" ? root.sandbox : {}) as SandboxSettings;
  mutate(sb);
  root.sandbox = sb;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(root, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

const addTo = (arr: string[] | undefined, v: string) => (arr?.includes(v) ? arr : [...(arr ?? []), v]);

export class SandboxController {
  readonly violations = new ViolationLog();
  private grants: SessionGrants = { allowWrite: [], allowRead: [], allowedDomains: [] };
  private declined = new Set<string>();
  ask?: AskPermission;

  constructor(readonly sessionId: string, private o: ControllerOptions = {}) {
    this.ask = o.ask;
  }

  private settingsFor(cwd: string): SandboxSettings | undefined {
    if (this.o.settings) return this.o.settings();
    try {
      return loadSettings({ cwd }).settings.sandbox as SandboxSettings | undefined;
    } catch {
      return undefined;
    }
  }

  engine(): EngineInfo {
    return detectEngine(this.o);
  }

  /** Effective enabled flag and mode after the org merge. */
  private effective(cwd: string): SandboxSettings {
    return mergeSandboxOrg(this.o.org, this.settingsFor(cwd));
  }

  status(cwd: string): SandboxStatus {
    const eff = this.effective(cwd);
    const eng = this.engine();
    const enabled = eff.enabled === true;
    const mode: SandboxMode = eff.mode === "whole-process" ? "whole-process" : "per-command";
    return {
      enabled, mode, active: enabled && eng.available, available: eng.available, engine: eng.engine,
      ...(eng.reason ? { reason: eng.reason } : {}),
      ...(mode === "whole-process" ? { note: "whole-process mode is not built in v1; commands are sandboxed per command" } : {}),
    };
  }

  policy(cwd: string): SandboxPolicy {
    return buildPolicy({
      cwd, home: this.o.home ?? defaultHome(), rigwellHome: rigwellHome(), settings: this.settingsFor(cwd), org: this.o.org,
      session: this.grants, vendorHosts: this.o.vendorHosts, canProxy: this.engine().canProxy,
    });
  }

  /** Wraps one shell command. When the sandbox is off the command runs as before. */
  async prepare(args: { shell: string; command: string; cwd: string; toolUseId?: string; input?: Record<string, unknown> }): Promise<SandboxRun> {
    const plain: SandboxRun = {
      file: args.shell, args: ["-c", args.command], env: {}, finalize: async (o) => o, cleanup: async () => {},
    };
    const st = this.status(args.cwd);
    if (!st.enabled) return plain;
    const eng = this.engine();
    if (!eng.available) {
      // Windows (and other unsupported systems) rely on the permission rules of 5.5.3; elsewhere fail closed.
      if (eng.engine === "none") return plain;
      return { ...plain, error: `The sandbox is enabled but unavailable: ${eng.reason}. Install it or turn the sandbox off in settings.` };
    }
    const policy = this.policy(args.cwd);
    const netViolations: SandboxViolation[] = [];
    let proxy: ProxyHandle | undefined;
    let sockDir: string | undefined;
    const env: Record<string, string> = {};
    let file = args.shell;
    let argv: string[] = ["-c", args.command];
    try {
      if (policy.network.rule === "proxy") {
        const onViolation = (v: { host: string; reason: "deny-list" | "not-allowed" }) =>
          netViolations.push({ type: "network", reason: v.reason, target: v.host, command: args.command, at: Date.now() });
        const common = { allowed: policy.network.allowedDomains, denied: policy.network.deniedDomains, onViolation };
        if (eng.engine === "bubblewrap") {
          sockDir = fs.mkdtempSync(path.join(os.tmpdir(), "rigwell-sbx-"));
          const sock = path.join(sockDir, "proxy.sock");
          proxy = await startProxy({ ...common, listen: { unix: sock } });
          Object.assign(env, proxyEnv(PROXY_INNER_PORT));
          ({ file, args: argv } = bwrapCommand(eng.bin!, { policy, proxySocket: sock, socat: eng.socat }, args.shell, args.command));
        } else {
          proxy = await startProxy({ ...common, listen: { port: policy.network.httpProxyPort ?? 0 } });
          Object.assign(env, proxyEnv(proxy.address as number));
          argv = ["-p", buildSeatbeltProfile(policy, proxy.address as number), args.shell, "-c", args.command];
          file = eng.bin!;
        }
      } else if (eng.engine === "bubblewrap") {
        ({ file, args: argv } = bwrapCommand(eng.bin!, { policy }, args.shell, args.command));
      } else {
        file = eng.bin!;
        argv = ["-p", buildSeatbeltProfile(policy), args.shell, "-c", args.command];
      }
    } catch (e) {
      await proxy?.close();
      if (sockDir) fs.rmSync(sockDir, { recursive: true, force: true });
      return { ...plain, error: `Could not start the sandbox: ${(e as Error).message}` };
    }
    return {
      file, args: argv, env,
      cleanup: async () => {
        await proxy?.close();
        if (sockDir) fs.rmSync(sockDir, { recursive: true, force: true });
      },
      finalize: async (out, stderr) => {
        const found = [
          ...detectFromStderr(stderr, policy, args.cwd, args.command),
          ...detectDeniedReads(args.command, policy, this.o.home ?? defaultHome()),
          ...netViolations,
        ];
        return await this.report(out, found, policy, args);
      },
    };
  }

  private async report(out: ToolOutput, found: SandboxViolation[], policy: SandboxPolicy, args: { cwd: string; toolUseId?: string; input?: Record<string, unknown>; command: string }): Promise<ToolOutput> {
    if (found.length === 0) return out;
    const uniq = new Map<string, SandboxViolation>();
    for (const v of found) {
      this.violations.push(v);
      uniq.set(`${v.type}:${v.target}`, v);
    }
    const notes: string[] = [];
    let prompts = 0;
    for (const v of uniq.values()) {
      const key = `${v.type}:${v.target}`;
      let note = `Sandbox blocked: ${describeViolation(v)}.`;
      const askable = this.ask && !this.declined.has(key) && prompts < MAX_PROMPTS_PER_COMMAND && !this.isHardDeny(v, policy);
      if (askable) {
        prompts++;
        const choice = await this.prompt(v, policy, args);
        if (choice === "cancel") this.declined.add(key);
        note += " " + this.apply(v, choice, args.cwd);
      } else if (this.isHardDeny(v, policy)) {
        note += " This is a protected path and cannot be allowed.";
      }
      notes.push(note);
    }
    return { ...out, content: `${out.content}\n--- sandbox ---\n${notes.join("\n")}`, isError: out.isError ?? true };
  }

  /** Credential files and org-denied paths are never offered "allow". */
  private isHardDeny(v: SandboxViolation, policy: SandboxPolicy): boolean {
    if (v.type === "network") return false;
    void policy;
    return protectedPaths(this.o.home ?? defaultHome(), rigwellHome()).some((p) => contains(p, v.target));
  }

  private async prompt(v: SandboxViolation, policy: SandboxPolicy, args: { toolUseId?: string; input?: Record<string, unknown>; command: string }): Promise<string> {
    const parent = v.type === "network" ? v.target : path.dirname(v.target);
    const verb = v.type === "filesystem-read" ? "reads" : "writes";
    const options: { label: string; value: string }[] = [];
    if (v.type === "network") {
      options.push({ label: `Allow always (${v.target})`, value: "proceed_always" });
    } else {
      options.push({ label: `Allow always (${verb} to ${parent})`, value: "proceed_always" });
      options.push({ label: `Allow always (${verb} to ${v.target})`, value: "proceed_always_file" });
    }
    options.push({ label: "Allow for this session only", value: "proceed_once" });
    if (v.reason === "deny-list") options.push({ label: `Remove ${v.target} from deny list`, value: "remove_from_deny_list" });
    options.push({ label: "No, keep it blocked", value: "cancel" });
    const orgWarn =
      v.type === "network" ? policy.orgRules.deniedDomains.length > 0 && v.reason === "deny-list"
        : (v.type === "filesystem-write" ? policy.orgRules.denyWrite : policy.orgRules.denyRead).some((p) => contains(p, v.target));
    let ans: { selectedOption: string };
    try {
      ans = await this.ask!({
        requestId: crypto.randomUUID(),
        toolUses: [{
          toolUse: { type: "tool_use", id: args.toolUseId ?? "sandbox", name: "Execute", input: args.input ?? { command: args.command } },
          confirmationType: "sandbox_violation",
          details: {
            title: "Sandbox Violation", type: v.type, reason: v.reason, target: v.target, parentDir: parent,
            operation: v.type === "network" ? "network" : verb === "reads" ? "read" : "write", blocked: true, command: args.command,
            ...(orgWarn ? { warning: "An organization rule will still deny this after you allow it." } : {}),
          },
        }],
        options,
      });
    } catch {
      return "cancel";
    }
    return options.some((o) => o.value === ans?.selectedOption) ? ans.selectedOption : "cancel";
  }

  /** Applies the chosen option: grants for the session or saves to the user sandbox settings. */
  private apply(v: SandboxViolation, choice: string, cwd: string): string {
    if (choice === "cancel") return "It stays blocked.";
    const isNet = v.type === "network";
    const isRead = v.type === "filesystem-read";
    const value = isNet ? v.target : choice === "proceed_always_file" ? v.target : path.dirname(v.target);
    if (choice === "proceed_once") {
      if (isNet) this.grants.allowedDomains.push(v.target);
      else (isRead ? this.grants.allowRead : this.grants.allowWrite).push(path.dirname(v.target));
      return `Allowed for this session (${isNet ? v.target : path.dirname(v.target)}). Run the command again.`;
    }
    if (choice === "remove_from_deny_list") {
      saveUserSandbox((s) => {
        if (isNet) s.network = { ...s.network, deniedDomains: (s.network?.deniedDomains ?? []).filter((d) => d !== v.target) };
        else {
          const key = isRead ? "denyRead" : "denyWrite";
          s.filesystem = { ...s.filesystem, [key]: (s.filesystem?.[key] ?? []).filter((p) => p !== v.target) };
        }
      });
      return "Removed from the deny list in your sandbox settings. Run the command again.";
    }
    saveUserSandbox((s) => {
      if (isNet) s.network = { ...s.network, allowedDomains: addTo(s.network?.allowedDomains, v.target) };
      else {
        const key = isRead ? "allowRead" : "allowWrite";
        s.filesystem = { ...s.filesystem, [key]: addTo(s.filesystem?.[key], value) };
      }
    });
    void cwd;
    return `Allowed always (saved ${value} to your sandbox settings). Run the command again.`;
  }
}

// ---- registry: one controller per session id ----

const controllers = new Map<string, SandboxController>();

export function sandboxFor(sessionId: string, o?: ControllerOptions): SandboxController {
  let c = controllers.get(sessionId);
  if (!c) {
    c = new SandboxController(sessionId, o);
    controllers.set(sessionId, c);
  }
  return c;
}

/** The session calls this once to let the sandbox raise sandbox_violation prompts through its permission path. */
export function attachSandbox(sessionId: string, ask: AskPermission | undefined, o?: ControllerOptions): SandboxController {
  const c = sandboxFor(sessionId, o);
  c.ask = ask;
  return c;
}

export function detachSandbox(sessionId: string): void {
  controllers.delete(sessionId);
}

/** For the session to report `sandbox {enabled, mode}` in SessionSettings and the environment block. */
export function sandboxStatus(sessionId: string, cwd: string): SandboxStatus {
  return sandboxFor(sessionId).status(cwd);
}

/** "SANDBOX" marker text for the status bar: set when commands really run sandboxed. */
export function sandboxStatusLabel(st: SandboxStatus): string {
  if (!st.enabled) return "off";
  if (!st.available) return `on but unavailable (${st.reason ?? "no engine"})`;
  return `on (${st.engine}, ${st.mode === "whole-process" ? "per-command; whole-process not built" : "per-command"})`;
}

/** The hook Execute calls. */
export function prepareSandbox(ctx: Pick<ToolContext, "sessionId" | "toolUseId">, args: { shell: string; command: string; cwd: string; input?: Record<string, unknown> }): Promise<SandboxRun> {
  return sandboxFor(ctx.sessionId).prepare({ ...args, toolUseId: ctx.toolUseId });
}
