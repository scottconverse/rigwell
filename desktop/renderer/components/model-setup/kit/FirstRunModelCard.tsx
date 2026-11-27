// Copied from model-setup-kit d40de0a. Do not edit here; change the kit and copy again.
import * as React from "react";
/*
  "Choose your writing model" for a first run. Copies the product's
  `FirstRunModelCard`, minus "Keep the Automatic ladder" (cut in the design).

  It draws only when the catalog says a server answers and nothing is loaded
  (`firstRunPlan` -> "offered"). A cloud model is a plain line, never a button.
*/

import { useEffect, useRef, useState } from "react";

import type { LocalCatalog, LocalModel } from "../../../../../src/model-setup/core/local-discovery.ts";
import { firstRunPlan } from "../../../../../src/model-setup/core/choice.ts";
import type { ModelChoice, ModelSetupClient } from "../../../../../src/model-setup/client.ts";
import { formatCopy, type ModelSetupCopy } from "./copy.ts";
import { SERVER_KIND_LABEL, errorText } from "./helpers.ts";

export type FirstRunModelCardProps = {
  client: ModelSetupClient;
  copy: ModelSetupCopy;
  appName?: string;
  onSaved?: (choice: ModelChoice) => void;
  catalog?: LocalCatalog | null;
  onCatalog?: (catalog: LocalCatalog) => void;
};

export function FirstRunModelCard({
  client,
  copy,
  appName = "this app",
  onSaved,
  catalog: given,
  onCatalog,
}: FirstRunModelCardProps) {
  const [catalog, setCatalog] = useState<LocalCatalog | null>(given ?? null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    if (given !== undefined) setCatalog(given);
  }, [given]);

  useEffect(() => {
    mounted.current = true;
    if (given === undefined) {
      void (async () => {
        try {
          const next = await client.catalog();
          if (mounted.current) {
            setCatalog(next);
            onCatalog?.(next);
          }
        } catch (e) {
          if (mounted.current) setError(errorText(e, copy.loadFailed));
        }
      })();
    }
    return () => {
      mounted.current = false;
    };
  }, [given, client, copy, onCatalog]);

  async function refresh() {
    setError("");
    setNote("");
    try {
      const next = await client.catalog(true);
      if (!mounted.current) return;
      setCatalog(next);
      onCatalog?.(next);
      setNote(next.servers.some((server) => server.reachable) ? copy.localListRefreshed : copy.noLocalServer);
    } catch (e) {
      if (mounted.current) setError(errorText(e, copy.connectionsCheckFailed));
    }
  }

  async function pick(baseUrl: string, model: LocalModel) {
    setError("");
    setNote("");
    setPending(true);
    const choice: ModelChoice = { kind: "local", baseUrl, model: model.id, displayName: model.id };
    try {
      await client.saveChoice(choice);
      if (mounted.current) {
        setNote(copy.localPickSaved);
        onSaved?.(choice);
      }
    } catch (e) {
      if (mounted.current) setError(errorText(e, copy.localPickSaveFailed));
    } finally {
      if (mounted.current) setPending(false);
    }
  }

  if (!catalog || firstRunPlan(catalog).plan !== "offered") return null;

  const servers = catalog.servers.filter((server) => server.reachable);
  return (
    <section className="msk-panel msk-hot" data-msk-testid="first-run-model-card">
      <h4 className="msk-panel-title">{copy.firstRunCardTitle}</h4>
      <p className="msk-meta">{formatCopy(copy.firstRunCardNote, { appName })}</p>

      {servers.length === 0 ? (
        <p className="msk-meta">{copy.firstRunNoServer}</p>
      ) : (
        servers.map((server) => (
          <div key={server.baseUrl} className="msk-server-row">
            <p className="msk-meta msk-break">
              {SERVER_KIND_LABEL[server.kind]} · {server.baseUrl}
            </p>
            <ul className="msk-model-list">
              {server.models.map((model) =>
                model.cloud ? (
                  <li key={model.id} className="msk-meta">
                    {model.id} · {copy.cloudSpendsCredits}
                  </li>
                ) : (
                  <li key={model.id}>
                    <button
                      type="button"
                      className="msk-button msk-quiet"
                      disabled={pending}
                      onClick={() => void pick(server.baseUrl, model)}
                    >
                      {copy.useThisOne}
                    </button>{" "}
                    <span className="msk-break">{model.id}</span>
                  </li>
                ),
              )}
            </ul>
          </div>
        ))
      )}

      <button type="button" className="msk-button msk-quiet" onClick={() => void refresh()}>
        {copy.refresh}
      </button>

      {note ? (
        <p className="msk-meta" role="status">
          {note}
        </p>
      ) : null}
      {error ? (
        <p className="msk-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
