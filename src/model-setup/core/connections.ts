// Copied from model-setup-kit d40de0a. Do not edit here; change the kit and copy again.
/*
  Custom OpenAI-compatible connections: input rules, model discovery and the
  explicit Test call. Timeouts, prompt and response excerpt copy the product
  this kit was extracted from. The API key never appears in a result.
*/

import { defaultFetch, joinEndpoint, withTimeout, type FetchLike } from "./util.ts";

export type ConnectionInput = {
  name: string;
  baseUrl: string;
  apiKey?: string;
  modelId?: string;
};

export type NormalizedConnection = {
  name: string;
  baseUrl: string;
  apiKey?: string;
  modelId?: string;
};

export function normalizeConnection(input: ConnectionInput): NormalizedConnection {
  const name = input.name.trim();
  if (!name || name.length > 80) throw new Error("Connection name must be 1 to 80 characters.");
  let url: URL;
  try {
    url = new URL(input.baseUrl.trim());
  } catch {
    throw new Error("Base URL must be a valid HTTP or HTTPS URL.");
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error("Base URL must use HTTP or HTTPS.");
  if (url.username || url.password) throw new Error("Base URL must not include credentials.");
  if (url.search || url.hash) throw new Error("Base URL must not include a query or fragment.");
  const baseUrl = url.toString().replace(/\/$/, "");
  const apiKey = input.apiKey?.trim() || undefined;
  const modelId = input.modelId?.trim() || undefined;
  if (apiKey && apiKey.length > 4096) throw new Error("API key is too long.");
  if (modelId && modelId.length > 200) throw new Error("Model id is too long.");
  return { name, baseUrl, apiKey, modelId };
}

/** The model ids a server lists under `GET <baseUrl>/models`. */
export async function discoverModels(
  connection: Pick<NormalizedConnection, "baseUrl" | "apiKey">,
  options: { fetchFn?: FetchLike } = {},
): Promise<string[]> {
  const fetchFn = options.fetchFn ?? defaultFetch;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (connection.apiKey) headers.Authorization = `Bearer ${connection.apiKey}`;
  const response = await withTimeout(
    fetchFn(joinEndpoint(connection.baseUrl, "models"), { headers }),
    10_000,
  );
  if (!response.ok) {
    const detail = await providerResponseDetail(response, connection.apiKey);
    throw new Error(`${safeError(response.status)}${detail ? `\n\n${detail}` : ""}`);
  }
  return parseDiscoveredModels(await response.json());
}

export type TestedCapabilities = {
  chatCompletions: boolean;
  responses: boolean | null;
  modelDiscovery: boolean | null;
};

export type ConnectionTestResult = {
  ok: boolean;
  message: string;
  capabilities: TestedCapabilities;
  latencyMs: number;
};

/** Explicitly invoked only. It sends one short prompt and never includes the key. */
export async function testConnection(
  connection: Pick<NormalizedConnection, "baseUrl" | "modelId" | "apiKey">,
  options: { fetchFn?: FetchLike } = {},
): Promise<ConnectionTestResult> {
  const fetchFn = options.fetchFn ?? defaultFetch;
  if (!connection.modelId) {
    return {
      ok: false,
      message: "Choose or enter a model before testing.",
      capabilities: inferCapabilities(null),
      latencyMs: 0,
    };
  }
  const started = Date.now();
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (connection.apiKey) headers.Authorization = `Bearer ${connection.apiKey}`;
  try {
    const response = await withTimeout(
      fetchFn(joinEndpoint(connection.baseUrl, "chat/completions"), {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: connection.modelId,
          messages: [
            { role: "user", content: "In one sentence, explain why a town publishes meeting minutes." },
          ],
          max_tokens: 128,
        }),
      }),
      20_000,
    );
    if (!response.ok) {
      const detail = await providerResponseDetail(response, connection.apiKey);
      return {
        ok: false,
        message: `${safeError(response.status)}${detail ? `\n\n${detail}` : ""}`,
        capabilities: inferCapabilities(null),
        latencyMs: Date.now() - started,
      };
    }
    const body = await response.json();
    const capabilities = inferCapabilities(body);
    const answered = hasAssistantText(body);
    const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const reportedModel = typeof record.model === "string" ? record.model : "not reported";
    const choices = Array.isArray(record.choices) ? (record.choices as unknown[]) : [];
    const content =
      choices
        .map((choice) =>
          choice && typeof choice === "object"
            ? (choice as { message?: { content?: unknown } }).message?.content
            : undefined,
        )
        .find((value): value is string => typeof value === "string" && value.trim().length > 0) ?? "";
    const redact = (value: string) =>
      connection.apiKey ? value.replaceAll(connection.apiKey, "[redacted]") : value;
    const excerpt = redact(String(content)).replace(/\s+/g, " ").trim().slice(0, 300);
    const identityNote =
      reportedModel !== "not reported" && reportedModel !== connection.modelId
        ? " Returned ID differs; it may be an alias or a different model."
        : "";
    return {
      ok: answered,
      message: answered
        ? "Connection succeeded; chat completions are available. " +
          "Instruction compliance, model identity, and tools are not independently verified. " +
          `Requested: ${redact(connection.modelId)}. Reported: ${redact(reportedModel)}.${identityNote} Response: ${excerpt}`
        : "The server replied, but did not return assistant text.",
      capabilities,
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    const message =
      error instanceof Error && error.message === "timed out"
        ? "Connection test timed out."
        : "Could not reach the server.";
    return { ok: false, message, capabilities: inferCapabilities(null), latencyMs: Date.now() - started };
  }
}

