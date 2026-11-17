export interface TriggerEvent {
  id: string; kind: string; at: number; payload: unknown;
  reply?: { service: "github"; repo: string; issue: number } | { service: "github_commit"; repo: string; sha: string } | { service: "slack"; channel: string; thread: string };
  chain?: string[];
}
