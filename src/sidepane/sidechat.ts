// Side chat (spec §17.4): ask a question about the session without interrupting the main agent.
//
// Decision: a FORK, not a fresh session. On the first question the main conversation is copied from its last settled
// point (an assistant message that ends a turn, so no tool call is half done) into a second in-memory Session. That
// session shares nothing with the main one: nothing is written to the main transcript, the main agent cannot see it,
// and it never touches the main session's queue. Its tools are read-only (the caller passes toolsFor) and permission
// requests are auto-rejected, so a question cannot change files or state. When no question is pending the fork is
// closed; the next question forks again and carries up to 10 earlier exchanges as possibly stale context.
import type { Message } from "../core/types.ts";
import type { Session, SessionHost } from "../agent/session.ts";

export type SideChatStatus = "pending" | "streaming" | "complete" | "error";

export interface SideChatEntry {
  id: string;
  question: string;
  answer: string;
  status: SideChatStatus;
  createdAt: number;
}

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
  fork(messages: Message[], host: SessionHost): Session;
  /** Sends an entry update to the client(s). */
  emit(entry: SideChatEntry): void;
}

export class SideChat {
  readonly entries: SideChatEntry[] = [];
  private queue: SideChatEntry[] = [];
  private running = false;
  private session?: Session;
  private current?: { entry: SideChatEntry; messageId?: string; settle: (reason: string) => void };
  private idle: Promise<void> = Promise.resolve();

  constructor(private deps: SideChatDeps) {}

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
        this.session = this.deps.fork(settledPrefix(this.deps.mainMessages()), this.host());
      }
      const first = this.session.messages.every((m) => !m.id.startsWith("btw-"));
      const text = `<system-reminder>${SIDE_CHAT_PREAMBLE}</system-reminder>\n\n${first ? priorExchangesText(priors) : ""}${entry.question}`;
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
