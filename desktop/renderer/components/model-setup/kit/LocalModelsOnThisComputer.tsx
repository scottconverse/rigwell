// Copied from model-setup-kit d40de0a. Do not edit here; change the kit and copy again.
import * as React from "react";
/*
  Every local server and its models, with a "Use this one" pick on each. Copies
  the product's local-server list and its local-model box.

  The "Use whatever model is loaded" radio appears only when the host says it
  can store the sentinel (`client.supportsLoadedSentinel`). The screens never
  read a key or write anything except through the client.
*/

import { useEffect, useRef, useState } from "react";

import type { LocalCatalog } from "../../../../../src/model-setup/core/local-discovery.ts";
import { LOADED_SENTINEL } from "../../../../../src/model-setup/core/choice.ts";
import type { ModelChoice, ModelSetupClient } from "../../../../../src/model-setup/client.ts";
import { LocalServerCard } from "./LocalServerCard.tsx";
import type { ModelSetupCopy } from "./copy.ts";
import { errorText } from "./helpers.ts";

const CATALOG_REFRESH_MS = 60_000;

export type LocalModelsOnThisComputerProps = {
  client: ModelSetupClient;
  copy: ModelSetupCopy;
  saved?: ModelChoice[];
  onSaved?: (choice: ModelChoice) => void;
  /** The catalog the parent already read, so one screen reads it once. */
  catalog?: LocalCatalog | null;
  onCatalog?: (catalog: LocalCatalog) => void;
};

function isSentinelChoice(choice: ModelChoice | undefined): boolean {
  return choice?.kind === "local" && choice.baseUrl === LOADED_SENTINEL.baseUrl && choice.model === LOADED_SENTINEL.id;
}

export function LocalModelsOnThisComputer({
  client,
  copy,
  saved = [],
  onSaved,
  catalog: given,
  onCatalog,
}: LocalModelsOnThisComputerProps) {
  const [catalog, setCatalog] = useState<LocalCatalog | null>(given ?? null);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const [pending, setPending] = useState(false);
  const [choices, setChoices] = useState<ModelChoice[]>(saved);
  const mounted = useRef(true);

  useEffect(() => {
    setChoices(saved);
  }, [saved]);

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

  /* A slow background refresh, cleared on unmount. */
  useEffect(() => {
    if (given !== undefined) return;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const next = await client.catalog(true);
          if (mounted.current) {
            setCatalog(next);
            onCatalog?.(next);
          }
        } catch {
          /* a background refresh says nothing */
        }
      })();
    }, CATALOG_REFRESH_MS);
    return () => clearInterval(timer);
  }, [given, client, onCatalog]);

  async function refresh() {
    setError("");
    setNote("");
    setChecking(true);
    try {
      const next = await client.catalog(true);
      if (!mounted.current) return;
      setCatalog(next);
      onCatalog?.(next);
      setNote(next.servers.some((server) => server.reachable) ? copy.localListRefreshed : copy.noLocalServer);
    } catch (e) {
      if (mounted.current) setError(errorText(e, copy.connectionsCheckFailed));
    } finally {
      if (mounted.current) setChecking(false);
    }
  }

  async function save(choice: ModelChoice) {
    setError("");
    setNote("");
    setPending(true);
    try {
      await client.saveChoice(choice);
      if (!mounted.current) return;
      setChoices((prev) => [...prev.filter((item) => item.kind !== "local"), choice]);
      setNote(copy.localPickSaved);
      onSaved?.(choice);
    } catch (e) {
      if (mounted.current) setError(errorText(e, copy.localPickSaveFailed));
    } finally {
      if (mounted.current) setPending(false);
    }
  }

  const savedLocal = choices.find((choice): choice is Extract<ModelChoice, { kind: "local" }> => choice.kind === "local");
  const sentinel = isSentinelChoice(savedLocal);
  const chosen =
    savedLocal && !sentinel ? { baseUrl: savedLocal.baseUrl, model: savedLocal.model } : null;

  if (catalog === null && !error) return null;

  return (
    <div className="msk-panel">
      <div className="msk-panel-head">
        <h4 className="msk-panel-title">{copy.localModelsTitle}</h4>
        <button type="button" className="msk-button msk-quiet" disabled={checking} onClick={() => void refresh()}>
          {checking ? copy.checking : copy.refresh}
        </button>
      </div>

      {client.supportsLoadedSentinel ? (
        <label className="msk-radio">
          <input
            type="radio"
            name="msk-loaded-sentinel"
            checked={sentinel}
            onChange={() => void save({ kind: "local", baseUrl: LOADED_SENTINEL.baseUrl, model: LOADED_SENTINEL.id })}
          />{" "}
          {copy.useLoadedRecommended}
        </label>
      ) : null}

      {chosen ? <p className="msk-meta">{copy.loadedChoiceNamed}</p> : null}

      {catalog && catalog.servers.length === 0 ? <p className="msk-meta">{copy.noLocalServer}</p> : null}

      <div className="msk-grid">
        {catalog?.servers.map((server) => (
          <LocalServerCard
            key={`${server.kind}-${server.baseUrl}`}
            server={server}
            copy={copy}
            chosen={chosen}
            pending={pending}
            onPick={(model) =>
              void save({ kind: "local", baseUrl: server.baseUrl, model, displayName: model })
            }
          />
        ))}
      </div>

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
    </div>
  );
}
