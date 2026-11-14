import { createHash } from "node:crypto";
import { dirname, extname, join } from "node:path";
import { Parser, Language, type Node } from "@vscode/tree-sitter-wasm";

export interface ReviewSource { path: string; oldPath?: string; before: string; after: string }
export interface SymbolLocation { path: string; name: string; line: number; endLine: number }
export interface SemanticChange { kind: "added" | "removed" | "changed" | "moved"; symbolKind: "function" | "class"; name: string; from?: SymbolLocation; to?: SymbolLocation; renamed?: boolean; changed?: boolean }
interface Symbol extends SymbolLocation { kind: SemanticChange["symbolKind"]; hash: string; shape: string; container: string }
const languages: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  py: "python", go: "go", rs: "rust", java: "java", cs: "c-sharp", c: "cpp", cpp: "cpp", cc: "cpp", cxx: "cpp", h: "cpp", hpp: "cpp", php: "php", rb: "ruby", ps1: "powershell", sh: "bash",
};
const classes = new Set(["class_declaration", "class_definition", "class", "class_specifier", "struct_specifier", "struct_item", "enum_item", "trait_item", "interface_declaration", "module"]);
const functions = new Set(["function_declaration", "generator_function_declaration", "function_definition", "function_item", "method_definition", "method_declaration", "constructor_declaration", "method", "singleton_method", "function_statement"]);
const wasmRoot = dirname(require.resolve("@vscode/tree-sitter-wasm"));
let ready: Promise<void> | undefined;
const grammars = new Map<string, Promise<Language>>();
async function grammar(language: string) {
  await (ready ??= Parser.init({ locateFile: (file) => join(wasmRoot, file) }));
  let pending = grammars.get(language);
  if (!pending) { pending = Language.load(join(wasmRoot, `tree-sitter-${language}.wasm`)); grammars.set(language, pending); }
  return pending;
}
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
function tokens(node: Node, omitted?: number): string {
  if (node.id === omitted) return "<declaration-name>";
  if (/comment/.test(node.type)) return "";
  const children = node.children;
  return children.length ? children.filter((child): child is Node => !!child).map((child) => tokens(child, omitted)).join("|") : `${node.type}:${JSON.stringify(node.text)}`;
}
async function symbols(path: string, text: string) {
  const language = languages[extname(path).slice(1).toLowerCase()];
  if (!language) return { symbols: [] as Symbol[], warning: "No bundled tree-sitter grammar for this file" };
  if (Buffer.byteLength(text) > 2 * 1024 * 1024) return { symbols: [] as Symbol[], warning: "Semantic parsing is limited to files up to 2 MiB" };
  const lang = await grammar(language), parser = new Parser(); parser.setLanguage(lang);
  const tree = parser.parse(text);
  if (!tree) { parser.delete(); throw new Error(`Could not parse ${path}`); }
  const found: Symbol[] = [];
  const visit = (node: Node, container: string) => {
    const assigned = ["arrow_function", "function_expression", "generator_function"].includes(node.type) && ["variable_declarator", "pair", "public_field_definition"].includes(node.parent?.type ?? "");
    const kind = classes.has(node.type) ? "class" : functions.has(node.type) || assigned ? "function" : undefined;
    const named = assigned ? node.parent!.childForFieldName("name") ?? node.parent!.childForFieldName("key") : node.childForFieldName("name");
    // C/C++ functions name their declarator rather than the definition itself.
    const declarator = node.childForFieldName("declarator");
    const nameNode = named ?? declarator?.childForFieldName("declarator") ?? declarator;
    let next = container;
    if (kind && nameNode?.text) {
      const name = container ? `${container}.${nameNode.text}` : nameNode.text;
      const outer = node.parent?.type === "export_statement" || node.parent?.type === "decorated_definition" ? node.parent : node;
      found.push({ path, name, kind, line: node.startPosition.row + 1, endLine: node.endPosition.row + 1, hash: digest(tokens(outer)), shape: digest(tokens(outer, nameNode.id)), container });
      next = name;
    }
    for (const child of node.namedChildren) if (child) visit(child, next);
  };
  try { visit(tree.rootNode, ""); return { symbols: found, ...(tree.rootNode.hasError ? { warning: "Syntax errors: semantic results may be incomplete" } : {}) }; }
  finally { tree.delete(); parser.delete(); }
}

/** Match syntax nodes across all files so a move or rename is not reported as deletion plus addition. */
export async function semanticDiff(files: ReviewSource[]) {
  const before: Symbol[] = [], after: Symbol[] = [], warnings: { path: string; message: string }[] = [];
  for (const file of files) {
    const old = await symbols(file.oldPath ?? file.path, file.before), next = await symbols(file.path, file.after);
    before.push(...old.symbols); after.push(...next.symbols);
    const warning = next.warning ?? old.warning; if (warning) warnings.push({ path: file.path, message: warning });
  }
  const changes: SemanticChange[] = [], unmatchedOld = new Set(before), unmatchedNew = new Set(after);
  const location = ({ path, name, line, endLine }: Symbol): SymbolLocation => ({ path, name, line, endLine });
  const match = (old: Symbol, next: Symbol) => {
    unmatchedOld.delete(old); unmatchedNew.delete(next);
    const moved = old.path !== next.path || old.name !== next.name;
    if (moved || old.hash !== next.hash) changes.push({ kind: moved ? "moved" : "changed", symbolKind: next.kind, name: next.name, from: location(old), to: location(next), ...(old.name !== next.name ? { renamed: true } : {}), ...(moved && old.hash !== next.hash && old.shape !== next.shape ? { changed: true } : {}) });
  };
  const pairs = new Map<Symbol, Symbol>();
  for (const old of before) {
    const candidates = [...unmatchedNew].filter((n) => n.path === old.path && n.name === old.name && n.kind === old.kind);
    if (candidates.length === 1) { const next = candidates[0]!; pairs.set(old, next); match(old, next); }
  }
  // Reordering existing declarations counts as a move; adding lines above one does not.
  for (const [old, next] of pairs) if (old.hash === next.hash && [...pairs].some(([other, target]) => other !== old && other.path === old.path && other.container === old.container && target.container === next.container && (other.line < old.line) !== (target.line < next.line))) {
    changes.push({ kind: "moved", symbolKind: next.kind, name: next.name, from: location(old), to: location(next) });
  }
  for (const key of ["hash", "shape", "name"] as const) {
    for (const old of [...unmatchedOld]) {
      const candidates = [...unmatchedNew].filter((n) => n.kind === old.kind && n[key] === old[key]);
      if (candidates.length === 1 && [...unmatchedOld].filter((n) => n.kind === old.kind && n[key] === old[key]).length === 1) match(old, candidates[0]!);
    }
  }
  for (const old of unmatchedOld) changes.push({ kind: "removed", symbolKind: old.kind, name: old.name, from: location(old) });
  for (const next of unmatchedNew) changes.push({ kind: "added", symbolKind: next.kind, name: next.name, to: location(next) });
  return { changes, warnings };
}
