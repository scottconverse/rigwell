import React from "react";
import { createRoot } from "react-dom/client";
import { CodeProviders } from "../components/CodeProviders.tsx";

const request = async (method: string, params: Record<string, unknown> = {}) => {
  const response = await fetch("/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method, params }) });
  const data = await response.json(); if (data.error) throw new Error(data.error.message); return data.result;
};
createRoot(document.getElementById("root")!).render(<CodeProviders request={request} />);