export function parseDiscoveredModels(body: unknown): string[] {
  const data =
    body && typeof body === "object" && "data" in body ? (body as { data?: unknown }).data : null;
  if (!Array.isArray(data)) return [];
  return [
    ...new Set(
      data.flatMap((row) => {
        if (!row || typeof row !== "object" || !("id" in row)) return [];
        const id = String((row as { id: unknown }).id).trim();
        return id ? [id] : [];
      }),
    ),
  ].sort();
}

export function inferCapabilities(body: unknown): TestedCapabilities {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  return {
    chatCompletions: Array.isArray(record.choices),
    responses: null,
    modelDiscovery: null,
  };
}

function hasAssistantText(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return false;
  return choices.some((choice) => {
    if (!choice || typeof choice !== "object") return false;
    const message = (choice as { message?: unknown }).message;
    if (!message || typeof message !== "object") return false;
    const content = (message as { content?: unknown }).content;
    return typeof content === "string" && content.trim().length > 0;
  });
}

function safeError(status: number): string {
  if (status === 401 || status === 403) return "The server rejected the credentials.";
  if (status === 404) return "The endpoint is not supported by this server.";
  return `The server returned HTTP ${status}.`;
}

/** Preserve the provider's message while removing the key that was sent. */
export function providerErrorDetail(body: unknown, apiKey?: string | null): string {
  let payload = Array.isArray(body) ? body[0] : body;
  let message: unknown = payload;
  if (payload && typeof payload === "object") {
    const error = (payload as { error?: unknown }).error;
    const detail =
      error && typeof error === "object"
        ? (error as { message?: unknown; status?: unknown })
        : (payload as { message?: unknown; status?: unknown });
    message =
      typeof error === "string"
        ? error
        : typeof (detail as { message?: unknown }).message === "string" &&
            String((detail as { message?: unknown }).message).trim()
          ? (detail as { message: string }).message
          : (detail as { status?: unknown }).status;
  }
  if (typeof message !== "string") return "";
  const redacted =
    apiKey && apiKey !== "not-needed" ? message.replaceAll(apiKey, "[redacted]") : message;
  return redacted.trim().slice(0, 4000);
}

export async function providerResponseDetail(
  response: { text(): Promise<string> },
  apiKey?: string | null,
): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    return providerErrorDetail(JSON.parse(text), apiKey);
  } catch {
    return providerErrorDetail(text, apiKey);
  }
}
