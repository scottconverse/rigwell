// Automation service: manager + webhook server + session crons, and the protocol methods that expose them.
// Methods (prefix rigwell.): list_automations, create_automation, update_automation, rename_automation, delete_automation,
// pause_automation, resume_automation, run_automation, get_automation_history, rotate_automation_secret,
// list_crons, create_cron, update_cron, delete_cron, register_automation_project, list_automation_templates,
// get_automation_visual (and start_automation_setup, answered by the connection; see setup.ts). Notifications (rigwell. prefix):
// cron.state_changed {cron} and automation.auto_paused {id, name, reason}.
// Agent tools (CreateAutomation, ListAutomations, ReadAutomation, EditAutomation, DeleteAutomation, RunAutomation, Loop)
// come from automationTools(service) in tools.ts; the daemon passes them to every session through extraTools.
import { ErrorCodes, RpcError } from "../protocol/rpc.ts";
import { AutomationManager, type Clock, type Limits } from "./manager.ts";
import { createHeadlessRunner, type HeadlessRunner } from "./runner.ts";
import { startWebhookServer, type WebhookServer } from "./webhook.ts";
import { CronRunner, CronStore, loopIntervalToCron, type CronHost, type CronRecord, type CronStatus } from "./crons.ts";
import { readSecrets, type Automation, type Frontmatter } from "./store.ts";
import { instantiateTemplate, listTemplates, TemplateError } from "./templates.ts";

export { automationTools } from "./tools.ts";
export { AUTOMATION_TEMPLATES, instantiateTemplate, listTemplates } from "./templates.ts";
export { AUTOMATION_SETUP_OVERLAY, automationSetupParams } from "./setup.ts";
export { renderVisual } from "./visual.ts";
export { AutomationManager, CronRunner, CronStore, createHeadlessRunner, startWebhookServer };

export interface ServiceOptions {
  clock?: Clock;
  runner?: HeadlessRunner;
  limits?: Partial<Limits>;
  projectDirs?: string[];
  webhookPort?: number;
  webhookHost?: string;
  cronHost?: CronHost;
  /** A cron changed (created, edited, cancelled, fired, expired): the daemon sends `cron.state_changed`. */
  onCronChanged?: (c: CronRecord) => void;
  /** An automation paused itself after repeated failures or 10 days of missed runs. */
  onAutoPaused?: (a: { id: string; name: string; reason: "missed_runs" | "consecutive_failures" }) => void;
  retryBaseDelayMs?: number;
  log?: (m: string) => void;
}

type Params = Record<string, unknown>;
const bad = (m: string) => new RpcError(ErrorCodes.INVALID_PARAMS, m);
const notFound = (e: unknown) => new RpcError(ErrorCodes.ENTITY_NOT_FOUND, (e as Error).message);
const str = (p: Params, k: string) => (typeof p[k] === "string" && p[k] ? (p[k] as string) : undefined);
const need = (p: Params, k: string) => str(p, k) ?? (() => { throw bad(`${k} is required`); })();

const FM_KEYS = ["name", "schedule", "description", "model", "reasoningEffort", "workingDirectory", "paused", "tags", "targetSessionId", "trigger", "timezone", "autonomy", "payloadRegex", "maxRunsPerHour"] as const;

