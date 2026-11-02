// Lazy renderer upgrades for rendered markdown and the file viewer (spec 14.7): shiki code highlighting, KaTeX math and
// mermaid diagrams. The synchronous markdown pass leaves plain, escaped HTML; this module upgrades it after paint.
// Every library is loaded with a dynamic import, so the first paint does not pay for them (each becomes its own chunk).
// Failures leave the plain version in place. No remote requests: the regex engine is pure JS (no wasm), fonts ship with the app.

type Highlighter = { codeToHtml(code: string, o: Record<string, unknown>): string; getLoadedLanguages(): string[]; loadLanguage(...l: unknown[]): Promise<void> };

/** Language ids to their shiki grammar module. Anything else renders as plain text. */
const LANGS: Record<string, () => Promise<unknown>> = {
  typescript: () => import("shiki/langs/typescript.mjs"), tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"), jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"), bash: () => import("shiki/langs/bash.mjs"),
  python: () => import("shiki/langs/python.mjs"), go: () => import("shiki/langs/go.mjs"), rust: () => import("shiki/langs/rust.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"), toml: () => import("shiki/langs/toml.mjs"), css: () => import("shiki/langs/css.mjs"),
  html: () => import("shiki/langs/html.mjs"), markdown: () => import("shiki/langs/markdown.mjs"), diff: () => import("shiki/langs/diff.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
};
const ALIAS: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript", js: "javascript", mjs: "javascript", cjs: "javascript", sh: "bash", shell: "bash", zsh: "bash",
  py: "python", rs: "rust", yml: "yaml", md: "markdown", htm: "html", jsonc: "json",
};
export const shikiLang = (l: string): string | undefined => {
  const k = ALIAS[l.toLowerCase()] ?? l.toLowerCase();
  return k in LANGS ? k : undefined;
};

let highlighter: Promise<Highlighter> | undefined;
function getHighlighter(): Promise<Highlighter> {
  return (highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, light, dark] = await Promise.all([
      import("shiki/core"), import("shiki/engine/javascript"), import("shiki/themes/github-light.mjs"), import("shiki/themes/github-dark.mjs"),
    ]);
    return (await createHighlighterCore({ themes: [light.default, dark.default], langs: [], engine: createJavaScriptRegexEngine() })) as unknown as Highlighter;
  })());
}

/** Highlighted HTML (a <pre class="shiki"> with --shiki-light / --shiki-dark colors) or null when the language is unknown or loading fails. */
export async function highlightCode(code: string, lang: string): Promise<string | null> {
  const id = shikiLang(lang);
  if (!id) return null;
  try {
    const h = await getHighlighter();
    if (!h.getLoadedLanguages().includes(id)) await h.loadLanguage(((await LANGS[id]()) as { default: unknown }).default);
    return h.codeToHtml(code, { lang: id, themes: { light: "github-light", dark: "github-dark" }, defaultColor: false });
  } catch { return null; }
}

let katexP: Promise<typeof import("katex").default> | undefined;
const loadKatex = () => (katexP ??= import("katex").then((m) => m.default));

let mermaidP: Promise<typeof import("mermaid").default> | undefined;
let mermaidTheme = "";
async function loadMermaid() {
  const m = await (mermaidP ??= import("mermaid").then((x) => x.default));
  const theme = document.documentElement.dataset.theme === "dark" ? "dark" : "default";
  if (theme !== mermaidTheme) { m.initialize({ startOnLoad: false, securityLevel: "strict", theme }); mermaidTheme = theme; }
  return m;
}
let mermaidSeq = 0;

/** Upgrades code blocks, math and mermaid diagrams under `root`. Safe to call again; already upgraded nodes are skipped. */
export async function enhance(root: HTMLElement, isStale: () => boolean = () => false): Promise<void> {
  const jobs: Promise<void>[] = [];
  for (const code of Array.from(root.querySelectorAll<HTMLElement>("pre > code[data-lang]"))) {
    const pre = code.parentElement as HTMLElement;
    if (pre.dataset.enhanced) continue;
    pre.dataset.enhanced = "1";
    const lang = code.dataset.lang ?? "";
    if (lang === "mermaid") {
      jobs.push((async () => {
        const id = `mmd-${++mermaidSeq}`;
        try {
          const m = await loadMermaid();
          const { svg } = await m.render(id, code.textContent ?? "");
          if (isStale()) return;
          const box = document.createElement("div");
          box.className = "mermaid-diagram";
          box.setAttribute("role", "img");
          box.setAttribute("aria-label", "Diagram");
          box.innerHTML = svg; // mermaid sanitizes its output with securityLevel "strict"
          pre.replaceWith(box);
        } catch (e) {
          pre.classList.add("diagram-error");
          pre.title = `Diagram could not be drawn: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`;
          document.getElementById(`d${id}`)?.remove();
        }
      })());
    } else {
      jobs.push((async () => {
        const html = await highlightCode(code.textContent ?? "", lang);
        if (!html || isStale()) return;
        const tpl = document.createElement("template");
        tpl.innerHTML = html;
        const el = tpl.content.firstElementChild as HTMLElement | null;
        if (el) { el.dataset.lang = lang; el.dataset.enhanced = "1"; pre.replaceWith(el); }
      })());
    }
  }
  const maths = Array.from(root.querySelectorAll<HTMLElement>("[data-tex]:not([data-rendered])"));
  if (maths.length) {
    jobs.push((async () => {
      try {
        const katex = await loadKatex();
        for (const el of maths) {
          if (isStale()) return;
          el.dataset.rendered = "1";
          katex.render(el.dataset.tex ?? "", el, { displayMode: el.classList.contains("math-block"), throwOnError: false, output: "htmlAndMathml", trust: false });
        }
      } catch { /* leave the TeX source visible */ }
    })());
  }
  await Promise.all(jobs);
}
