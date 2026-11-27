// Copied from model-setup-kit 869cdf5. Do not edit here; change the kit and copy again.
import * as React from "react";
/*
  One command-line sign-in: whether the program is installed and signed in,
  the link and one-time code while a sign-in is open, a countdown, Cancel and
  Test. Copies the product's `provider-status-card.tsx`.

  Words come from `copy`. The card never throws: every client call is caught
  and shown in a `role="alert"` line.
*/

import { useEffect, useRef, useState } from "react";

import type { CliAttempt, CliProvider, CliStatusEntry } from "../../../../../src/model-setup/core/cli-signin.ts";
import { PROVIDER_LABEL } from "../../../../../src/model-setup/core/cli-signin.ts";
import type { CliTestResult, ModelChoice, ModelSetupClient } from "../../../../../src/model-setup/client.ts";
import { formatCopy, type ModelSetupCopy } from "./copy.ts";
import { countdownText, errorText, visibleModels } from "./helpers.ts";

const POLL_MS = 3_000;
const VISIBLE_MODELS = 5;

/* Some programs report the account as the words "signed in"; show the plain
   word once instead of "Signed in as signed in". */
function sameAsSignedIn(account: string, signedInWord: string): boolean {
  return account.trim().toLowerCase() === signedInWord.trim().toLowerCase();
}

export type CliSignInCardProps = {
  client: ModelSetupClient;
  provider: CliProvider;
  copy: ModelSetupCopy;
  status?: CliStatusEntry;
  saved?: ModelChoice[];
  onSaved?: (choice: ModelChoice) => void;
  onRefreshStatus?: () => void;
};