export function createAutomationService(opts: ServiceOptions = {}) {
  const runner = opts.runner ?? createHeadlessRunner({ log: opts.log, retryBaseDelayMs: opts.retryBaseDelayMs });
  const mgr = new AutomationManager({ runner, clock: opts.clock, limits: opts.limits, projectDirs: opts.projectDirs, log: opts.log,
    onAutoPaused: (a, reason) => opts.onAutoPaused?.({ id: a.id, name: a.fm.name, reason }) });
  const emitCron = (c: CronRecord) => { try { opts.onCronChanged?.(c); } catch { /* a listener never breaks the store */ } return c; };
  const crons = new CronStore(opts.clock);
  const cronRunner = opts.cronHost ? new CronRunner(crons, opts.cronHost, opts.clock, (c) => emitCron(c)) : undefined;
  let webhook: WebhookServer | undefined;

  /** The listener runs only while at least one automation has trigger: webhook. */
  const syncWebhook = () => {
    const want = mgr.hasWebhooks();
    if (want && !webhook) {
      try {
        webhook = startWebhookServer(mgr, { port: opts.webhookPort, host: opts.webhookHost });
        opts.log?.(`[automations] webhook listening on ${webhook.host}:${webhook.port}`);
      } catch (e) { opts.log?.(`[automations] webhook server failed to start: ${(e as Error).message}`); }
    } else if (!want && webhook) { webhook.stop(); webhook = undefined; }
  };
  mgr.onChange = syncWebhook;

  const view = (a: Automation) => ({
    id: a.id, folder: a.folder, name: a.fm.name, description: a.fm.description, isValid: a.isValid,
    invalidReason: a.invalidReason, error: a.error, source: a.source,
    schedule: a.fm.schedule, timezone: a.timezone, trigger: a.fm.trigger ?? "schedule", paused: a.fm.paused === true,
    status: !a.isValid ? "invalid" : a.fm.paused ? "paused" : a.state.health === "degraded" ? "degraded" : "active",
    ...(a.state.pausedReason ? { pausedReason: a.state.pausedReason, pausedAt: a.state.pausedAt } : {}),
    consecutiveFailures: a.state.consecutiveFailures ?? 0,
    nextRunAt: mgr.nextRunAt(a), lastRunAt: a.state.lastRunAt, lastRunId: a.state.lastRunId,
    lastRunSessionId: a.state.lastRunSessionId, lastRunStatus: a.state.lastRunStatus, runCount: a.state.runCount,
    retryAt: a.state.retry?.at, instructions: a.body,
    ...(a.fm.trigger === "webhook" ? { webhookPath: `/hooks/${a.id}`, webhookPort: webhook?.port } : {}),
  });

  const fmFrom = (p: Params): Partial<Frontmatter> => {
    const out: Record<string, unknown> = {};
    for (const k of FM_KEYS) if (p[k] !== undefined) out[k] = p[k];
    return out as Partial<Frontmatter>;
  };
  const guard = <T>(f: () => T): T => {
    try { return f(); } catch (e) {
      if (e instanceof RpcError) throw e;
      if (e instanceof TemplateError) throw bad(e.message);
      throw /not found/i.test((e as Error).message) ? notFound(e) : bad((e as Error).message);
    }
  };

  const methods: Record<string, (p: Params) => unknown> = {
    list_automations: () => ({ automations: mgr.list().map(view) }),
    create_automation: (p) => guard(() => {
      let fm = fmFrom(p) as Frontmatter;
      let instructions = str(p, "instructions") ?? "";
      if (str(p, "templateId")) { // fields the caller sends win over the template's
        const t = instantiateTemplate(str(p, "templateId")!, (p.parameters ?? {}) as Params);
        fm = { name: t.name, description: t.description, schedule: t.schedule, autonomy: t.autonomy, tags: t.tags, ...(fm as Partial<Frontmatter>) } as Frontmatter;
        instructions ||= t.instructions;
      }
      const a = mgr.create(fm, instructions, str(p, "projectDir"));
      const secret = fm.trigger === "webhook" ? readSecrets(a).webhookSecret : undefined;
      return { automation: view(a), ...(secret ? { webhookSecret: secret } : {}) };
    }),
    list_automation_templates: () => ({ templates: listTemplates() }),
    get_automation_visual: (p) => guard(() => mgr.visual(need(p, "id"))),
    update_automation: (p) => guard(() => ({ automation: view(mgr.update(need(p, "id"), fmFrom(p), typeof p.instructions === "string" ? p.instructions : undefined)) })),
    rename_automation: (p) => guard(() => ({ automation: view(mgr.update(need(p, "id"), { name: need(p, "name") })) })),
    pause_automation: (p) => guard(() => ({ automation: view(mgr.update(need(p, "id"), { paused: true })) })),
    resume_automation: (p) => guard(() => ({ automation: view(mgr.update(need(p, "id"), { paused: false })) })),
    delete_automation: (p) => guard(() => { mgr.delete(need(p, "id")); return {}; }),
    run_automation: (p) => guard(() => {
      const { runId, done } = mgr.run(need(p, "id"));
      done.catch(() => {});
      return { runId };
    }),
    get_automation_history: (p) => guard(() => ({ runs: mgr.history(need(p, "id")), deliveries: mgr.deliveries(need(p, "id")) })),
    rotate_automation_secret: (p) => guard(() => ({ webhookSecret: mgr.rotateSecret(need(p, "id")) })),

    list_crons: (p) => ({ crons: crons.list({ sessionId: str(p, "sessionId"), scope: str(p, "scope"), includeInactive: p.includeInactive === true }) }),
    create_cron: (p) => guard(() => {
      let expression = str(p, "expression");
      if (!expression && str(p, "interval")) expression = loopIntervalToCron(need(p, "interval"), new Date((opts.clock ?? { now: Date.now }).now()));
      if (!expression) throw bad("expression or interval is required");
      return { cron: emitCron(crons.create({ sessionId: need(p, "sessionId"), prompt: need(p, "prompt"), expression, recurring: p.recurring !== false, source: p.source === "loop_command" ? "loop_command" : "cron_tool", scope: str(p, "scope") })) };
    }),
    update_cron: (p) => guard(() => ({ cron: emitCron(crons.update(need(p, "id"), { status: str(p, "status") as CronStatus | undefined, prompt: str(p, "prompt"), expression: str(p, "expression") })) })),
    delete_cron: (p) => guard(() => ({ cron: emitCron(crons.delete(need(p, "id"))) })),
    /** Remember a project folder so its .rigwell/automations is scanned (also after a restart). */
    register_automation_project: (p) => guard(() => { mgr.addProject(need(p, "projectDir")); return { projects: [...mgr.projectDirs] }; }),
  };

  return {
    manager: mgr, crons, cronRunner,
    methods, view, emitCron, clock: opts.clock ?? { now: Date.now },
    get webhookPort() { return webhook?.port; },
    start() { mgr.start(); cronRunner?.start(); syncWebhook(); },
    stop() { mgr.stop(); cronRunner?.stop(); webhook?.stop(); webhook = undefined; },
    syncWebhook,
  };
}
