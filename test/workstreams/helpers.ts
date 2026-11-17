import { tmp } from "../worktree/util.ts";
import { createWorkstreamService } from "../../src/workstreams/index.ts";
import { MemberSession } from "../../src/workstreams/member.ts";
import { WorkstreamStore } from "../../src/workstreams/store.ts";
import { makeHome } from "../e2e/helpers.ts";
import { resolveModels } from "../../src/storage/models.ts";
import { loadSettings } from "../../src/storage/settings.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import type { FakeTurnSpec } from "../fakes/types.ts";

export async function until(predicate: () => boolean) {
  const end = Date.now() + 3000;
  while (!predicate()) { if (Date.now() >= end) throw new Error("condition not reached"); await Bun.sleep(5); }
}
export async function setup(route: (body: any) => FakeTurnSpec = () => ({ text: "Finished" })) {
  const fake = await startFakeAnthropic(Array.from({ length: 60 }, () => route));
  process.env.RIGWELL_HOME = makeHome([{ provider: "anthropic", url: fake.url, displayName: "Fixture" }]);
  const service = createWorkstreamService(), cwd = tmp("ws-messages");
  const prompts: { method: string; params: any; answer(value: any): void }[] = [], notifications: any[] = [];
  const request = async (method: string, params: any) => {
    if (params.toolUses?.[0]?.confirmationType === "propose_workstream") return { selectedOption: "proceed_once" };
    return new Promise((answer) => prompts.push({ method, params, answer }));
  };
  const lead = new MemberSession({
    tools: (tools) => attached.wrapTools(tools), request,
    notify: (n) => { notifications.push(n); if (lead.connection.session) service.observe(lead.connection.session, n); },
  });
  const conn = { session: () => lead.connection.session, notify(n: any) { notifications.push(n); }, request };
  const attached = service.attach(conn);
  const model = resolveModels(loadSettings({ cwd }).settings)[0]!.id;
  await lead.call("initialize_session", { cwd, modelId: model, autonomyLevel: "low" });
  const approved = await service.propose(conn, { title: "Messaging", goal: "Coordinate", plan: "Exchange peer data" });
  const store = new WorkstreamStore(approved.workstreamId!);
  const first = await service.spawn(lead.connection.session!, { name: "First", role: "task", prompt: "INITIAL", worktree: false });
  const member = service.members.get(first.agentId)!;
  await member.connection.session!.idle();
  return { fake, service, lead, member, first, store, attached, prompts, notifications, cwd,
    async close() { attached.close(); await service.stop(); await lead.close(); fake.stop(); } };
}

