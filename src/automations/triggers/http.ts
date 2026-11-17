export async function apiJson(url: string, token: string | undefined, init: RequestInit = {}, fetcher: typeof fetch = fetch, signal?: AbortSignal) {
  const response = await fetcher(url, { ...init, redirect: "error", signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]), headers: { accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
  if (!response.ok) throw new Error(`Service returned HTTP ${response.status}${response.status === 429 || response.status === 403 ? "; check permissions/rate limits" : ""}`);
  const reader = response.body?.getReader(); if (!reader) throw new Error("Service returned no response");
  const parts: Uint8Array[] = []; let size = 0;
  try { for (;;) { const p = await reader.read(); if (p.done) break; size += p.value.length; if (size > 8 * 1024 * 1024) throw new Error("Service response exceeds 8 MiB"); parts.push(p.value); } }
  finally { await reader.cancel().catch(() => {}); }
  return { body: JSON.parse(Buffer.concat(parts).toString("utf8")), more: /rel="next"/.test(response.headers.get("link") ?? "") };
}
