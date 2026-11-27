// Copied from model-setup-kit d40de0a. Do not edit here; change the kit and copy again.
import * as React from "react";
/*
  Add an OpenAI-compatible connection. Copies the product's
  `custom-ai-connections.tsx` form: name, base URL, optional key, model id,
  Discover models and Test connection (with a confirmation).

  The form never keeps the key after a save: it calls `saveSecret(name, value)`,
  then `saveChoice({ kind: "connection", ..., apiKeySecretName })`, then clears
  the field. Nothing is thrown out of the component; errors are `role="alert"`.
*/

import { useId, useState, type FormEvent } from "react";

import type { ConnectionTestResult } from "../../../../../src/model-setup/core/connections.ts";
import type { ModelChoice, ModelSetupClient } from "../../../../../src/model-setup/client.ts";
import { formatCopy, type ModelSetupCopy } from "./copy.ts";
import { errorText } from "./helpers.ts";

export type AddConnectionFormProps = {
  client: ModelSetupClient;
  copy: ModelSetupCopy;
  onSaved?: (choice: ModelChoice) => void;
};

export function AddConnectionForm({ client, copy, onSaved }: AddConnectionFormProps) {
  const field = useId();
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [modelId, setModelId] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");

  const busy = saving || discovering || testing;

  async function save(event: FormEvent) {
    event.preventDefault();
    setError("");
    setResult("");
    if (!name.trim()) {
      setError(copy.connectionNameRequired);
      return;
    }
    if (!baseUrl.trim()) {
      setError(copy.connectionBaseUrlRequired);
      return;
    }
    if (!modelId.trim()) {
      setError(copy.connectionNeedModel);
      return;
    }
    setSaving(true);
    const secretName = name.trim();
    try {
      if (apiKey) await client.saveSecret(secretName, apiKey);
      const choice: ModelChoice = {
        kind: "connection",
        name: secretName,
        baseUrl: baseUrl.trim(),
        model: modelId.trim(),
        ...(apiKey ? { apiKeySecretName: secretName } : {}),
      };
      await client.saveChoice(choice);
      /* The key is gone from the form the moment the host has it. */
      setApiKey("");
      setResult(copy.connectionSaved);
      onSaved?.(choice);
    } catch (e) {
      setError(errorText(e, copy.connectionSaveFailed));
    } finally {
      setSaving(false);
    }
  }

  async function discover() {
    setError("");
    setResult("");
    setDiscovering(true);
    try {
      const found = await client.discoverModels({ baseUrl: baseUrl.trim(), ...(apiKey ? { apiKey } : {}) });
      setModels(found);
      setResult(found.length ? copy.connectionDiscovered : copy.connectionDiscoverEmpty);
    } catch (e) {
      setError(errorText(e, copy.connectionDiscoverEmpty));
    } finally {
      setDiscovering(false);
    }
  }

  async function test() {
    setError("");
    setResult("");
    if (!modelId.trim()) {
      setError(copy.connectionTestNoModel);
      return;
    }
    const ask = formatCopy(copy.connectionTestConfirm, { name: name.trim() || copy.connectionNameLabel });
    const confirmed = typeof globalThis.confirm === "function" ? globalThis.confirm(ask) : true;
    if (!confirmed) return;
    setTesting(true);
    try {
      const outcome: ConnectionTestResult = await client.testConnection({
        baseUrl: baseUrl.trim(),
        modelId: modelId.trim(),
        ...(apiKey ? { apiKey } : {}),
      });
      setResult(outcome.message);
    } catch (e) {
      setError(errorText(e, copy.connectionTestUnreachable));
    } finally {
      setTesting(false);
    }
  }

  return (
    <form className="msk-form" onSubmit={(event) => void save(event)}>
      <label className="msk-field" htmlFor={`${field}-name`}>
        <span className="msk-label">{copy.connectionNameLabel}</span>
        <input
          id={`${field}-name`}
          className="msk-input"
          required
          maxLength={80}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <span className="msk-meta">{copy.connectionNameHelp}</span>
      </label>

      <label className="msk-field" htmlFor={`${field}-base-url`}>
        <span className="msk-label">{copy.baseUrlLabel}</span>
        <input
          id={`${field}-base-url`}
          className="msk-input"
          required
          type="url"
          placeholder="http://127.0.0.1:4000/v1"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
        />
        <span className="msk-meta">
          {copy.baseUrlHelp} {copy.openaiCompatibleHelp}
        </span>
      </label>

      <label className="msk-field" htmlFor={`${field}-api-key`}>
        <span className="msk-label">{copy.apiKeyLabel}</span>
        <input
          id={`${field}-api-key`}
          className="msk-input"
          type="password"
          autoComplete="new-password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
        />
        <span className="msk-meta">
          {copy.apiKeyHelp} {copy.keyStoredHint}
        </span>
      </label>

      <label className="msk-field" htmlFor={`${field}-model-id`}>
        <span className="msk-label">{copy.modelIdLabel}</span>
        <input
          id={`${field}-model-id`}
          className="msk-input"
          value={modelId}
          onChange={(event) => setModelId(event.target.value)}
        />
        <span className="msk-meta">{copy.modelIdHelp}</span>
      </label>

      {models.length ? (
        <label className="msk-field" htmlFor={`${field}-discovered`}>
          <span className="msk-label">{copy.discoveredModelsLabel}</span>
          <select
            id={`${field}-discovered`}
            className="msk-input"
            value={modelId}
            onChange={(event) => setModelId(event.target.value)}
          >
            <option value="">{copy.chooseModel}</option>
            {models.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <div className="msk-actions">
        <button type="submit" className="msk-button" disabled={busy}>
          {saving ? copy.savingConnection : copy.saveConnection}
        </button>
        <button type="button" className="msk-button msk-quiet" disabled={busy} onClick={() => void discover()}>
          {discovering ? copy.discoveringModels : copy.discoverModels}
        </button>
        <button type="button" className="msk-button msk-quiet" disabled={busy} onClick={() => void test()}>
          {testing ? copy.testingConnection : copy.testConnection}
        </button>
      </div>

      {result ? (
        <p className="msk-ok" role="status">
          {result}
        </p>
      ) : null}
      {error ? (
        <p className="msk-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
