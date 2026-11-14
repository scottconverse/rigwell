import { createHmac, timingSafeEqual } from "node:crypto";
import { configuredSecretValues, redactSharedText } from "../../sharing/redact.ts";
import { secretValue } from "../../secrets/store.ts";
import type { AutomationManager } from "../manager.ts";
import { readRuns, readSecrets, type Automation, type RunRecord } from "../store.ts";
import { externalKind, type ChainedTrigger, type GithubTrigger, type SlackTrigger } from "./config.ts";
import type { TriggerEvent } from "./events.ts";
import { GithubTriggers, type GithubDeps } from "./github.ts";
import { withLedger } from "./ledger.ts";
import { SlackHub, slackEvent, type SlackDeps, type SlackHandle } from "./slack.ts";

export interface TriggerDeps { github?: GithubDeps; slack?: SlackDeps; slackHub?: SlackHub }
export class AutomationTriggers {
  private github: GithubTriggers;
  private slack = new Map<string, SlackHandle>();
  private slackHub: SlackHub;
  private timer?: ReturnType<typeof setInterval>; private stopped = false; private busy = false;
  private abort = new AbortController();
  constructor(private manager: AutomationManager, private deps: TriggerDeps = {}, private log?: (message: string) => void) { this.github = new GithubTriggers(deps.github); this.slackHub = deps.slackHub ?? new SlackHub(deps.slack); }
  start() { this.stopped = false; this.timer = setInterval(() => void this.tick(), 1000); this.timer.unref?.(); void this.tick(); }
  stop() { this.stopped = true; clearInterval(this.timer); this.abort.abort(); for (const socket of this.slack.values()) socket.stop(); this.slack.clear(); }
  private error(a: Automation, error: unknown) { const message = redactSharedText((error as Error).message ?? "Trigger delivery failed", configuredSecretValues(a.fm.workingDirectory ?? a.dir)); withLedger(a, (l) => l.meta("error", message)); this.log?.(`[triggers] ${a.id}: ${message}`); }
  status(a: Automation) { return externalKind(a.fm.trigger) ? withLedger(a, (l) => l.status()) : undefined; }
  enqueue(a: Automation, event: TriggerEvent) {
    if (this.stopped || !a.isValid || a.fm.paused || event.at < a.state.createdAt) return "ignored";
    if (typeof event.id !== "string" || !event.id || event.id.length > 1024 || Buffer.byteLength(JSON.stringify(event)) > this.manager.limits.maxBodyBytes) throw new Error("Invalid or oversized trigger event");
    return withLedger(a, (l) => l.put(event));
  }
  completed(a: Automation, run: RunRecord, text: string, event?: TriggerEvent) {
    // A retry is one logical automation outcome. Failure chains/replies wait for the final attempt.
    if (run.status === "failure" && run.attempt < 2) return;
    if (event) withLedger(a, (l) => l.set(event.id, a.fm.postResult && event.reply ? "reply_pending" : "finished", { runId: run.runId, result: text }));
    const chain = [...(event?.chain ?? []), a.id];
    for (const target of this.manager.list()) {
      if (!target.isValid || target.fm.paused || target.fm.trigger !== "chained") continue;
      const c = target.fm.eventTrigger as ChainedTrigger;
      if (!c.automationIds.includes(a.id) || (c.status !== "any" && c.status !== run.status) || chain.includes(target.id) || chain.length >= 16) continue;
      this.enqueue(target, { id: `chain:${a.id}:${run.runId}`, kind: "automation_completed", at: run.finishedAt!, chain, payload: { automationId: a.id, automationName: a.fm.name, runId: run.runId, status: run.status, sessionId: run.sessionId, result: redactSharedText(text, configuredSecretValues(a.fm.workingDirectory ?? a.dir)) } });
    }
  }
  async tick() {
    if (this.stopped || this.busy) return; this.busy = true;
    try {
      const all = this.manager.list().filter((a) => a.isValid && externalKind(a.fm.trigger));
      this.syncSlack(all);
      for (const a of all) {
        if (this.stopped) break;
        try {
          if (!a.fm.paused && (a.fm.trigger === "github" || a.fm.trigger === "ci")) {
            const c = a.fm.eventTrigger as GithubTrigger, now = this.manager.clock.now(), last = withLedger(a, (l) => Number(l.meta("lastPollAt") ?? 0));
            if (c.transport !== "webhook" && now - last >= (c.pollMinutes ?? 2) * 60_000) {
              const events = await this.github.poll(c, Math.max(a.state.createdAt, last - 5 * 60_000), this.abort.signal);
              if (this.stopped) break;
              for (const event of events) this.enqueue(this.manager.find(a.id), event);
              withLedger(a, (l) => { l.meta("lastPollAt", String(now)); l.meta("error", ""); });
            }
          }
          if (!a.fm.paused) this.dispatch(a);
          await this.replies(a);
        } catch (e) { if (!this.stopped) this.error(a, e); }
      }
    } catch (e) { if (!this.stopped) this.log?.(`[triggers] pass failed: ${(e as Error).message}`); }
    finally { this.busy = false; }
  }
  private dispatch(a: Automation) {
    const runs = readRuns(a);
    for (const row of withLedger(a, (l) => l.entries("running", 1000))) {
      const run = runs.filter((r) => r.eventId === row.id).at(-1);
      if (run && run.status !== "in_progress" && a.state.retry?.event?.id !== row.id) withLedger(a, (l) => l.set(row.id, "finished", { runId: run.runId, error: "Recovered completed dispatch; any unrecorded reply was not replayed" }));
    }
    const rows = withLedger(a, (l) => l.entries("queued", this.manager.limits.maxPerTick));
    for (const row of rows) {
      const previous = runs.filter((run) => run.eventId === row.id).at(-1);
      if (previous) { withLedger(a, (l) => { l.set(row.id, previous.status === "in_progress" || a.state.retry?.event?.id === row.id ? "running" : "finished", { runId: previous.runId }); l.started(row.id, previous.startedAt); }); continue; }
      if (a.fm.maxRunsPerHour !== undefined && withLedger(a, (l) => l.recentCount(this.manager.clock.now())) >= a.fm.maxRunsPerHour) break;
      const event: TriggerEvent = JSON.parse(row.event), result = this.manager.dispatchEvent(a.id, event);
      if (!result) break;
      withLedger(a, (l) => { l.set(row.id, "filtered" in result ? "filtered" : "running", "runId" in result ? { runId: result.runId } : {}); if ("runId" in result) l.started(row.id, this.manager.clock.now()); });
    }
  }
  private socketKey(c: SlackTrigger) { return JSON.stringify([c.appTokenCredential, c.botTokenCredential]); }
  private syncSlack(all: Automation[]) {
    const wanted = new Map<string, SlackTrigger>();
    for (const a of all) if (a.fm.trigger === "slack" && !a.fm.paused) { const c = a.fm.eventTrigger as SlackTrigger; wanted.set(this.socketKey(c), c); }
    for (const [key, socket] of this.slack) if (!wanted.has(key)) { socket.stop(); this.slack.delete(key); }
    for (const [key, config] of wanted) if (!this.slack.has(key)) {
      const socket = this.slackHub.acquire(config, (payload) => {
        for (const a of this.manager.list()) if (a.fm.trigger === "slack" && a.isValid && !a.fm.paused && this.socketKey(a.fm.eventTrigger as SlackTrigger) === key) {
          const event = slackEvent(a.fm.eventTrigger as SlackTrigger, payload); if (event) this.enqueue(a, event);
        }
      }, (message) => { for (const a of this.manager.list()) if (a.fm.trigger === "slack" && this.socketKey(a.fm.eventTrigger as SlackTrigger) === key) this.error(a, new Error(message)); });
      this.slack.set(key, socket);
    }
  }
  private async replies(a: Automation) {
    if (a.fm.paused) return;
    const rows = withLedger(a, (l) => l.entries("reply_pending", 2));
    for (const row of rows) {
      if (!a.fm.postResult) { withLedger(a, (l) => l.set(row.id, "finished")); continue; }
      const event: TriggerEvent = JSON.parse(row.event), config = a.fm.eventTrigger;
      const credentialNames = a.fm.trigger === "slack" ? [(config as SlackTrigger).appTokenCredential, (config as SlackTrigger).botTokenCredential] : [(config as GithubTrigger).tokenCredential];
      const secretValues = [...configuredSecretValues(a.fm.workingDirectory ?? a.dir), ...credentialNames.filter((s): s is string => !!s).map((s) => (this.deps.slack?.credential ?? secretValue)(s)).filter((s): s is string => !!s)];
      const text = redactSharedText(`[Automation: ${a.fm.name}]\n${row.result ?? "Run finished without text."}`, secretValues).slice(0, event.reply?.service === "slack" ? 3900 : 60_000);
      // Claim before network I/O. An uncertain delivery is visible, never automatically posted twice.
      withLedger(a, (l) => l.set(row.id, "reply_unknown"));
      try {
        if (event.reply?.service === "github" && ["github", "ci"].includes(a.fm.trigger!)) await this.github.reply(config as GithubTrigger, event, text, this.abort.signal);
        else if (event.reply?.service === "slack" && a.fm.trigger === "slack") { const socket = this.slack.get(this.socketKey(config as SlackTrigger)); if (!socket) throw new Error("Slack connection unavailable for reply"); await socket.reply(event, text); }
        else throw new Error("Trigger configuration no longer matches the reply destination");
        withLedger(a, (l) => l.set(row.id, "posted"));
      } catch (e) { withLedger(a, (l) => l.set(row.id, "reply_unknown", { error: redactSharedText((e as Error).message, secretValues) })); }
    }
  }
  webhook(a: Automation, raw: string, headers: { signature?: string | null; event?: string | null; delivery?: string | null }) {
    if (!["github", "ci"].includes(a.fm.trigger!) || (a.fm.eventTrigger as GithubTrigger).transport !== "webhook") return { httpStatus: 404, body: { error: "not found" } };
    const secret = readSecrets(a).webhookSecret, signature = /^sha256=([a-f0-9]{64})$/i.exec(headers.signature ?? "")?.[1];
    if (!secret || !signature || !timingSafeEqual(Buffer.from(signature, "hex"), createHmac("sha256", secret).update(raw).digest())) return { httpStatus: 401, body: { error: "unauthorized" } };
    if (a.fm.paused) return { httpStatus: 409, body: { error: "automation is paused" } };
    try {
      const events = this.github.webhook(a.fm.eventTrigger as GithubTrigger, headers.event ?? "", JSON.parse(raw));
      if (typeof headers.delivery !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(headers.delivery)) return { httpStatus: 400, body: { error: "GitHub delivery ID required" } };
      for (const event of events) this.enqueue(a, { ...event, id: `github:delivery:${headers.delivery}` });
      return { httpStatus: 202, body: { status: events.length ? "accepted" : "filtered" } };
    } catch { return { httpStatus: 400, body: { error: "Invalid event or queue unavailable" } }; }
  }
}
