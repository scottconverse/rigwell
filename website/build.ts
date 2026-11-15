import { mkdir, readdir, cp, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dir, '..');
const out = join(import.meta.dir, 'dist');
const base = '/rigwell/';
await mkdir(join(out, 'docs'), {recursive:true});
await cp(join(import.meta.dir, 'public'), out, {recursive:true});
for (const name of ['styles.css','site.js']) await cp(join(import.meta.dir,name),join(out,name));
await cp(join(root,'desktop/assets/icon.png'),join(out,'assets/icon.png'));
await writeFile(join(out,'index.html'),(await readFile(join(import.meta.dir,'index.html'),'utf8')).replaceAll('{{BASE}}',base));
const escape = (s:string) => s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const pages = (await readdir(join(root,'docs'))).filter(n=>n.endsWith('.md') && !['decisions.md','stax-comparison.md'].includes(n));
const repo = 'https://github.com/scottconverse/rigwell/blob/phase-1-core-loop/';
// Runtime is pinned to Bun 1.4.4; repository Bun types predate Markdown.
const markdown = (Bun as typeof Bun & {markdown:{html(source:string,options:{headings:{ids:boolean}}):string}}).markdown;
for (const name of pages) {
  const md = await readFile(join(root,'docs',name),'utf8');
  let html = markdown.html(md,{headings:{ids:true}});
  html = html.replace(/<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g,'<pre class="mermaid">$1</pre>');
  html = html.replace(/href="([^"#]+)(#[^"]*)?"/g,(all,path,hash='')=>{
    if (/^(https?:|mailto:|\/)/.test(path)) return all;
    if (pages.includes(path)) return `href="${base}docs/${path.replace(/\.md$/,'.html')}${hash}"`;
    return `href="${repo}${path.startsWith('../')?path.slice(3):'docs/'+path}${hash}"`;
  });
  const title = /^# (.+)$/m.exec(md)?.[1] || name;
  const toc = [...html.matchAll(/<h2 id="([^"]+)">([\s\S]*?)<\/h2>/g)].map(m=>`<li><a href="#${m[1]}">${m[2]}</a></li>`).join('');
  await writeFile(join(out,'docs',name.replace(/\.md$/,'.html')),`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} | Rigwell</title><link rel="icon" href="${base}assets/icon.png"><link rel="stylesheet" href="${base}styles.css"><script type="module" src="${base}site.js"></script><script type="module" src="${base}diagrams.js"></script></head><body><a class="skip" href="#main">Skip to content</a><header class="site-header"><a class="brand" href="${base}"><span class="brand-mark" aria-hidden="true">r.</span>rigwell</a><nav aria-label="Documentation navigation"><a href="${base}">Home</a><a href="${base}docs/user-manual.html">User manual</a><a href="https://github.com/scottconverse/rigwell/releases">Downloads</a></nav></header><div class="wrap docs-layout"><aside class="docs-nav"><p>On this page</p><ul>${toc}</ul><p><a href="${base}docs/user-manual.html">Full user manual</a></p></aside><main id="main" class="manual"><p class="doc-meta">Rigwell 0.1.1 · Documentation</p>${html}</main></div><footer class="site-footer wrap"><a href="${base}">Rigwell</a><a href="${repo}LICENSE">AGPL-3.0-only</a></footer></body></html>`);
}
const bundle = await Bun.build({entrypoints:[join(import.meta.dir,'diagrams.ts')],outdir:out,target:'browser',splitting:true,minify:true});
if(!bundle.success) throw new Error(bundle.logs.join('\n'));
await writeFile(join(out,'.nojekyll'),'');
console.log(`Built landing page and ${pages.length} documentation pages at ${out}`);
