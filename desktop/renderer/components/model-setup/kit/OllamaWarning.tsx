// Copied from model-setup-kit d40de0a. Do not edit here; change the kit and copy again.
import * as React from "react";
/*
  The "Ollama is not running" warning. Copies the product's
  `ollama-warning.tsx`: it draws nothing while the answer is unknown and
  nothing while Ollama runs. A warning only; there is no Install button.
*/

import { useEffect, useRef, useState } from "react";

import type { OllamaStatusResult } from "../../../../../src/model-setup/core/ollama.ts";
import type { ModelSetupClient } from "../../../../../src/model-setup/client.ts";
import { formatCopy, type ModelSetupCopy } from "./copy.ts";
import { errorText } from "./helpers.ts";

export type OllamaWarningProps = {
  client: ModelSetupClient;
  copy: ModelSetupCopy;
  appName: string;
};

export function OllamaWarning({ client, copy, appName }: OllamaWarningProps) {
  const [status, setStatus] = useState<OllamaStatusResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    void (async () => {
      try {
        const next = await client.ollamaStatus();
        if (mounted.current) setStatus(next);
      } catch (e) {
        if (mounted.current) setError(errorText(e, copy.connectionsCheckFailed));
      }
    })();
    return () => {
      mounted.current = false;
    };
  }, [client, copy]);

  async function checkAgain() {
    setError("");
    setChecking(true);
    try {
      const next = await client.ollamaStatus();
      if (mounted.current) setStatus(next);
    } catch (e) {
      if (mounted.current) setError(errorText(e, copy.connectionsCheckFailed));
    } finally {
      if (mounted.current) setChecking(false);
    }
  }

  if (error) {
    return (
      <p className="msk-error" role="alert">
        {error}
      </p>
    );
  }
  if (!status || status.running) return null;

  return (
    <section className="msk-warning" data-msk-testid="ollama-warning" role="alert" aria-live="polite">
      <p>{formatCopy(copy.ollamaNotRunning, { appName })}</p>
      <button type="button" className="msk-button" disabled={checking} onClick={() => void checkAgain()}>
        {checking ? copy.checking : copy.checkAgain}
      </button>
    </section>
  );
}
