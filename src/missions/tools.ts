// Mission tools (spec §15.5). Orchestrators get ProposeMission, StartMissionRun and DismissHandoffItems;
// workers get only EndFeatureRun.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import type { Tool, ToolOutput } from "../core/types.ts";
import { MissionStore, hasUndoneWork, checkHandoff, needsAttention, type Handoff, type HandoffRecord } from "./store.ts";
import type { MissionRunner, MissionSettings, RunInput } from "./runner.ts";

const ok = (content: string, data?: unknown): ToolOutput => ({ content, ...(data !== undefined ? { data } : {}) });
const fail = (content: string): ToolOutput => ({ content, isError: true });

export interface OrchestratorEnv {
  sessionId: string;
  cwd: string;
  store(): MissionStore;
  runner(): MissionRunner;
  missionSettings(): MissionSettings;
  /** Asks the user. Resolves accepted:true when no client can be asked (headless mission mode). */
  confirm(params: Record<string, unknown>): Promise<{ accepted: boolean; comment?: string }>;
  runningMissions(): string[];
  notifyState(): void;
}

const PROPOSAL_SECTIONS = "overview; expected behavior by milestone and feature; architecture; environment setup; infrastructure (services, ports, boundaries); testing strategy; user-testing strategy; mission readiness; non-functional requirements";

export function orchestratorTools(env: OrchestratorEnv): Tool[] {
  const propose: Tool = {
    name: "ProposeMission",
    category: "other",
    description: `Submit the mission plan to the user for approval. The proposal is markdown and should cover: ${PROPOSAL_SECTIONS}. On approval the mission folder is created. Returns accepted, missionDir, isEdited and any guidance the user added.`,
    inputSchema: { type: "object", properties: { title: { type: "string" }, proposal: { type: "string", description: "Markdown proposal." }, workingDirectory: { type: "string", description: "Repository folder workers run in (default: the session folder)." } }, required: ["title", "proposal"] },
    async run(input) {
      const title = typeof input.title === "string" ? input.title.trim() : "";
      const proposal = typeof input.proposal === "string" ? input.proposal : "";
      if (!title || !proposal.trim()) return fail("title and proposal are required.");
      const wd = typeof input.workingDirectory === "string" && input.workingDirectory ? input.workingDirectory : env.cwd;
      const a = await env.confirm({ type: "propose_mission", title, proposal });
      if (!a.accepted) return ok(JSON.stringify({ accepted: false, ...(a.comment ? { guidance: a.comment } : {}) }), { accepted: false });
      const s = env.store();
      s.ensure();
      writeFileSync(s.path("mission.md"), `# ${title}\n\n${proposal}\n`);
      writeFileSync(s.path("working_directory.txt"), wd + "\n");
      writeFileSync(s.path("model-settings.json"), JSON.stringify(env.missionSettings(), null, 2) + "\n");
      s.writeState({ state: "planning", workingDirectory: wd });
      s.log("mission_accepted", { title });
      env.notifyState();
      const res = { accepted: true, missionDir: s.dir, isEdited: false, ...(a.comment ? { guidance: a.comment } : {}) };
      return ok(JSON.stringify(res), res);
    },
  };

  const start: Tool = {
    name: "StartMissionRun",
    category: "other",
    description: "Run (or resume) the mission queue. Blocks while workers run, one at a time, and returns when the mission completes, pauses, or needs your attention, with the recent handoffs. Refuses when the plan files are incomplete or the latest handoff has unaddressed items.",
    inputSchema: { type: "object", properties: { message: { type: "string" }, resumeWorkerSessionId: { type: "string" }, restartFeature: { type: "boolean" }, messageToWorker: { type: "string" } } },
    async run(input, ctx) {
      const s = env.store();
      if (!s.exists()) return fail("No mission folder exists yet: call ProposeMission first.");
      const running = env.runningMissions();
      const a = await env.confirm({ type: "start_mission_run", runningMissionCount: running.length, runningMissionSessionIds: running });
      if (!a.accepted) return ok(JSON.stringify({ started: false, message: "The user did not approve starting the run." }), { started: false });
      const runner = env.runner();
      const r = await runner.run(input as RunInput, ctx.signal);
      const body = { started: r.ok, state: r.state, pauseReason: r.pauseReason, message: r.message, handoffs: r.handoffs, latestHandoff: r.latestHandoff, counts: r.counts, progress: r.progress, tokenUsage: r.tokenUsage };
      return r.ok ? ok(JSON.stringify(body), body) : { content: JSON.stringify({ ...body, started: false }), isError: true, data: body };
    },
  };

  const dismiss: Tool = {
    name: "DismissHandoffItems",
    category: "other",
    description: "Dismiss discovered issues, critical context or incomplete work from handoffs, each with a justification of at least 20 characters. Clears the handoff gate on StartMissionRun.",
    inputSchema: {
      type: "object",
      properties: { dismissals: { type: "array", items: { type: "object", properties: {
        type: { type: "string", enum: ["discovered_issue", "critical_context", "incomplete_work"] },
        featureId: { type: "string" }, workerSessionId: { type: "string" }, summary: { type: "string" }, justification: { type: "string" },
      }, required: ["type", "justification"] } } },
      required: ["dismissals"],
    },
    async run(input) {
      const d = input.dismissals;
      if (!Array.isArray(d) || !d.length) return fail("dismissals must be a non-empty array.");
      for (const [i, x] of d.entries()) {
        if (!x || !["discovered_issue", "critical_context", "incomplete_work"].includes(x.type)) return fail(`dismissals[${i}].type must be discovered_issue, critical_context or incomplete_work.`);
        if (typeof x.justification !== "string" || x.justification.trim().length < 20) return fail(`dismissals[${i}].justification must be at least 20 characters.`);
      }
      env.store().log("handoff_items_dismissed", { dismissals: d });
      return ok(`Dismissed ${d.length} item(s). You can call StartMissionRun.`);
    },
  };
  return [propose, start, dismiss];
}

