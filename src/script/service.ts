// The Script and script_job tools for one session (spec §5.2, prompts §5.9 / §5.10).
import type { Tool } from "../core/types.ts";
import type { JobManager } from "../jobs/manager.ts";
import { newJobId } from "../jobs/manager.ts";
import { fail, ok, promptDesc, promptSchema } from "../tools/util.ts";
import { parseScript } from "./parse.ts";
import { ResultLog } from "./resultlog.ts";
import { ScriptRun, type ScriptHost } from "./run.ts";
import type { SandboxLimits } from "./sandbox.ts";

export const FOREGROUND_WAIT_MS = 5 * 60 * 1000;
export const JOB_WAIT_MAX_MS = 300_000;

export interface ScriptLimits extends Partial<SandboxLimits> {
  /** How long a Script runs in the foreground before it continues in the background (S6). */
  foregroundMs?: number;
}

/** Tools the Script description documents but this build does not provide. */
const DEFERRED_TOOLS = ["LS", "Skill", "ToolSearch", "load_tools"];

/** The Script description with signatures of unavailable tools left out. */
export function scriptDescription(available: string[], extraBindings = ""): string {
  let d = promptDesc("Script", { SCRIPT_EXTRA_BINDINGS: extraBindings });
  const have = new Set(available);
  d = d.split("\n").filter((l) => {
    const m = /^ {2}tools\.(\w+)\(/.exec(l);
    return !(m && DEFERRED_TOOLS.includes(m[1]!) && !have.has(m[1]!));
  }).join("\n");
  if (!have.has("ToolSearch") && !have.has("load_tools")) {
    d = d.replace(/MORE TOOLS\n[^\n]*\n\n/, "");
  }
  return d.replace(/\n{3,}/g, "\n\n");
}

export class ScriptService {
  readonly resultLog: ResultLog;
  constructor(private o: {
    sessionId: string;
    jobs: JobManager;
    host: ScriptHost;
    /** Names bound as tools.<Name> inside a Script. */
    toolNames: () => string[];
    limits?: ScriptLimits;
  }) {
    this.resultLog = new ResultLog(o.sessionId);
  }

  scriptTool(): Tool {
    return {
      name: "Script",
      description: scriptDescription(this.o.toolNames()),
      inputSchema: promptSchema("Script"),
      category: "execute",
      run: async (input, ctx) => {
        const text = input.script;
        if (typeof text !== "string" || !text.trim()) return fail("script is required: a JavaScript program as one string.");
        const parsed = parseScript(text);
        if ("error" in parsed) return fail(parsed.error);
        const { foregroundMs, ...sandboxLimits } = this.o.limits ?? {};
        const run = new ScriptRun({
          jobId: newJobId("scr"), runId: crypto.randomUUID(), outerId: ctx.toolUseId ?? crypto.randomUUID(),
          sessionId: this.o.sessionId, parsed, toolNames: this.o.toolNames(), host: this.o.host,
          resultLog: this.resultLog, limits: sandboxLimits,
        });
        this.o.jobs.add(run);
        run.start();
        if (parsed.background) {
          this.o.jobs.detach(run.id);
          return ok(JSON.stringify({ status: "running", job_id: run.id, output: "", tool_calls: 0, errors: [], log_ref: run.logRef }));
        }
        const waited = await this.o.jobs.wait(run.id, foregroundMs ?? FOREGROUND_WAIT_MS, ctx.signal);
        if (waited === "timeout") {
          this.o.jobs.detach(run.id);
          return ok(JSON.stringify(run.report()));
        }
        if (waited === "aborted") {
          run.stop();
          await run.done;
        }
        run.reported = true;
        return { content: JSON.stringify(run.report()), isError: run.status !== "completed", ...(run.images.length ? { images: run.images } : {}) };
      },
    };
  }

  jobTool(): Tool {
    return {
      name: "script_job",
      description: promptDesc("script_job"),
      inputSchema: promptSchema("script_job"),
      category: "other",
      run: async (input, ctx) => {
        const id = typeof input.job_id === "string" ? input.job_id : "";
        const action = input.action;
        const job = this.o.jobs.get(id);
        if (!job) {
          const known = this.o.jobs.list().map((j) => j.id).join(", ") || "none";
          return fail(`No job with id "${id}". Known jobs: ${known}.`);
        }
        if (action !== "wait" && action !== "status" && action !== "stop") return fail('action must be "wait", "status" or "stop".');
        if (action === "wait") {
          const t = typeof input.timeoutMs === "number" ? Math.max(1, Math.min(JOB_WAIT_MAX_MS, input.timeoutMs)) : JOB_WAIT_MAX_MS;
          await this.o.jobs.wait(id, t, ctx.signal);
        } else if (action === "stop") {
          job.stop();
          await job.done;
        }
        if (job.status !== "running") job.reported = true;
        const imgs = (job as { images?: { type: "image"; mediaType: string; data: string }[] }).images;
        return { content: JSON.stringify(job.report()), ...(imgs?.length && job.status !== "running" ? { images: imgs } : {}) };
      },
    };
  }
}
