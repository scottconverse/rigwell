import { codeProviderToken } from "../auth/code-providers.ts";
import { loadSettings } from "../storage/settings.ts";
import { codeRepo, type CodeRepo } from "../worktree/pr.ts";
import { gitOk } from "../worktree/git.ts";
import { diffLines, type ReviewComment, type ReviewFile, type ReviewSnapshot } from "./local.ts";
import { semanticDiff } from "./semantic.ts";

export interface ReviewHostDeps {
  which?: (command: string) => string | null;
  run?: (cmd: string[], cwd: string, env: Record<string, string>, input?: string) => Promise<{ code: number; stdout: string; stderr: string }>;
  fetch?: typeof fetch;
  /** Test seams, never taken from protocol parameters. */
  apiRoot?: (repo: CodeRepo) => string;
  repo?: (remote: string) => CodeRepo | null;
}
async function run(cmd: string[], cwd: string, env: Record<string, string>, input?: string) {
  const child = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" }, stdin: input === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
  if (input !== undefined && typeof child.stdin !== "number" && child.stdin) { child.stdin.write(input); child.stdin.end(); }
  const timer = setTimeout(() => child.kill(), 30_000);
  try { const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]); return { stdout, stderr, code }; }
  finally { clearTimeout(timer); }
}

export class ReviewHost {
  private constructor(readonly repo: CodeRepo, readonly cwd: string, private deps: ReviewHostDeps) {}
  static async open(cwd: string, deps: ReviewHostDeps = {}) {
    const remote = await gitOk(cwd, ["remote", "get-url", "origin"]);
    const repo = (deps.repo ?? codeRepo)(remote);
    if (!repo) throw new Error("PR review requires a GitHub or GitLab origin");
    return new ReviewHost(repo, cwd, deps);
  }
  get root() { return this.repo.provider === "github" ? `/repos/${this.repo.project}` : `/projects/${encodeURIComponent(this.repo.project)}`; }
  async request(route: string, body?: unknown): Promise<any> {
    const token = await codeProviderToken(this.repo.provider, loadSettings({ cwd: this.cwd }).settings);
    const command = (this.deps.which ?? Bun.which)(this.repo.provider === "github" ? "gh" : "glab");
    if (command) {
      const env: Record<string, string> = this.repo.provider === "github" ? { GH_HOST: "github.com", ...(token ? { GH_TOKEN: token } : {}) } : { GITLAB_HOST: "gitlab.com", GITLAB_API_HOST: "gitlab.com", GITLAB_API_PROTOCOL: "https", ...(token ? { GITLAB_TOKEN: token } : {}) };
      const args = [command, "api", "--hostname", this.repo.host, "--method", body === undefined ? "GET" : "POST", route.replace(/^\//, ""), ...(body === undefined ? [] : ["--input", "-"])];
      const result = await (this.deps.run ?? run)(args, this.cwd, env, body === undefined ? undefined : JSON.stringify(body));
      if (result.code !== 0) throw new Error(`Review provider CLI failed: ${token ? result.stderr.replaceAll(token, "[redacted]") : result.stderr}`);
      try { return JSON.parse(result.stdout); } catch { throw new Error("Review provider CLI returned invalid JSON"); }
    }
    if (!token) throw new Error(`Connect ${this.repo.provider}, or sign in with ${this.repo.provider === "github" ? "gh" : "glab"}`);
    const root = this.deps.apiRoot?.(this.repo) ?? (this.repo.provider === "github" ? "https://api.github.com" : "https://gitlab.com/api/v4");
    const url = route === "/graphql" && this.repo.provider === "gitlab" ? new URL("/api/graphql", root).href : root + route;
    const response = await (this.deps.fetch ?? fetch)(url, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Review provider API returned HTTP ${response.status}`);
    return response.json();
  }
  async pages(route: string): Promise<any[]> {
    const all: any[] = [];
    for (let page = 1; page <= 30; page++) {
      const rows = await this.request(`${route}${route.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      if (!Array.isArray(rows)) throw new Error("Review provider did not return a list");
      all.push(...rows); if (rows.length < 100) return all;
    }
    throw new Error("Review provider list exceeds 3000 records; a complete review cannot be shown");
  }
  private async wrappedPages(route: string, field: string): Promise<any[]> {
    const all: any[] = [];
    for (let page = 1; page <= 30; page++) {
      const result = await this.request(`${route}?per_page=100&page=${page}`), rows = result[field];
      if (!Array.isArray(rows)) throw new Error("Review provider did not return check data");
      all.push(...rows);
      if (result.total_count !== undefined && all.length >= result.total_count) return all;
      if (rows.length < 100) {
        if (result.total_count !== undefined && all.length < result.total_count) throw new Error("Provider returned incomplete review checks");
        return all;
      }
    }
    throw new Error("Review checks exceed 3000 records");
  }
  detail(number: number) { return this.request(`${this.root}/${this.repo.provider === "github" ? "pulls" : "merge_requests"}/${number}`); }
  async content(path: string, ref: string) {
    const route = this.repo.provider === "github" ? `${this.root}/contents/${path.split("/").map(encodeURIComponent).join("/")}` : `${this.root}/repository/files/${encodeURIComponent(path)}`;
    const file = await this.request(`${route}?ref=${encodeURIComponent(ref)}`);
    if (file.type && file.type !== "file") throw new Error(`Cannot load review content for ${path}`);
    if (file.encoding !== "base64" || typeof file.content !== "string" || file.size > 16 * 1024 * 1024) throw new Error(`Review content is unavailable or exceeds 16 MiB: ${path}`);
    return Buffer.from(file.content, "base64").toString("utf8");
  }
  async snapshot(number: number): Promise<ReviewSnapshot> {
    const gh = this.repo.provider === "github", raw = await this.detail(number);
    const base = gh ? raw.base?.sha : raw.diff_refs?.base_sha, head = gh ? raw.head?.sha : raw.diff_refs?.head_sha;
    if (!base || !head) throw new Error("PR diff references are not ready; retry once the provider has prepared them");
    const prefix = `${this.root}/${gh ? "pulls" : "merge_requests"}/${number}`;
    const entries = await this.pages(`${prefix}/${gh ? "files" : "diffs"}`);
    const count = gh ? raw.changed_files : raw.changes_count;
    if (String(count).endsWith("+") || (count !== undefined && Number(count) !== entries.length) || entries.some((f) => f.too_large || f.collapsed)) throw new Error("Provider returned an incomplete PR diff; load a complete branch review before reviewing");
    const files: ReviewFile[] = []; let bytes = 0;
    for (const entry of entries) {
      const path = gh ? entry.filename : entry.new_path, oldPath = gh ? entry.previous_filename : entry.old_path;
      if (typeof path !== "string" || !path) throw new Error("PR file is missing its path");
      const status = gh ? entry.status === "added" ? "A" : entry.status === "removed" ? "D" : entry.status === "renamed" ? "R" : "M" : entry.new_file ? "A" : entry.deleted_file ? "D" : entry.renamed_file ? "R" : "M";
      const before = status === "A" ? "" : await this.content(oldPath || path, base), after = status === "D" ? "" : await this.content(path, head);
      bytes += Buffer.byteLength(before) + Buffer.byteLength(after); if (bytes > 16 * 1024 * 1024) throw new Error("PR review snapshot exceeds 16 MiB");
      const binary = before.includes("\0") || after.includes("\0");
      const patch = gh ? entry.patch : entry.diff;
      files.push({ path, ...(oldPath && oldPath !== path ? { oldPath } : {}), status, binary, before: binary ? "" : before, after: binary ? "" : after, lines: binary ? [] : diffLines(patch || ""), ...(!binary && !patch ? { warning: "Provider omitted this patch; full file contents remain available" } : {}) });
    }
    const comments: ReviewSnapshot["comments"] = [], checks: ReviewSnapshot["checks"] = [];
    if (gh) {
      for (const row of await this.pages(`${prefix}/comments`)) comments.push({ path: row.path, line: row.line ?? row.original_line, side: row.side, body: row.body, author: row.user?.login, url: row.html_url });
      for (const row of await this.pages(`${this.root}/issues/${number}/comments`)) comments.push({ body: row.body, author: row.user?.login, url: row.html_url });
      for (const row of await this.pages(`${prefix}/reviews`)) if (row.body) comments.push({ body: row.body, author: row.user?.login, url: row.html_url });
      const runs = await this.wrappedPages(`${this.root}/commits/${encodeURIComponent(head)}/check-runs`, "check_runs");
      checks.push(...runs.map((r: any) => ({ name: r.name, state: r.conclusion || r.status })));
      const contexts = new Map<string, string>();
      for (const status of await this.pages(`${this.root}/commits/${encodeURIComponent(head)}/statuses`)) if (!contexts.has(status.context)) contexts.set(status.context, status.state);
      checks.push(...[...contexts].map(([name, state]) => ({ name, state })));
    } else {
      for (const discussion of await this.pages(`${prefix}/discussions`)) for (const row of discussion.notes ?? []) comments.push({ path: row.position?.new_path ?? row.position?.old_path, line: row.position?.new_line ?? row.position?.old_line, side: row.position?.new_line ? "RIGHT" : "LEFT", body: row.body, author: row.author?.username, url: row.url });
      for (const row of await this.pages(`${prefix}/pipelines`)) checks.push({ name: `Pipeline ${row.id}`, state: row.status });
    }
    return { id: crypto.randomUUID(), mode: "pr", cwd: this.cwd, base, head, files, comments, checks, semantic: await semanticDiff(files.filter((f) => !f.binary)), pr: { provider: this.repo.provider, project: this.repo.project, number, title: raw.title, state: raw.state, url: gh ? raw.html_url : raw.web_url, start: raw.diff_refs?.start_sha } };
  }
  async publish(snapshot: ReviewSnapshot, event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES", body: string, comments: ReviewComment[]) {
    const pr = snapshot.pr!;
    if (pr.provider !== this.repo.provider || pr.project !== this.repo.project) throw new Error("Repository changed; reload the review");
    const current = await this.detail(pr.number);
    if ((this.repo.provider === "github" ? current.head?.sha : current.diff_refs?.head_sha) !== snapshot.head || !["open", "opened"].includes(current.state)) throw new Error("PR changed or closed; reload and confirm the review again");
    const prefix = `${this.root}/${this.repo.provider === "github" ? "pulls" : "merge_requests"}/${pr.number}`;
    if (this.repo.provider === "github") {
      const inline: any[] = [], outside: ReviewComment[] = [];
      for (const comment of comments) {
        const file = snapshot.files.find((f) => f.path === comment.path)!;
        if (file.lines.some((l) => (comment.side === "old" ? l.oldLine : l.newLine) === comment.line)) inline.push({ path: comment.side === "old" ? file.oldPath ?? file.path : file.path, line: comment.line, side: comment.side === "old" ? "LEFT" : "RIGHT", body: comment.body });
        else outside.push(comment);
      }
      const text = [body, ...outside.map((c) => `${JSON.stringify(c.path)}:${c.line} (${c.side}):\n${c.body}`)].filter(Boolean).join("\n\n");
      return this.request(`${prefix}/reviews`, { commit_id: snapshot.head, event, body: text || "Reviewed in Rigwell.", ...(inline.length ? { comments: inline } : {}) });
    }
    let posted = 0;
    try {
      for (const comment of comments) {
        const file = snapshot.files.find((f) => f.path === comment.path)!;
        const inline = file.lines.some((l) => (comment.side === "old" ? l.oldLine : l.newLine) === comment.line);
        await this.request(`${prefix}/discussions`, { body: inline ? comment.body : `${JSON.stringify(comment.path)}:${comment.line} (${comment.side}):\n${comment.body}`, ...(inline ? { position: { position_type: "text", base_sha: snapshot.base, start_sha: pr.start ?? snapshot.base, head_sha: snapshot.head, old_path: file.oldPath ?? file.path, new_path: file.path, [comment.side === "old" ? "old_line" : "new_line"]: comment.line } } : {}) }); posted++;
      }
      if (body) { await this.request(`${prefix}/notes`, { body }); posted++; }
      if (event === "APPROVE") return await this.request(`${prefix}/approve`, { sha: snapshot.head });
      if (event === "REQUEST_CHANGES") {
        const result = await this.request("/graphql", { query: "mutation($project: ID!, $iid: String!) { mergeRequestRequestChanges(input: {projectPath: $project, iid: $iid}) { errors } }", variables: { project: pr.project, iid: String(pr.number) } });
        if (result.errors?.length || result.data?.mergeRequestRequestChanges?.errors?.length || !result.data?.mergeRequestRequestChanges) throw new Error("GitLab did not accept the requested-changes review");
        return result;
      }
      return { posted };
    } catch (error) { throw new Error(`${posted} comment(s) were posted; remaining review action failed. Check PR status before retrying. ${(error as Error).message}`); }
  }
}
