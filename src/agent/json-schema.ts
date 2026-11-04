// A small JSON Schema checker for structured output (spec 3.1.5 structuredOutputFormat). It supports the common
// subset: type, enum, const, properties, required, additionalProperties, items, minItems, maxItems, minLength,
// maxLength, minimum, maximum, pattern, anyOf, oneOf, allOf. Unknown keywords are ignored.

const TYPES = ["string", "number", "integer", "boolean", "object", "array", "null"];

/** Problems that make the schema itself unusable (reported as structured_output_schema_invalid), or null. */
export function schemaProblem(schema: unknown, at = "schema", top = true): string | null {
  if (schema === true || schema === false) return null;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return `${at} must be an object`;
  const s = schema as Record<string, unknown>;
  if (top && s.type !== "object") return `${at}.type must be "object" (the answer is sent as a tool call)`;
  if (s.type !== undefined) {
    const ts = Array.isArray(s.type) ? s.type : [s.type];
    for (const t of ts) if (typeof t !== "string" || !TYPES.includes(t)) return `${at}.type has an unknown type ${JSON.stringify(t)}`;
  }
  if (s.required !== undefined && !(Array.isArray(s.required) && s.required.every((r) => typeof r === "string"))) return `${at}.required must be a list of names`;
  if (s.properties !== undefined) {
    if (!s.properties || typeof s.properties !== "object" || Array.isArray(s.properties)) return `${at}.properties must be an object`;
    for (const [k, v] of Object.entries(s.properties)) { const p = schemaProblem(v, `${at}.properties.${k}`, false); if (p) return p; }
  }
  if (s.items !== undefined) { const p = schemaProblem(s.items, `${at}.items`, false); if (p) return p; }
  for (const k of ["anyOf", "oneOf", "allOf"]) {
    const v = s[k];
    if (v === undefined) continue;
    if (!Array.isArray(v)) return `${at}.${k} must be a list`;
    for (let i = 0; i < v.length; i++) { const p = schemaProblem(v[i], `${at}.${k}[${i}]`, false); if (p) return p; }
  }
  if (s.enum !== undefined && !Array.isArray(s.enum)) return `${at}.enum must be a list`;
  if (typeof s.pattern === "string") { try { new RegExp(s.pattern); } catch { return `${at}.pattern is not a valid regular expression`; } }
  return null;
}

const typeOf = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

function matchesType(v: unknown, t: string): boolean {
  if (t === "integer") return typeof v === "number" && Number.isInteger(v);
  if (t === "number") return typeof v === "number" && Number.isFinite(v);
  return typeOf(v) === t;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Error messages for a value that does not fit the schema (empty list: it fits). */
export function validate(value: unknown, schema: unknown, at = "$"): string[] {
  if (schema === true || schema === undefined) return [];
  if (schema === false) return [`${at}: no value is allowed here`];
  const s = schema as Record<string, any>;
  const errs: string[] = [];
  if (s.type !== undefined) {
    const ts: string[] = Array.isArray(s.type) ? s.type : [s.type];
    if (!ts.some((t) => matchesType(value, t))) return [`${at}: expected ${ts.join(" or ")}, got ${typeOf(value)}`];
  }
  if (s.enum && !s.enum.some((e: unknown) => same(e, value))) errs.push(`${at}: must be one of ${JSON.stringify(s.enum)}`);
  if (s.const !== undefined && !same(s.const, value)) errs.push(`${at}: must equal ${JSON.stringify(s.const)}`);
  if (typeof value === "string") {
    if (typeof s.minLength === "number" && value.length < s.minLength) errs.push(`${at}: shorter than ${s.minLength} characters`);
    if (typeof s.maxLength === "number" && value.length > s.maxLength) errs.push(`${at}: longer than ${s.maxLength} characters`);
    if (typeof s.pattern === "string" && !new RegExp(s.pattern).test(value)) errs.push(`${at}: does not match pattern ${s.pattern}`);
  }
  if (typeof value === "number") {
    if (typeof s.minimum === "number" && value < s.minimum) errs.push(`${at}: below the minimum ${s.minimum}`);
    if (typeof s.maximum === "number" && value > s.maximum) errs.push(`${at}: above the maximum ${s.maximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === "number" && value.length < s.minItems) errs.push(`${at}: fewer than ${s.minItems} items`);
    if (typeof s.maxItems === "number" && value.length > s.maxItems) errs.push(`${at}: more than ${s.maxItems} items`);
    if (s.items) value.forEach((v, i) => errs.push(...validate(v, s.items, `${at}[${i}]`)));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    for (const r of s.required ?? []) if (!(r in o)) errs.push(`${at}: missing required property "${r}"`);
    for (const [k, sub] of Object.entries(s.properties ?? {})) if (k in o) errs.push(...validate(o[k], sub, `${at}.${k}`));
    if (s.additionalProperties === false) {
      for (const k of Object.keys(o)) if (!(k in (s.properties ?? {}))) errs.push(`${at}: unexpected property "${k}"`);
    } else if (s.additionalProperties && typeof s.additionalProperties === "object") {
      for (const k of Object.keys(o)) if (!(k in (s.properties ?? {}))) errs.push(...validate(o[k], s.additionalProperties, `${at}.${k}`));
    }
  }
  if (Array.isArray(s.allOf)) for (const sub of s.allOf) errs.push(...validate(value, sub, at));
  if (Array.isArray(s.anyOf) && !s.anyOf.some((sub: unknown) => validate(value, sub, at).length === 0)) errs.push(`${at}: matches none of the allowed shapes`);
  if (Array.isArray(s.oneOf) && s.oneOf.filter((sub: unknown) => validate(value, sub, at).length === 0).length !== 1) errs.push(`${at}: must match exactly one of the allowed shapes`);
  return errs;
}