export function CliSignInCard({
  client,
  provider,
  copy,
  status,
  saved = [],
  onSaved,
  onRefreshStatus,
}: CliSignInCardProps) {
  const name = status?.name || PROVIDER_LABEL[provider];
  const [current, setCurrent] = useState<CliStatusEntry | undefined>(status);
  const [attempt, setAttempt] = useState<CliAttempt | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [testResult, setTestResult] = useState<CliTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [manualModel, setManualModel] = useState("");
  const manualId = React.useId();
  const [showAll, setShowAll] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const mounted = useRef(true);

  useEffect(() => {
    setCurrent(status);
  }, [status]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const open = attempt?.status === "awaiting_user" || attempt?.status === "starting";

  /* Poll while a sign-in is open, and refresh the status when it finishes. */
  useEffect(() => {
    if (!attempt || !open) return;
    const id = attempt.id;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const next = await client.cliPoll(id);
          if (!mounted.current) return;
          if (next) {
            setAttempt(next);
            if (next.status === "done") {
              onRefreshStatus?.();
              try {
                const statuses = await client.cliStatus();
                const mine = statuses.find((entry) => entry.provider === provider);
                if (mine && mounted.current) setCurrent(mine);
              } catch {
                /* the poll's `done` is enough */
              }
            }
          }
        } catch (e) {
          if (mounted.current) setError(errorText(e, copy.connectionsCheckFailed));
        }
      })();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [attempt?.id, open, client, provider, copy, onRefreshStatus]);

  /* A one-second local tick so the countdown moves between polls. */
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [open]);

  /* The models this sign-in brings, only once signed in. */
  const signedIn = Boolean(current?.signedIn) || attempt?.status === "done";
  useEffect(() => {
    if (!signedIn) {
      setModels([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const ids = await client.listCliModels(provider);
        if (!cancelled) setModels(ids);
      } catch (e) {
        if (!cancelled) setError(errorText(e, copy.connectionsCheckFailed));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [signedIn, client, provider, copy]);

  async function start() {
    setError("");
    setStarting(true);
    try {
      const next = await client.cliStart(provider);
      if (mounted.current) setAttempt(next);
    } catch (e) {
      if (mounted.current) setError(errorText(e, copy.signInStartFailed));
    } finally {
      if (mounted.current) setStarting(false);
    }
  }

  async function cancel() {
    if (!attempt) return;
    setError("");
    setStopping(true);
    try {
      const next = await client.cliCancel(attempt.id);
      if (!mounted.current) return;
      setAttempt(next);
      onRefreshStatus?.();
    } catch (e) {
      if (mounted.current) setError(errorText(e, copy.signInStopFailed));
    } finally {
      if (mounted.current) setStopping(false);
    }
  }

  async function test() {
    setError("");
    setTestResult(null);
    if (!client.cliTest) {
      setError(copy.testNotAvailable);
      return;
    }
    setTesting(true);
    try {
      const result = await client.cliTest(provider);
      if (mounted.current) setTestResult(result);
    } catch (e) {
      if (mounted.current) setError(errorText(e, copy.signInStartFailed));
    } finally {
      if (mounted.current) setTesting(false);
    }
  }

  async function pick(model: string) {
    setError("");
    const choice: ModelChoice = { kind: "cli", provider, model };
    try {
      await client.saveChoice(choice);
      onSaved?.(choice);
    } catch (e) {
      setError(errorText(e, copy.connectionSaveFailed));
    }
  }

  const chosenModel = saved.find((choice) => choice.kind === "cli" && choice.provider === provider);
  const left = attempt ? Math.max(0, attempt.expiresInSeconds - Math.round((now - attempt.startedAt) / 1000)) : 0;
  const shown = showAll ? models : visibleModels(models.map((id) => ({ id })), VISIBLE_MODELS, chosenModel?.model).map((row) => row.id);

  return (
    <li className="msk-card" data-provider={provider}>
      <div className="msk-card-head">
        <h4 className="msk-card-title">{name}</h4>
        <span className="msk-acts">
          {current?.installed && !signedIn && !open ? (
            <button type="button" className="msk-button" disabled={starting} onClick={() => void start()}>
              {starting ? copy.signInStarting : formatCopy(copy.signInButton, { name })}
            </button>
          ) : null}
          {signedIn ? (
            <button type="button" className="msk-button msk-quiet" disabled={testing} onClick={() => void test()}>
              {testing ? copy.testingButton : copy.testButton}
            </button>
          ) : null}
        </span>
      </div>

      <p className="msk-line">
        <span className="msk-kicker">{current?.installed ? copy.installedWord : copy.notInstalledWord}</span>{" "}
        <span>
          {!current?.installed
            ? formatCopy(copy.signInNotInstalled, { name })
            : signedIn
              ? current?.account && !sameAsSignedIn(current.account, copy.signedInWord)
                ? formatCopy(copy.signedInAs, { account: current.account })
                : copy.signedInWord
              : copy.notSignedInWord}
        </span>
      </p>
      {current?.path ? <p className="msk-meta msk-break">{current.path}</p> : null}
      {current?.detail && !open ? <p className="msk-meta">{current.detail}</p> : null}

      {open ? (
        <div className="msk-open">
          {attempt?.url ? (
            <>
              <p className="msk-small">{copy.signInOpenLink}</p>
              <p className="msk-line">
                <a className="msk-link msk-break" href={attempt.url} target="_blank" rel="noreferrer noopener">
                  {attempt.url}
                </a>
              </p>
            </>
          ) : (
            <p className="msk-small">{formatCopy(copy.signInWaitingForLink, { name })}</p>
          )}
          {attempt?.code ? (
            <div className="msk-code">
              <p className="msk-kicker">{copy.signInEnterCode}</p>
              <p className="msk-code-value" data-msk-signin-code>
                {attempt.code}
              </p>
              <button
                type="button"
                className="msk-button msk-quiet"
                aria-label={copy.signInCopyCode}
                onClick={() => {
                  const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
                  void clipboard?.writeText(attempt.code ?? "").then(() => setCopied(true));
                }}
              >
                {copied ? copy.signInCopied : copy.signInCopyCode}
              </button>
            </div>
          ) : null}
          <p className="msk-meta">
            {left > 0
              ? formatCopy(copy.signInExpiresIn, { time: countdownText(left) })
              : copy.signInExpired}
          </p>
          <button type="button" className="msk-button msk-quiet" disabled={stopping} onClick={() => void cancel()}>
            {stopping ? copy.signInStopping : copy.signInCancel}
          </button>
        </div>
      ) : null}

      {attempt && !open && attempt.status !== "done" && attempt.detail ? (
        <p className="msk-error" role="alert">
          {attempt.detail}
        </p>
      ) : null}

      {attempt?.status === "done" ? <p className="msk-ok">{formatCopy(copy.signInDone, { name })}</p> : null}

      {testResult ? (
        <p className={testResult.ok ? "msk-ok" : "msk-error"}>
          {testResult.ok
            ? formatCopy(copy.testAnswered, { name, detail: testResult.detail })
            : formatCopy(copy.testDidNotAnswer, { name, detail: testResult.detail })}
        </p>
      ) : null}

      {signedIn ? (
        <div className="msk-models">
          {models.length ? (
            <>
              <p className="msk-kicker">{copy.signInModels}</p>
              <ul className="msk-model-list">
                {shown.map((id) => (
                  <li key={id} className="msk-model-row">
                    <span className="msk-break">{id}</span>
                    {chosenModel?.model === id ? <strong className="msk-badge">{copy.appUsesThis}</strong> : null}
                    <button type="button" className="msk-button msk-quiet" onClick={() => void pick(id)}>
                      {copy.useThisOne}
                    </button>
                  </li>
                ))}
              </ul>
              {models.length > VISIBLE_MODELS ? (
                <button type="button" className="msk-button msk-quiet" onClick={() => setShowAll(!showAll)}>
                  {showAll ? copy.showFewer : formatCopy(copy.showAll, { count: models.length })}
                </button>
              ) : null}
            </>
          ) : null}
          <div className="msk-field">
            <label className="msk-label" htmlFor={manualId}>
              {models.length ? copy.otherModel : copy.modelNameLabel}
            </label>
            <input
              id={manualId}
              className="msk-input"
              value={manualModel}
              onChange={(event) => setManualModel(event.target.value)}
            />
            <span className="msk-meta">{copy.modelNameHelp}</span>
            <button
              type="button"
              className="msk-button"
              disabled={!manualModel.trim()}
              onClick={() => void pick(manualModel.trim())}
            >
              {copy.useThisModel}
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p className="msk-error" role="alert">
          {error}
        </p>
      ) : null}
    </li>
  );
}
