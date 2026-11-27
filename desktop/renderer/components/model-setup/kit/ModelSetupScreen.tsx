// Copied from model-setup-kit d40de0a. Do not edit here; change the kit and copy again.
import * as React from "react";
/*
  The Connections screen: subscription sign-ins, local servers, and one API
  connection form. Copies the product's connections tab and connection group.

  It takes a `client` and nothing else it cannot be given: no router, no query
  library, no global state. Every sentence is in `copy`; every pick is saved
  through `client.saveChoice`.
*/

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { CliProvider, CliStatusEntry } from "../../../../../src/model-setup/core/cli-signin.ts";
import type { LocalCatalog } from "../../../../../src/model-setup/core/local-discovery.ts";
import type { ModelChoice, ModelSetupClient } from "../../../../../src/model-setup/client.ts";
import { AddConnectionForm } from "./AddConnectionForm.tsx";
import { CliSignInCard } from "./CliSignInCard.tsx";
import { LocalModelsOnThisComputer } from "./LocalModelsOnThisComputer.tsx";
import { OllamaSignInCard } from "./OllamaSignInCard.tsx";
import { OllamaWarning } from "./OllamaWarning.tsx";
import { makeCopy, type CopyOverrides } from "./copy.ts";
import { errorText } from "./helpers.ts";

export type ModelSetupScreenProps = {
  client: ModelSetupClient;
  appName?: string;
  copy?: CopyOverrides;
  onSaved?: (choice: ModelChoice) => void;
};

const PROVIDERS: CliProvider[] = ["claude", "codex"];

export function ModelSetupScreen({ client, appName = "this app", copy: overrides, onSaved }: ModelSetupScreenProps) {
  const copy = useMemo(() => makeCopy(overrides), [overrides]);
  const [statuses, setStatuses] = useState<CliStatusEntry[]>([]);
  const [catalog, setCatalog] = useState<LocalCatalog | null>(null);
  const [saved, setSaved] = useState<ModelChoice[]>([]);
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const mounted = useRef(true);

  const read = useCallback(
    async (force: boolean) => {
      const [nextStatuses, nextCatalog, nextSaved] = await Promise.all([
        client.cliStatus(),
        client.catalog(force),
        client.listSaved(),
      ]);
      if (!mounted.current) return;
      setStatuses(nextStatuses);
      setCatalog(nextCatalog);
      setSaved(nextSaved);
    },
    [client],
  );

  useEffect(() => {
    mounted.current = true;
    void (async () => {
      try {
        await read(false);
      } catch (e) {
        if (mounted.current) setError(errorText(e, copy.loadFailed));
      }
    })();
    return () => {
      mounted.current = false;
    };
  }, [read, copy]);

  /*
    Mark the pick locally and tell the host. The host's own `listSaved` is read
    again on mount and on "Test all connections", so the mark survives a reload
    without a second read racing the save.
  */
  const remember = useCallback(
    (choice: ModelChoice) => {
      setSaved((prev) => [...prev.filter((item) => item.kind !== choice.kind), choice]);
      onSaved?.(choice);
    },
    [onSaved],
  );

  const refreshStatuses = useCallback(() => {
    void (async () => {
      try {
        const next = await client.cliStatus();
        if (mounted.current) setStatuses(next);
      } catch {
        /* the card shows its own error */
      }
    })();
  }, [client]);

  async function testAll() {
    setError("");
    setNote("");
    setChecking(true);
    try {
      await read(true);
      if (mounted.current) setNote(copy.connectionsChecked);
    } catch (e) {
      if (mounted.current) setError(errorText(e, copy.connectionsCheckFailed));
    } finally {
      if (mounted.current) setChecking(false);
    }
  }

  return (
    <div className="msk-screen">
      <div className="msk-screen-head">
        <button type="button" className="msk-button" disabled={checking} onClick={() => void testAll()}>
          {checking ? copy.checking : copy.testAll}
        </button>
        <p className="msk-meta">{copy.testAllConnectionsLine}</p>
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

      <ConnectionGroup title={copy.groupSignIns} note={copy.groupSignInsNote}>
        {PROVIDERS.map((provider) => (
          <CliSignInCard
            key={provider}
            client={client}
            provider={provider}
            copy={copy}
            status={statuses.find((entry) => entry.provider === provider)}
            saved={saved}
            onSaved={remember}
            onRefreshStatus={refreshStatuses}
          />
        ))}
        <OllamaSignInCard client={client} copy={copy} />
      </ConnectionGroup>

      <ConnectionGroup title={copy.groupLocal} note={copy.groupLocalNote}>
        <OllamaWarning client={client} copy={copy} appName={appName} />
        <LocalModelsOnThisComputer
          client={client}
          copy={copy}
          saved={saved}
          onSaved={remember}
          catalog={catalog}
          onCatalog={setCatalog}
        />
      </ConnectionGroup>

      <ConnectionGroup title={copy.groupConnection} note={copy.groupConnectionNote}>
        <AddConnectionForm client={client} copy={copy} onSaved={remember} />
      </ConnectionGroup>
    </div>
  );
}

function ConnectionGroup({
  title,
  note,
  children,
}: {
  title: string;
  note: string;
  children: ReactNode;
}) {
  return (
    <section role="group" aria-label={title} className="msk-group">
      <div className="msk-group-head">
        <h3 className="msk-group-title">{title}</h3>
        <span className="msk-meta">{note}</span>
      </div>
      <div className="msk-grid">{children}</div>
    </section>
  );
}
