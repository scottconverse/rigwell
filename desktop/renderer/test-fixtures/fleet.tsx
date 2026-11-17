import React from "react";
import { createRoot } from "react-dom/client";
import { FleetMachines } from "../components/Machines.tsx";
import { app } from "../lib/app-model.ts";
app.request = async (method, params) => {
  const response = await fetch("/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method, params }) });
  const value = await response.json(); if (value.error) throw new Error(value.error); return value.result;
};
createRoot(document.getElementById("root")!).render(<FleetMachines />);
