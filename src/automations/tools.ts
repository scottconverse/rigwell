// Agent tools for automations and session loops (spec 16.7): CreateAutomation, ListAutomations, ReadAutomation,
// EditAutomation, DeleteAutomation, RunAutomation and Loop. The daemon registers them on every session through the
// `extraTools` connection option. Mutating tools always ask for approval (see src/permissions/gate.ts), so an unattended
// automation run, which cannot prompt, can never create or change automations.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Tool, ToolOutput } from "../core/types.ts";
import { rigwellHome } from "../storage/paths.ts";
import { loopIntervalToCron, type CronRecord } from "./crons.ts";
import { hasProjectAutomations } from "./projects.ts";
import type { createAutomationService } from "./index.ts";

type Service = ReturnType<typeof createAutomationService>;
const ok = (v: unknown): ToolOutput => ({ content: typeof v === "string" ? v : JSON.stringify(v, null, 2) });
const fail = (m: string): ToolOutput => ({ content: m, isError: true });
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

const FIELDS = {
  name: { type: "string", description: "Short name; the folder name is derived from it." },
  schedule: {
    type: "string",
    description:
      'When to run: hourly, daily, weekly, monthly, a 5-field cron, "every 30m" / "every 2h" / "every 1d", or a phrase such as ' +
      '"every weekday at 9am", "daily at 18:30", "every monday". Phrases are turned into cron once, when saved.',
  },
  instructions: { type: "string", description: "The prompt each run starts with. Write it so it works with no one watching." },
  description: { type: "string" },
  model: { type: "string", description: "Model id for the runs. Leave out for the default." },
  reasoningEffort: { type: "string" },
  workingDirectory: { type: "string", description: "Folder the runs work in. Defaults to the automation's own folder." },
  timezone: { type: "string", description: "IANA zone the schedule is read in. Defaults to the machine zone." },
  autonomy: { type: "string", enum: ["off", "low", "medium", "high"], description: "Autonomy for runs (default high). Anything needing approval is denied." },
  trigger: { type: "string", enum: ["schedule", "webhook"] },
} as const;

const FM_KEYS = ["name", "schedule", "description", "model", "reasoningEffort", "workingDirectory", "timezone", "autonomy", "trigger"] as const;

function pick(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of FM_KEYS) if (input[k] !== undefined) out[k] = input[k];
  return out;
}

/** Reads `loop.md` from the project folder (.rigwell/loop.md), then from the Rigwell home. */
function defaultLoopPrompt(cwd: string): string | undefined {
  for (const f of [join(cwd, ".rigwell", "loop.md"), join(rigwellHome(), "loop.md")]) {
    try { if (existsSync(f)) { const t = readFileSync(f, "utf8").trim(); if (t) return t; } } catch { /* next */ }
  }
  return undefined;
}