export interface WorkerEnv {
  sessionId: string;
  store: MissionStore;
  workingDirectory(): string;
}

function commitExists(repo: string, commit: string): boolean {
  try { execFileSync("git", ["-C", repo, "cat-file", "-e", `${commit}^{commit}`], { stdio: "ignore", timeout: 5000 }); return true; } catch { return false; }
}

export function workerTools(env: WorkerEnv): Tool[] {
  const end: Tool = {
    name: "EndFeatureRun",
    category: "other",
    description: "Finish your assigned feature: record the result and your handoff. Call it exactly once as your last action. success requires validatorsPassed: true; commitId requires repoPath (default: the working folder). Returns nextAction: continue, orchestrator or completed.",
    inputSchema: {
      type: "object",
      properties: {
        successState: { type: "string", enum: ["success", "partial", "failure"] }, returnToOrchestrator: { type: "boolean" },
        featureId: { type: "string" }, commitId: { type: "string" }, repoPath: { type: "string" }, validatorsPassed: { type: "boolean" },
        handoff: { type: "object", description: "salientSummary, whatWasImplemented, whatWasLeftUndone, verification{commandsRun[]}, tests{added[],coverage}, discoveredIssues[]" },
      },
      required: ["successState", "returnToOrchestrator", "handoff"],
    },
    async run(input, ctx) {
      const s = env.store;
      const features = s.features();
      const feat = features.find((f) => f.currentWorkerSessionId === ctx.sessionId && f.status === "in_progress");
      if (!feat) return fail("EndFeatureRun refused: this session is not the current worker of an in-progress feature.");
      if (typeof input.featureId === "string" && input.featureId !== feat.id) return fail(`EndFeatureRun refused: your feature is ${feat.id}, not ${input.featureId}.`);
      const st = input.successState;
      if (st !== "success" && st !== "partial" && st !== "failure") return fail("successState must be success, partial or failure.");
      if (typeof input.returnToOrchestrator !== "boolean") return fail("returnToOrchestrator must be a boolean.");
      const h = checkHandoff(input.handoff);
      if ("error" in h) return fail(h.error);
      const repo = typeof input.repoPath === "string" && input.repoPath ? input.repoPath : env.workingDirectory();
      if (typeof input.commitId === "string" && input.commitId) {
        if (!commitExists(repo, input.commitId)) return fail(`commitId ${input.commitId} was not found in ${repo}. Give the right repoPath, or omit commitId.`);
      }
      if (st === "success" && input.validatorsPassed !== true) return fail("success requires validatorsPassed: true. Run the validators (tests, checks) and fix failures first, or report partial or failure.");
      const rec: HandoffRecord = {
        timestamp: new Date().toISOString(), workerSessionId: ctx.sessionId, featureId: feat.id, milestone: feat.milestone,
        ...(typeof input.commitId === "string" && input.commitId ? { commitId: input.commitId, repoPath: repo } : {}),
        successState: st, returnToOrchestrator: input.returnToOrchestrator, handoff: h.handoff as Handoff,
      };
      s.addHandoff(rec);
      const all = s.features();
      const i = all.findIndex((f) => f.id === feat.id);
      const [f] = all.splice(i, 1);
      if (st === "success") {
        f.status = "completed";
        f.completedWorkerSessionId = ctx.sessionId;
        delete f.currentWorkerSessionId;
        all.push(f);
      } else {
        f.status = "pending";
        delete f.currentWorkerSessionId;
        all.splice(i, 0, f);
      }
      s.writeFeatures(all);
      const allDone = all.every((x) => x.status === "completed" || x.status === "cancelled");
      const nextAction = needsAttention(rec) ? "orchestrator" : allDone ? "completed" : "continue";
      return ok(JSON.stringify({ recorded: true, featureId: feat.id, nextAction, ...(hasUndoneWork(rec.handoff) ? { note: "Undone work was recorded for the orchestrator." } : {}) }), { nextAction });
    },
  };
  return [end];
}
