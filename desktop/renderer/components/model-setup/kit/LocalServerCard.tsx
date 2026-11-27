// Copied from model-setup-kit d40de0a. Do not edit here; change the kit and copy again.
import * as React from "react";
/*
  One local, OpenAI-compatible server and the models it reports. Copies
  The product's `LocalServerCard`: 5 models shown, "Show all N", a cloud model
  as a plain line (it never runs here and cannot be picked), and a "Use this
  one" button that saves the pick through the client.
*/

import { useState } from "react";

import type { LocalModel, LocalServer } from "../../../../../src/model-setup/core/local-discovery.ts";
import { formatCopy, type ModelSetupCopy } from "./copy.ts";
import {
  SERVER_KIND_LABEL,
  hostOf,
  isLoopbackUrl,
  originOf,
  visibleModels,
} from "./helpers.ts";

const VISIBLE_MODELS = 5;

export type LocalServerCardProps = {
  server: LocalServer;
  copy: ModelSetupCopy;
  chosen?: { baseUrl: string; model: string } | null;
  pending?: boolean;
  onPick?: (model: string) => void;
};

export function LocalServerCard({ server, copy, chosen, pending, onPick }: LocalServerCardProps) {
  const [showAll, setShowAll] = useState(false);
  const kindLabel = SERVER_KIND_LABEL[server.kind] ?? server.kind;
  const inMemory = server.models.filter((model) => model.loaded === true && !model.cloud).length;
  const chosenId =
    chosen && chosen.baseUrl === server.baseUrl ? chosen.model : undefined;
  const shown = showAll
    ? server.models
    : visibleModels(server.models, VISIBLE_MODELS, chosenId);

  return (
    <article className="msk-card msk-server">
      <div className="msk-card-head">
        <h5 className="msk-card-title">
          {kindLabel} · {isLoopbackUrl(server.baseUrl) ? copy.thisMachine : copy.remote}
        </h5>
        <span className="msk-chip">
          {!server.reachable ? copy.couldNotReach : inMemory ? copy.ready : copy.running}
        </span>
      </div>

      <p className="msk-meta msk-break">
        {hostOf(server.baseUrl)}
        {server.reachable
          ? inMemory
            ? ` · ${formatCopy(copy.inMemoryCount, { count: inMemory })}`
            : ` · ${copy.nothingInMemory}`
          : ` · ${copy.notReachable}`}
      </p>

      {server.reachable ? (
        <p className="msk-line">{inMemory ? copy.ready : copy.runningNoModel}</p>
      ) : null}

      {server.reachable ? (
        <a
          className="msk-link"
          href={originOf(server.baseUrl)}
          target="_blank"
          rel="noreferrer noopener"
          title={`${originOf(server.baseUrl)}`}
        >
          {formatCopy(copy.openServerLink, { name: kindLabel })}
        </a>
      ) : null}

      {server.models.length === 0 ? (
        <p className="msk-meta">
          {server.reachable ? copy.noChatModelsOnServer : copy.nothingToList}
        </p>
      ) : (
        <ul className="msk-model-list">
          {shown.map((model) => (
            <li key={model.id} className="msk-model-row" role="group" aria-label={`${model.id} on ${kindLabel}`}>
              <span className="msk-model-name msk-break">{model.id}</span>
              {model.cloud ? (
                <span className="msk-meta">{copy.cloudSpendsCredits}</span>
              ) : chosenId === model.id ? (
                <strong className="msk-badge">{copy.appUsesThis}</strong>
              ) : null}
              {!model.cloud && onPick ? (
                <button
                  type="button"
                  className="msk-button msk-quiet"
                  disabled={pending}
                  onClick={() => onPick(model.id)}
                >
                  {copy.useThisOne}
                </button>
              ) : null}
              <span className="msk-meta">{metaLine(model, copy)}</span>
            </li>
          ))}
        </ul>
      )}

      {server.models.length > VISIBLE_MODELS ? (
        <button type="button" className="msk-button msk-quiet" onClick={() => setShowAll(!showAll)}>
          {showAll ? copy.showFewer : formatCopy(copy.showAll, { count: server.models.length })}
        </button>
      ) : null}
    </article>
  );
}

function metaLine(model: LocalModel, copy: ModelSetupCopy): string {
  const parts: string[] = [
    model.loaded === null ? copy.loadedStateUnknown : model.loaded ? copy.inMemoryWord : copy.notLoadedWord,
  ];
  if (model.contextLength) {
    parts.push(formatCopy(copy.contextLine, { count: Math.round(model.contextLength / 1024) }));
  }
  if (model.vision) parts.push(copy.readsImages);
  if (model.thinking) parts.push(copy.thinksByDefault);
  return parts.join(" · ");
}
