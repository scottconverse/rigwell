// Copied from model-setup-kit d40de0a. Do not edit here; change the kit and copy again.
import * as React from "react";
/*
  The optional `ollama signin` card. Copies the product's
  `ollama-signin-card.tsx`: no code, no countdown, a 2-second poll.
*/

import { useEffect, useRef, useState } from "react";

import type { OllamaSignInState } from "../../../../../src/model-setup/core/ollama.ts";
import type { ModelSetupClient } from "../../../../../src/model-setup/client.ts";
import type { ModelSetupCopy } from "./copy.ts";
import { errorText } from "./helpers.ts";

const POLL_MS = 2_000;

export type OllamaSignInCardProps = {
  client: ModelSetupClient;
  copy: ModelSetupCopy;
};

export function OllamaSignInCard({ client, copy }: OllamaSignInCardProps) {
  const [row, setRow] = useState<OllamaSignInState | null>(null);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const open = row?.status === "starting" || row?.status === "awaiting_user";

  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const next = await client.ollamaSignInPoll();
          if (next && mounted.current) setRow(next);
        } catch (e) {
          if (mounted.current) setError(errorText(e, copy.connectionsCheckFailed));
        }
      })();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [open, client, copy]);

  async function start() {
    setError("");
    setStarting(true);
    try {
      const next = await client.ollamaSignInStart();
      if (mounted.current) setRow(next);
    } catch {
      if (mounted.current) {
        setRow({ status: "failed", url: null, detail: copy.ollamaStartFailed, pid: null });
      }
    } finally {
      if (mounted.current) setStarting(false);
    }
  }

  async function cancel() {
    setError("");
    setStopping(true);
    try {
      const next = await client.ollamaSignInCancel();
      if (mounted.current) setRow(next);
    } catch (e) {
      if (mounted.current) setError(errorText(e, copy.signInStopFailed));
    } finally {
      if (mounted.current) setStopping(false);
    }
  }

  return (
    <li className="msk-card" data-msk-testid="ollama-signin">
      <div className="msk-card-head">
        <h4 className="msk-card-title">Ollama</h4>
        {!open && row?.status !== "done" ? (
          <button type="button" className="msk-button" disabled={starting} onClick={() => void start()}>
            {starting ? copy.signInStarting : copy.ollamaSignInLabel}
          </button>
        ) : null}
      </div>

      <p className="msk-line">
        {row?.status === "done"
          ? copy.ollamaSignedIn
          : row?.status === "no-signin"
            ? copy.ollamaNoSignin
            : copy.ollamaOptional}
      </p>

      {open && row?.url ? (
        <div className="msk-open">
          <p className="msk-small">{copy.ollamaSignInLinkLine}</p>
          <p className="msk-line">
            <a className="msk-link msk-break" href={row.url} target="_blank" rel="noreferrer noopener">
              {row.url}
            </a>
          </p>
          <button type="button" className="msk-button msk-quiet" disabled={stopping} onClick={() => void cancel()}>
            {stopping ? copy.signInStopping : copy.signInCancel}
          </button>
        </div>
      ) : null}

      {open && !row?.url ? <p className="msk-meta">{copy.ollamaWaiting}</p> : null}

      {row?.detail && !open && row.status !== "no-signin" ? (
        <p className="msk-error" role="alert">
          {row.detail}
        </p>
      ) : null}

      {error ? (
        <p className="msk-error" role="alert">
          {error}
        </p>
      ) : null}
    </li>
  );
}
