// Background jobs (spec §4.3): a Script started with //@background (or still running after its
// foreground window) and an Execute call with background:true. The model may end its turn while
// jobs run; when one finishes, the session is woken with a reminder message.
import type { ToolOutput } from "../core/types.ts";

export type JobStatus = "running" | "completed" | "failed" | "timed_out";

export interface Job {
  readonly id: string;
  readonly kind: "script" | "execute" | "task";
  readonly title: string;
  status: JobStatus;
  /** Resolves once the job has reached a final status. */
  readonly done: Promise<void>;
  /** Cancels the job. Effects it already had stay. */
  stop(): void;
  /** What the model is shown: final result, or the output so far while running. */
  report(): Record<string, unknown>;
  /** True once the model has been given the final result (script_job or a wake reminder). */
  reported: boolean;
  /** True once the job runs in the background (wake applies). */
  detached: boolean;
}

/** What tools see through ToolContext.jobs. */
export interface JobsApi {
  /** Runs `run` as a background job and returns its id at once. */
  startBackground(spec: {
    kind: "execute";
    title: string;
    run: (signal: AbortSignal) => Promise<ToolOutput>;
  }): string;
}

export function newJobId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/** A job that wraps one async function (used for Execute). */
export class FnJob implements Job {
  status: JobStatus = "running";
  reported = false;
  detached = true;
  readonly done: Promise<void>;
  private ac = new AbortController();
  private out?: ToolOutput;
  private stopped = false;
  readonly startedAt = Date.now();

  constructor(
    readonly id: string,
    readonly kind: "execute",
    readonly title: string,
    run: (signal: AbortSignal) => Promise<ToolOutput>,
  ) {
    this.done = run(this.ac.signal).then(
      (o) => { this.out = o; this.status = o.isError ? "failed" : "completed"; },
      (e) => { this.out = { content: `Job failed: ${(e as Error)?.message ?? e}`, isError: true }; this.status = "failed"; },
    );
  }

  stop(): void {
    this.stopped = true;
    this.ac.abort();
  }

  report(): Record<string, unknown> {
    const r: Record<string, unknown> = { status: this.stopped && this.status !== "completed" ? "failed" : this.status, job_id: this.id, kind: this.kind, command: this.title };
    if (this.out) r.output = this.out.content;
    else r.output = "(still running; no output captured yet)";
    if (this.stopped) r.stopped = true;
    r.elapsedMs = Date.now() - this.startedAt;
    return r;
  }
}

export class JobManager implements JobsApi {
  private jobs = new Map<string, Job>();
  private listeners = new Set<(j: Job) => void>();

  add(job: Job): void {
    this.jobs.set(job.id, job);
    void job.done.then(() => { if (job.detached) this.emit(job); });
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  list(): Job[] {
    return [...this.jobs.values()];
  }

  /** Marks a job as background work. If it already finished, listeners hear about it now. */
  detach(id: string): void {
    const j = this.jobs.get(id);
    if (!j || j.detached) return;
    j.detached = true;
    if (j.status !== "running") this.emit(j);
  }

  startBackground(spec: { kind: "execute"; title: string; run: (signal: AbortSignal) => Promise<ToolOutput> }): string {
    const job = new FnJob(newJobId("job"), spec.kind, spec.title, spec.run);
    this.add(job);
    return job.id;
  }

  /** Detached jobs still running. */
  running(): Job[] {
    return this.list().filter((j) => j.detached && j.status === "running");
  }

  /** Detached jobs that finished and whose result the model has not seen yet. */
  unreported(): Job[] {
    return this.list().filter((j) => j.detached && j.status !== "running" && !j.reported);
  }

  onFinished(cb: (j: Job) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(j: Job) {
    for (const l of this.listeners) l(j);
  }

  /** Resolves when the job ends, the timeout passes, or the signal aborts. */
  async wait(id: string, timeoutMs: number, signal?: AbortSignal): Promise<"done" | "timeout" | "aborted"> {
    const j = this.jobs.get(id);
    if (!j) return "done";
    if (j.status !== "running") return "done";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        j.done.then(() => "done" as const),
        new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), timeoutMs); }),
        new Promise<"aborted">((r) => {
          if (!signal) return;
          if (signal.aborted) return r("aborted");
          onAbort = () => r("aborted");
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }

  async stopAll(): Promise<void> {
    const live = this.list().filter((j) => j.status === "running");
    // Stopped on shutdown: nobody is left to wake.
    for (const j of live) { j.reported = true; j.stop(); }
    await Promise.all(live.map((j) => j.done.catch(() => {})));
  }
}