export function automationTools(svc: Service): Tool[] {
  const m = svc.manager;
  const guard = (f: () => ToolOutput | Promise<ToolOutput>) => async () => {
    try { return await f(); } catch (e) { return fail((e as Error).message); }
  };
  /** Remember the session's project when it has automations of its own. */
  const learn = (cwd: string) => { if (hasProjectAutomations(cwd)) m.addProject(cwd); };

  const create: Tool = {
    name: "CreateAutomation",
    category: "other",
    description:
      "Save a prompt as an automation: a folder the daemon runs on a schedule in its own unattended session. Creating one does not start a run. " +
      "Automations only run while the Rigwell daemon is running. Use scope \"project\" to keep it in this project's .rigwell/automations folder " +
      "(default is the user's home folder). Returns the saved automation with its next run time.",
    inputSchema: { type: "object", properties: { ...FIELDS, scope: { type: "string", enum: ["user", "project"] } }, required: ["name", "schedule", "instructions"] },
    async run(input, ctx) {
      return await guard(() => {
        const instructions = str(input.instructions);
        if (!instructions) return fail("instructions is required");
        const projectDir = input.scope === "project" ? ctx.cwd : undefined;
        const a = m.create(pick(input) as never, instructions, projectDir);
        return ok(svc.view(a));
      })();
    },
  };

  const list: Tool = {
    name: "ListAutomations",
    category: "read",
    description: "List the automations the daemon knows about (user and project), with schedule, status, last run and next run.",
    inputSchema: { type: "object", properties: { includePaused: { type: "boolean", description: "Include paused automations (default true)." } } },
    async run(input, ctx) {
      return await guard(() => {
        learn(ctx.cwd);
        const all = m.list().map(svc.view).map((v) => ({
          id: v.id, name: v.name, schedule: v.schedule, status: v.status, source: v.source, nextRunAt: v.nextRunAt,
          lastRunAt: v.lastRunAt, lastRunStatus: v.lastRunStatus, ...(v.pausedReason ? { pausedReason: v.pausedReason } : {}),
          ...(v.isValid ? {} : { invalidReason: v.invalidReason, error: v.error }),
        }));
        return ok({ automations: input.includePaused === false ? all.filter((a) => a.status !== "paused") : all });
      })();
    },
  };

  const read: Tool = {
    name: "ReadAutomation",
    category: "read",
    description: "Show one automation in full: settings, its instructions, and its most recent runs.",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "Automation id or folder name." } }, required: ["id"] },
    async run(input, ctx) {
      return await guard(() => {
        learn(ctx.cwd);
        const id = str(input.id);
        if (!id) return fail("id is required");
        const a = m.find(id);
        return ok({ ...svc.view(a), recentRuns: m.history(a.id).slice(0, 5).map((r) => ({ runId: r.runId, status: r.status, trigger: r.trigger, startedAt: r.startedAt, failureReason: r.failureReason, errorMessage: r.errorMessage, sessionId: r.sessionId, mcpUnavailable: r.mcpUnavailable })) });
      })();
    },
  };

  const edit: Tool = {
    name: "EditAutomation",
    category: "other",
    description:
      "Change an automation. Send only the fields to change. `paused: true|false` pauses or resumes it (resuming also clears an automatic pause). " +
      "A schedule phrase is converted to cron when saved.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, ...FIELDS, paused: { type: "boolean" } },
      required: ["id"],
    },
    async run(input, ctx) {
      return await guard(() => {
        learn(ctx.cwd);
        const id = str(input.id);
        if (!id) return fail("id is required");
        const patch = pick(input);
        if (typeof input.paused === "boolean") patch.paused = input.paused;
        const a = m.update(id, patch as never, typeof input.instructions === "string" ? input.instructions : undefined);
        return ok(svc.view(a));
      })();
    },
  };

  const del: Tool = {
    name: "DeleteAutomation",
    category: "other",
    description: "Delete an automation and its folder (notes, reports and run history included). This cannot be undone.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    async run(input, ctx) {
      return await guard(() => {
        learn(ctx.cwd);
        const id = str(input.id);
        if (!id) return fail("id is required");
        const a = m.find(id);
        m.delete(a.id);
        return ok(`Deleted automation "${a.fm.name}".`);
      })();
    },
  };

  const run: Tool = {
    name: "RunAutomation",
    category: "other",
    description: "Start an automation now, in its own unattended session. Returns the run id at once; the run finishes in the background.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    async run(input, ctx) {
      return await guard(() => {
        learn(ctx.cwd);
        const id = str(input.id);
        if (!id) return fail("id is required");
        const { runId, done } = m.run(id);
        done.catch(() => {});
        return ok({ runId, note: "Started. Use ReadAutomation to see how the run ended." });
      })();
    },
  };

  const loop: Tool = {
    name: "Loop",
    category: "other",
    description:
      "Repeat a prompt in this session on an interval. action \"start\" needs `interval` (30m, 2h; minutes 1,2,3,4,5,6,10,12,15,20,30 or hours 1,2,3,4,6,8,12,24) " +
      "and optionally `prompt` (without one, loop.md from the project, then the Rigwell home, is used). The prompt is added to this session only while it is open " +
      "and idle; a tick is skipped when the previous prompt is still waiting. action \"list\" shows this session's loops; \"stop\" ends one (`id`) or all (`id: \"all\"`).",
    inputSchema: {
      type: "object",
      properties: { action: { type: "string", enum: ["start", "list", "stop"] }, interval: { type: "string" }, prompt: { type: "string" }, id: { type: "string" } },
      required: ["action"],
    },
    async run(input, ctx) {
      return await guard(() => {
        const mine = () => svc.crons.list({ sessionId: ctx.sessionId }).filter((c) => c.source === "loop_command");
        switch (input.action) {
          case "start": {
            const interval = str(input.interval);
            if (!interval) return fail("interval is required, for example 30m or 2h");
            const prompt = str(input.prompt) ?? defaultLoopPrompt(ctx.cwd);
            if (!prompt) return fail("No prompt given and no loop.md found in the project or the Rigwell home.");
            const expression = loopIntervalToCron(interval, new Date(svc.clock.now()));
            const c = svc.emitCron(svc.crons.create({ sessionId: ctx.sessionId, prompt, expression, source: "loop_command", recurring: true }));
            return ok({ id: c.id, expression: c.schedule.expression, nextRunAt: c.schedule.nextRunAt, note: "Loops fire only while the Rigwell daemon runs and this session is open." });
          }
          case "list": return ok({ loops: mine().map((c: CronRecord) => ({ id: c.id, status: c.status, expression: c.schedule.expression, nextRunAt: c.schedule.nextRunAt, fireCount: c.stats.fireCount, prompt: c.prompt.slice(0, 200) })) });
          case "stop": {
            const id = str(input.id);
            if (!id) return fail("id is required (a loop id, or \"all\")");
            const targets = id === "all" ? mine() : mine().filter((c) => c.id === id);
            if (!targets.length) return fail(id === "all" ? "No loops in this session." : `No loop ${id} in this session.`);
            for (const c of targets) svc.emitCron(svc.crons.delete(c.id));
            return ok(`Stopped ${targets.length} loop${targets.length === 1 ? "" : "s"}.`);
          }
          default: return fail("action must be start, list or stop");
        }
      })();
    },
  };

  return [create, list, read, edit, del, run, loop];
}
