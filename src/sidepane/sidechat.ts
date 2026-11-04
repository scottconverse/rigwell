// Side chat (spec §17.4): ask a question about the session without interrupting the main agent.
//
// Decision: a FORK, not a fresh session. On the first question the main conversation is copied from its last settled
// point (an assistant message that ends a turn, so no tool call is half done) into a second in-memory Session. That
// session shares nothing with the main one: nothing is written to the main transcript, the main agent cannot see it,
// and it never touches the main session's queue. Its tools are read-only (the caller passes toolsFor) and permission
// requests are auto-rejected, so a question cannot change files or state. When no question is pending the fork is
// closed; the next question forks again and carries up to 10 earlier exchanges as possibly stale context.
//
// Storage (spec 17.4): each fork is written to <sessions>/btw/<id>.jsonl + <id>.settings.json with the tag `btw-fork`
// (btw-store.ts). Promote removes the tag and moves the files into the project's session folder. Writes are gated:
// the fork has no Edit/Create tools unless the user turns writes on (setWrites).
import type { Message } from "../core/types.ts";
import type { Session, SessionHost } from "../agent/session.ts";

export type SideChatStatus = "pending" | "streaming" | "complete" | "error";

export interface SideChatEntry {
  id: string;
  question: string;
  answer: string;
  status: SideChatStatus;
  createdAt: number;
  /** The stored fork that answered this entry (its btw/ transcript id). */
  forkId?: string;
  /** Set once the fork was promoted to a normal session. */
  promotedTo?: string;
}

export const SIDE_CHAT_WRITES_NOTE = " The user has turned writes on for this side chat: you may edit files when they ask you to.";

export const SIDE_CHAT_PREAMBLE =
  "This is a side conversation: a separate copy of the session so the user can ask a quick question while the main agent keeps working. " +
  "The main agent cannot see this chat and is not interrupted by it. Answer from the conversation so far and from read-only checks " +
  "(reading files, searching, listing). Do not edit files or run state-changing commands unless the user asks for that here. " +
  "You cannot ask the user questions; if something is unclear, say what you assumed.";

const MAX_PRIOR = 10;
const MAX_Q = 1000;
const MAX_A = 4000;
const MAX_ENTRIES = 100;

/** The conversation up to the last assistant message that ended a turn (no tool calls left open). */
export function settledPrefix(messages: Message[]): Message[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && !m.content.some((b) => b.type === "tool_use")) return messages.slice(0, i + 1);
  }
  return [];
}

export function priorExchangesText(entries: SideChatEntry[]): string {
  const done = entries.filter((e) => e.status === "complete" && e.answer).slice(-MAX_PRIOR);
  if (!done.length) return "";
  const body = done.map((e, i) => `Q${i + 1}: ${e.question.slice(0, MAX_Q)}\nA${i + 1}: ${e.answer.slice(0, MAX_A)}`).join("\n\n");
  return `Earlier side-chat exchanges (they may be out of date now):\n${body}\n\n`;
}

export interface SideChatDeps {
  /** The main session's messages right now. */
  mainMessages(): Message[];
  /** Builds the fork over a message list. The host receives every notification of the fork. */
  fork(messages: Message[], host: SessionHost, info: ForkInfo): Session | Promise<Session>;
  /** Sends an entry update to the client(s). */
  emit(entry: SideChatEntry): void;
  /** Moves a stored fork into the project's session folder as a normal session (Promote). */
  promote?(forkId: string, title: string): Promise<{ sessionId: string }>;
}

export interface ForkInfo {
  /** Up to 10 earlier exchanges, carried as possibly stale context. */
  priorExchanges: { question: string; answer: string }[];
  /** True when the user turned writes on: the fork keeps its edit tools. */
  writes: boolean;
}

export class SideChat {
  readonly entries: SideChatEntry[] = [];
  private queue: SideChatEntry[] = [];
  private running = false;
  private session?: Session;
  private current?: { entry: SideChatEntry; messageId?: string; settle: (reason: string) => void };
  private idle: Promise<void> = Promise.resolve();
  private writesOn = false;
  private sessionWrites = false;

  constructor(private deps: SideChatDeps) {}

  get writes() { return this.writesOn; }

  /** The "turn writes on" switch. A fork that is already open keeps the old setting; the next fork uses the new one. */
  setWrites(on: boolean) { this.writesOn = on; }

