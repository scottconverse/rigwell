import { SECRET_RULES } from "../permissions/secretscan.ts";
import { listSecrets, secretValue } from "../secrets/store.ts";
import { lookupCredential } from "../storage/credentials.ts";
import { loadSettings } from "../storage/settings.ts";
import { loadToken } from "../auth/oauth.ts";

const sensitive = /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|client[_-]?secret|password|passwd|authorization|cookie|set-cookie|private[_-]?key|awsSecretAccessKey|awsSessionToken|awsBearerToken)$/i;
export function configuredSecretValues(cwd: string): string[] {
  const values = new Set<string>();
  const add = (value: unknown) => { if (typeof value === "string" && value.length >= 4) values.add(value); };
  for (const { name } of listSecrets()) add(secretValue(name));
  for (const provider of ["github", "gitlab"]) add(lookupCredential(provider));
  const visit = (value: unknown, parent = "") => {
    if (!value || typeof value !== "object") return;
    for (const [key, field] of Object.entries(value)) {
      if (sensitive.test(key) || parent === "extraHeaders") {
        if (typeof field === "string" && field.startsWith("keychain:")) add(lookupCredential(field.slice(9)));
        else add(field);
      }
      visit(field, key);
    }
  };
  const settings = loadSettings({ cwd }).settings;
  visit(settings);
  for (const name of Object.keys(settings.oauthProviders ?? {})) {
    const token = loadToken(name); add(token?.accessToken); add(token?.refreshToken);
  }
  return [...values].sort((a, b) => b.length - a.length);
}
export function redactSharedText(text: string, values: string[] = []): string {
  let out = text;
  for (const value of values) if (value.length >= 4) out = out.split(value).join("[redacted]");
  out = out.replace(/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z ]+ )?PRIVATE KEY(?: BLOCK)?-----|$)/g, "[redacted private key]");
  for (const rule of SECRET_RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags.replace("g", "") + "g");
    out = out.replace(re, (match, ...groups) => rule.group && groups[rule.group - 1] ? match.replace(groups[rule.group - 1], "[redacted]") : "[redacted]");
  }
  return out
    .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|token)["']?\s*[=:]\s*)(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s,;}]+)/gi, '$1"[redacted]"')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@");
}
/** Rebuild JSON rather than editing its serialization, so quoted secrets cannot corrupt it. */
export function redactSharedValue(value: unknown, values: string[] = []): unknown {
  if (typeof value === "string") return redactSharedText(value, values);
  if (Array.isArray(value)) return value.map((v) => redactSharedValue(v, values));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, sensitive.test(key) ? "[redacted]" : redactSharedValue(field, values)]));
  return value;
}
