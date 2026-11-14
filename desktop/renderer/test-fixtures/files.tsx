import React from "react";
import { createRoot } from "react-dom/client";
import { FilesTab } from "../components/FilesTab.tsx";
import { RpcFailure } from "../lib/rpc.ts";
const ctl = { getSnapshot: () => ({ cwd: "/fixture" }), async request(method: string, params: any) {
  const response = await fetch("/rpc", { method: "POST", body: JSON.stringify({ method, params }) });
  const result = await response.json();
  if (result.error) throw new RpcFailure(result.error.code, result.error.message);
  return result;
} } as any;
createRoot(document.getElementById("root")!).render(<FilesTab ctl={ctl} autoOpen={false} refreshKey={0} />);
