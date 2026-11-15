import { test, expect } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { tmpEnv } from "../storage/helpers.ts";
import { InboxStore, defaultEmail, validateEmail } from "../../src/inbox/store.ts";
import { InboxService } from "../../src/inbox/service.ts";
import { CredentialStore, FileBackend, setCredentialStore } from "../../src/storage/credentials.ts";
import { setSecret } from "../../src/secrets/store.ts";

test("Inbox persists deduplicated categories, read state, tied timestamp pagination and resolved prompts", async () => {
  const env = tmpEnv(), store = new InboxStore(), service = new InboxService(store, { now: () => 1000 });
  try {
    service.start(); const session = { id: "session", cwd: env.root };
    service.session(session, { type: "user_prompt_requested", kind: "ask_user", requestId: "question", summary: "Choose a color" });
    service.session(session, { type: "user_prompt_requested", kind: "permission", requestId: "permission" });
    service.session(session, { type: "agent_turn_completed", turnId: "turn", reason: "completed" });
    service.session(session, { type: "agent_turn_completed", turnId: "turn", reason: "completed" });
    service.automation({ id: "auto", fm: { name: "Fixture" } }, { runId: "run", status: "success" });
    service.mission(session, { type: "mission_state_changed", state: "paused", updatedAt: 5 });
    service.workstream({ type: "workstream_updated", workstreamId: "work", workstream: { state: "paused", updatedAt: 6 } });
    service.workstream({ type: "workstream_member_notification", workstreamId: "work", sessionId: "member", notification: { type: "user_prompt_requested", kind: "ask_user", requestId: "member-question" } });
    const all = store.list(); expect(all.items).toHaveLength(7); expect(new Set(all.items.map((i) => i.category)).size).toBe(6); expect(all.unread).toBe(7);
    const member = all.items.find((i) => i.sessionId === "member")!; expect(member.route).toBe("/workstreams/work"); expect(member.resolved).toBe(false);
    expect(all.items.find((i) => i.requestId === "question")?.resolved).toBe(true);
    const first = store.list({ limit: 3 }).items; const last = first.at(-1)!; const next = store.list({ limit: 3, before: { at: last.at, id: last.id } }).items;
    expect(new Set([...first, ...next].map((i) => i.id)).size).toBe(6);
    service.methods.mark_inbox({ ids: first.map((i) => i.id), read: true }); expect(store.list({ unread: true }).items).toHaveLength(4);
    service.methods.mark_inbox({ ids: [first[0]!.id], read: false }); expect(new InboxStore().list().unread).toBe(5);
    expect(store.list({ category: "automation" }).items[0]?.route).toBe("/automations/auto");
    expect(() => store.list({ category: "unknown" })).toThrow(); expect(() => store.list({ before: { at: 1 } })).toThrow();
    await service.stop(); const recovered = new InboxService(new InboxStore()); recovered.start(); expect(store.list().items.find((i) => i.sessionId === "member")?.resolved).toBe(true); await recovered.stop();
  } finally { await service.stop(); env.cleanup(); }
});

test("email opt-in queues new redacted alerts, sends immediate and daily categories, cancels old config and retains uncertain delivery", async () => {
  const env = tmpEnv(), store = new InboxStore(), sent: any[] = []; let now = new Date(2026, 10, 14, 8).getTime(), fail = false;
  setCredentialStore(new CredentialStore([new FileBackend(() => join(env.root, "credentials.json"))]));
  const service = new InboxService(store, { now: () => now, send: async (c, m) => { sent.push({ c, m }); if (fail) throw new Error("fixture-smtp-password delivery interrupted"); } });
  try {
    setSecret("smtp", "fixture-smtp-password"); service.start();
    const config = { ...defaultEmail(), enabled: true, host: "smtp.example.test", user: "fixture", passwordCredential: "smtp", from: "rigwell@example.test", to: "owner@example.test", categories: { ...defaultEmail().categories, question: "immediate" as const, turn: "digest" as const } };
    const s = { id: "session", cwd: env.root };
    service.session(s, { type: "agent_turn_completed", turnId: "before", reason: "completed" });
    const denied = await service.methods.configure_email_alerts({ config }).then(() => undefined, (e) => e); expect(denied).toBeDefined();
    await service.methods.configure_email_alerts({ config, confirmed: true });
    service.session(s, { type: "user_prompt_requested", kind: "ask_user", requestId: "one", summary: "fixture-smtp-password" });
    service.session(s, { type: "agent_turn_completed", turnId: "digest", reason: "completed" });
    await Promise.all([service.flush(), service.flush()]); expect(sent).toHaveLength(1); expect(sent[0].m.text).not.toContain("fixture-smtp-password");
    expect(store.list().items.find((i) => i.requestId === "one")?.detail).not.toContain("fixture-smtp-password");
    now = new Date(2026, 10, 14, 9).getTime(); await service.flush(); expect(sent).toHaveLength(2); expect(sent[1].m.subject).toBe("Rigwell daily digest (1)");
    expect(sent[1].m.text).toContain("rigwell://sessions/session");
    await service.flush(); expect(sent).toHaveLength(2);
    fail = true; service.session(s, { type: "user_prompt_requested", kind: "ask_user", requestId: "two" }); await service.flush(); await service.flush(); expect(sent).toHaveLength(3);
    expect(service.methods.get_email_alerts().error).not.toContain("fixture-smtp-password"); expect(store.deliveries()).toContainEqual({ delivery: "uncertain", count: 1 });
    service.session(s, { type: "agent_turn_completed", turnId: "cancel", reason: "completed" });
    await service.methods.configure_email_alerts({ config: { ...config, enabled: false }, confirmed: true }); now += 48 * 60 * 60_000; await service.flush(); expect(sent).toHaveLength(3);
    expect(store.deliveries()).toContainEqual({ delivery: "cancelled", count: 1 });
    expect(readFileSync(join(store.root, "email.json"), "utf8")).not.toContain("fixture-smtp-password");
    expect(() => validateEmail({ ...config, password: "forbidden" })).toThrow(); expect(() => validateEmail({ ...config, to: "owner@example.test\r\nBcc: other@example.test" })).toThrow();
    store.delivery(["turn:session:before"], "sending"); await service.stop(); const restart = new InboxService(store); restart.start(); expect(store.deliveries()).toContainEqual({ delivery: "uncertain", count: 2 }); await restart.stop();
  } finally { await service.stop(); setCredentialStore(undefined); env.cleanup(); }
});

test("daily alerts survive a daemon restart and catch up once when the scheduled local hour was missed", async () => {
  const env = tmpEnv(), store = new InboxStore(), sent: any[] = []; let now = new Date(2026, 10, 14, 8).getTime();
  const deps = { now: () => now, send: async (_c: any, m: any) => { sent.push(m); } };
  let service = new InboxService(store, deps);
  try {
    service.start(); await service.methods.configure_email_alerts({ confirmed: true, config: { ...defaultEmail(), enabled: true, host: "smtp.example.test", user: "fixture", passwordCredential: "smtp", from: "rigwell@example.test", to: "owner@example.test", categories: { ...defaultEmail().categories, turn: "digest" } } });
    service.session({ id: "session", cwd: env.root }, { type: "agent_turn_completed", turnId: "one", reason: "completed" });
    await service.flush(); expect(sent).toHaveLength(0); await service.stop();
    now += 26 * 60 * 60_000; service = new InboxService(new InboxStore(), deps); service.start();
    await service.flush(); await service.flush(); expect(sent).toHaveLength(1); expect(sent[0].subject).toBe("Rigwell daily digest (1)");
  } finally { await service.stop(); env.cleanup(); }
});
