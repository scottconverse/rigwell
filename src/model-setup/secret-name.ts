// A `keychain:` safe secret name for a connection the operator named.
// The daemon stores with it and the renderer references it; both use this one function.
export function secretNameFor(name: string): string {
  const clean = name.trim().replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 64);
  return clean || "model-connection";
}
