import React from "react";
import { createRoot } from "react-dom/client";
import { WorktreePr } from "../components/WorktreePr.tsx";

let deliver: (value: any) => void;
let next = 0, creation: { connId: number; id: string };
let status: any = { state: "none", checks: [] };
const fixture = (window as any).fixture = { pushes: 0, requests: [] as any[] };
(window as any).rigwell = { daemon: {
  onMessage(fn: any) { deliver = fn; }, onClosed() {}, async open() { return ++next; }, async close() {},
  async sendMessage(connId: number, line: string) {
    const m = JSON.parse(line); fixture.requests.push(m);
    const send = (v: any) => queueMicrotask(() => deliver({ connId, message: JSON.stringify({ jsonrpc: "2.0", ...v }) }));
    if (m.type === "response") {
      if (m.result.selectedOption === "proceed_once") {
        fixture.pushes++;
        status = { state: "open", number: 7, url: "https://github.com/owner/repo/pull/7", checks: [{ name: "test", state: "pending" }] };
        send({ type: "response", id: creation.id, result: status });
      } else send({ type: "response", id: creation.id, error: { code: -32800, message: "PR creation cancelled; nothing was pushed" } });
      return;
    }
    if (m.method === "rigwell.get_pr_status") send({ type: "response", id: m.id, result: status });
    if (m.method === "rigwell.create_pr") {
      creation = { connId, id: m.id };
      send({ type: "request", id: "approval", method: "rigwell.request_permission", params: {
        toolUses: [{ confirmationType: "create_pr", details: { branch: "feature", repository: "github.com/owner/repo", ...m.params } }],
        options: [{ label: "Push branch and create PR", value: "proceed_once" }, { label: "Cancel", value: "cancel" }],
      } });
    }
  },
} };
createRoot(document.getElementById("root")!).render(<WorktreePr worktreePath="fixture" branch="feature" />);