  /**
   * Promote: the stored fork that answered `entryId` becomes a normal session in the project's folder.
   * Waits for a running fork to close first; refuses while this entry is still being answered.
   */
  async promote(entryId: string): Promise<{ sessionId: string }> {
    const entry = this.entries.find((e) => e.id === entryId);
    if (!entry) throw new Error("No such side-chat entry.");
    if (entry.promotedTo) return { sessionId: entry.promotedTo };
    if (!entry.forkId) throw new Error("This question has no stored side chat yet.");
    if (entry.status === "pending" || entry.status === "streaming") throw new Error("Wait for the answer to finish, then promote.");
    if (!this.deps.promote) throw new Error("Promote is not available.");
    await this.idle; // the fork closes when no question is pending
    const first = this.entries.find((e) => e.forkId === entry.forkId);
    const r = await this.deps.promote(entry.forkId, `Side chat: ${(first ?? entry).question.replace(/\s+/g, " ").slice(0, 60)}`);
    for (const e of this.entries) if (e.forkId === entry.forkId) { e.promotedTo = r.sessionId; this.deps.emit({ ...e }); }
    return r;
  }

  /** Queues a question. Returns the entry at once; updates arrive through `emit`. */
  ask(question: string): SideChatEntry {
    const entry: SideChatEntry = { id: crypto.randomUUID(), question, answer: "", status: "pending", createdAt: Date.now() };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
    this.queue.push(entry);
    this.deps.emit({ ...entry });
    if (!this.running) { this.running = true; this.idle = this.drain(); }
    return entry;
  }

  /** Resolves when no question is pending (tests). */
  whenIdle() { return this.idle; }

  /** Stops the current answer and drops queued questions. */
  cancel() {
    for (const e of this.queue.splice(0)) { e.status = "error"; e.answer = e.answer || "Cancelled."; this.deps.emit({ ...e }); }
    this.session?.interrupt();
  }

  private host(): SessionHost {
    return {
      notify: (n) => this.onNotification(n),
      // No requestPermission: the fork cannot ask the user. The session is built with autoRejectPermissionRequests.
    };
  }

  private onNotification(n: Record<string, unknown>) {
    const cur = this.current;
    if (!cur) return;
    switch (n.type) {
      case "assistant_text_delta": {
        // Only the last assistant message is the answer; text before a tool call is working notes.
        if (cur.messageId !== n.messageId) { cur.messageId = n.messageId as string; cur.entry.answer = ""; }
        cur.entry.answer += String(n.textDelta ?? "");
        cur.entry.status = "streaming";
        this.deps.emit({ ...cur.entry });
        break;
      }
      case "agent_turn_completed":
        cur.settle(String(n.reason ?? "completed"));
        break;
    }
  }

  private async drain() {
    try {
      while (this.queue.length) {
        const entry = this.queue.shift()!;
        await this.answer(entry);
      }
    } finally {
      // Close the fork when nothing is pending.
      this.session?.interrupt();
      await this.session?.idle().catch(() => {});
      await this.session?.stopBackgroundJobs().catch(() => {});
      this.session = undefined;
      this.running = false;
    }
  }

  private async answer(entry: SideChatEntry) {
    const priors = this.entries.filter((e) => e !== entry && e.status === "complete");
    try {
      if (!this.session) {
        // Earlier exchanges are only carried when this fork did not see them itself.
        const done = priors.filter((e) => e.answer).slice(-MAX_PRIOR);
        this.sessionWrites = this.writesOn;
        this.session = await this.deps.fork(settledPrefix(this.deps.mainMessages()), this.host(), {
          priorExchanges: done.map((e) => ({ question: e.question.slice(0, MAX_Q), answer: e.answer.slice(0, MAX_A) })), writes: this.sessionWrites,
        });
      }
      entry.forkId = this.session.id;
      const first = this.session.messages.every((m) => !m.id.startsWith("btw-"));
      const text = `<system-reminder>${SIDE_CHAT_PREAMBLE}${this.sessionWrites ? SIDE_CHAT_WRITES_NOTE : ""}</system-reminder>\n\n${first ? priorExchangesText(priors) : ""}${entry.question}`;
      const turn = new Promise<string>((resolve) => { this.current = { entry, settle: resolve }; });
      this.session.addUserMessage(text, `btw-${entry.id}`);
      const reason = await turn;
      entry.status = reason === "completed" ? "complete" : "error";
      if (entry.status === "error" && !entry.answer) entry.answer = `The side chat stopped (${reason}).`;
    } catch (e) {
      entry.status = "error";
      entry.answer = entry.answer || (e as Error).message;
    } finally {
      this.current = undefined;
      this.deps.emit({ ...entry });
    }
  }
}
