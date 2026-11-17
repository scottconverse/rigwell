import { ErrorCodes, RpcError } from "../protocol/rpc.ts";
import { gitOk } from "../worktree/git.ts";
import { ReviewHost, type ReviewHostDeps } from "./host.ts";
import { addressReview, localReview, reviewComments, type ReviewSnapshot } from "./local.ts";

export class ReviewService {
  private snapshots = new Map<string, ReviewSnapshot>();
  constructor(private opts: { cwd(): string; approve?: (params: Record<string, unknown>) => Promise<unknown>; host?: ReviewHostDeps }) {}
  async handle(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === "review_snapshot") {
      if (params.cwd !== undefined && (typeof params.cwd !== "string" || !params.cwd)) throw new RpcError(ErrorCodes.INVALID_PARAMS, "cwd must be a folder");
      if (params.base !== undefined && (typeof params.base !== "string" || !params.base || params.base.length > 300)) throw new RpcError(ErrorCodes.INVALID_PARAMS, "base must be a Git revision up to 300 characters");
      if (params.pr !== undefined && params.pr !== false && params.pr !== true && (!Number.isInteger(params.pr) || Number(params.pr) <= 0)) throw new RpcError(ErrorCodes.INVALID_PARAMS, "pr must be a positive PR number or true for this branch");
      const cwd = (params.cwd as string | undefined) ?? this.opts.cwd();
      let snapshot: ReviewSnapshot;
      if (params.pr) {
        const host = await ReviewHost.open(cwd, this.opts.host);
        let number = params.pr as number;
        if (params.pr === true) {
          const branch = await gitOk(cwd, ["symbolic-ref", "--short", "HEAD"]);
          const route = host.repo.provider === "github" ? `${host.root}/pulls?state=open&head=${encodeURIComponent(host.repo.project.split("/")[0] + ":" + branch)}` : `${host.root}/merge_requests?state=opened&source_branch=${encodeURIComponent(branch)}`;
          const rows = await host.pages(route);
          if (!rows.length) throw new Error("No open PR for this branch");
          number = rows[0].number ?? rows[0].iid;
        }
        snapshot = await host.snapshot(number);
      } else snapshot = await localReview(cwd, params.base as string | undefined);
      this.snapshots.set(snapshot.id, snapshot);
      while (this.snapshots.size > 4) this.snapshots.delete(this.snapshots.keys().next().value!);
      return snapshot;
    }
    const snapshot = typeof params.snapshotId === "string" ? this.snapshots.get(params.snapshotId) : undefined;
    if (!snapshot) throw new RpcError(ErrorCodes.ENTITY_NOT_FOUND, "Review snapshot expired; reload the review");
    const comments = reviewComments(snapshot, params.comments ?? []);
    if (method === "review_task") return { cwd: snapshot.cwd, task: addressReview(snapshot, comments) };
    if (method !== "review_submit") throw new RpcError(ErrorCodes.METHOD_NOT_FOUND, "Unknown review method");
    if (!snapshot.pr) throw new RpcError(ErrorCodes.INVALID_PARAMS, "Load a PR review before posting");
    if (!["COMMENT", "APPROVE", "REQUEST_CHANGES"].includes(params.event as string)) throw new RpcError(ErrorCodes.INVALID_PARAMS, "event must be COMMENT, APPROVE or REQUEST_CHANGES");
    if (params.body !== undefined && (typeof params.body !== "string" || params.body.length > 65536)) throw new RpcError(ErrorCodes.INVALID_PARAMS, "body must be text up to 64 KiB");
    const event = params.event as "COMMENT" | "APPROVE" | "REQUEST_CHANGES", body = (params.body as string | undefined)?.trim() ?? "";
    if (event === "COMMENT" && !body && !comments.length) throw new RpcError(ErrorCodes.INVALID_PARAMS, "Add a comment or review summary before posting");
    if (!this.opts.approve) throw new RpcError(ErrorCodes.REQUEST_CANCELLED, "Posting a review requires an interactive approver");
    const details = { repository: snapshot.pr.project, provider: snapshot.pr.provider, number: snapshot.pr.number, url: snapshot.pr.url, head: snapshot.head, event, body, comments };
    const answer = await this.opts.approve({ toolUses: [{ toolUse: { type: "tool_use", id: crypto.randomUUID(), name: "review_submit", input: details }, confirmationType: "code_review", details }], options: [{ label: event === "APPROVE" ? "Post approval" : event === "REQUEST_CHANGES" ? "Post request for changes" : "Post review comments", value: "proceed_once" }, { label: "Cancel", value: "cancel" }] }) as any;
    if (answer?.selectedOption !== "proceed_once") throw new RpcError(ErrorCodes.REQUEST_CANCELLED, "Review cancelled; nothing was posted");
    // Consume the snapshot before writes: concurrent requests cannot post it twice.
    if (!this.snapshots.delete(snapshot.id)) throw new RpcError(ErrorCodes.REQUEST_CANCELLED, "Review already submitted; reload its status");
    const host = await ReviewHost.open(snapshot.cwd, this.opts.host);
    const result = await host.publish(snapshot, event, body, comments);
    return { posted: true, url: snapshot.pr.url, result };
  }
}
