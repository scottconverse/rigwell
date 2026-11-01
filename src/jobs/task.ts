// A background Task (subagent) as a job: script_job can wait on, check or stop it, and its report wakes the session (spec 4.3, 5.9).
import type { Job, JobStatus } from "./manager.ts";

export class TaskJob implements Job {
  readonly kind = "task" as const;
  status: JobStatus = "running";
  reported = false;
  detached = false;
  readonly done: Promise<void>;
  private report_ = "";
  private stopped = false;
  private startedAt = Date.now();

  constructor(readonly id: string, readonly title: string, result: Promise<string>, private onStop: () => void) {
    this.done = result.then(
      (r) => { this.report_ = r; this.status = this.stopped ? "failed" : "completed"; },
      (e) => { this.report_ = `Subagent failed: ${(e as Error)?.message ?? e}`; this.status = "failed"; },
    );
  }

  stop(): void {
    this.stopped = true;
    this.onStop();
  }

  report(): Record<string, unknown> {
    return {
      status: this.status, job_id: this.id, kind: "task", description: this.title,
      output: this.status === "running" ? "(the subagent is still running)" : this.report_,
      ...(this.stopped ? { stopped: true } : {}), elapsedMs: Date.now() - this.startedAt,
    };
  }
}
