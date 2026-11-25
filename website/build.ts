import { mkdir, readdir, cp, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { dirname } from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const root = resolve(import.meta.dir, '..');
const out = join(import.meta.dir, 'dist');
const base = '/rigwell/';
const version = JSON.parse(await readFile(join(root,'package.json'),'utf8')).version as string;
await mkdir(join(out, 'docs'), {recursive:true});
await cp(join(import.meta.dir, 'public'), out, {recursive:true});
for (const name of ['styles.css','site.js']) await cp(join(import.meta.dir,name),join(out,name));
await cp(join(root,'desktop/assets/icon.png'),join(out,'assets/icon.png'));
await writeFile(join(out,'index.html'),(await readFile(join(import.meta.dir,'index.html'),'utf8')).replaceAll('{{BASE}}',base).replaceAll('{{VERSION}}',version));
// Preserve the manual URL linked by older releases and the repository default README.
await mkdir(join(out,'manual'),{recursive:true});
await writeFile(join(out,'manual/index.html'),`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${base}docs/user-manual.html"><title>Rigwell user manual</title></head><body><a href="${base}docs/user-manual.html">Open the current Rigwell user manual</a></body></html>`);
const escape = (s:string) => s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const pages = (await readdir(join(root,'docs'))).filter(n=>n.endsWith('.md') && !['decisions.md','stax-comparison.md'].includes(n));
const repo = 'https://github.com/scottconverse/rigwell/blob/main/';
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
  await writeFile(join(out,'docs',name.replace(/\.md$/,'.html')),`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} | Rigwell</title><link rel="icon" href="${base}assets/icon.png"><link rel="stylesheet" href="${base}styles.css"><script type="module" src="${base}site.js"></script><script type="module" src="${base}diagrams.js"></script></head><body><a class="skip" href="#main">Skip to content</a><header class="site-header"><a class="brand" href="${base}"><span class="brand-mark" aria-hidden="true">r.</span>rigwell</a><nav aria-label="Documentation navigation"><a href="${base}">Home</a><a href="${base}docs/user-manual.html">User manual</a><a href="https://github.com/scottconverse/rigwell/releases">Downloads</a></nav></header><div class="wrap docs-layout"><aside class="docs-nav"><p>On this page</p><ul>${toc}</ul><p><a href="${base}docs/user-manual.html">Full user manual</a></p></aside><main id="main" class="manual"><p class="doc-meta">Rigwell ${escape(version)} · Documentation</p>${html}</main></div><footer class="site-footer wrap"><a href="${base}">Rigwell</a><a href="${repo}LICENSE">AGPL-3.0-only</a><a href="${base}third-party-notices.txt">Third-party notices</a></footer></body></html>`);
}
const loaded = new Set<string>();
const bundle = await Bun.build({entrypoints:[join(import.meta.dir,'diagrams.ts')],outdir:out,target:'browser',splitting:true,minify:true,plugins:[{name:'license-inventory',setup(build){build.onLoad({filter:/.*/},args=>{loaded.add(args.path);return undefined;});}}]});
if(!bundle.success) throw new Error(bundle.logs.join('\n'));
// Ship the original notices for the packages actually read by this bundle.
const owners = new Map<string,string>();
for (const file of loaded) {
  let folder = dirname(file);
  while (dirname(folder) !== folder) {
    const pkg = join(folder,'package.json');
    if (existsSync(pkg)) {
      const info = JSON.parse(readFileSync(pkg,'utf8'));
      if (info.name) { owners.set(folder,`${info.name} ${info.version || ''} (${info.license || 'see notice'})`); break; }
    }
    folder = dirname(folder);
  }
}
// Mermaid publishes prebundled dependency code. Include the declared runtime
// dependency tree's notices as well as the directly loaded package notices.
const queue = [...owners.keys()].filter(folder=>folder !== root);
const visited = new Set<string>();
while (queue.length) {
  const folder = queue.shift()!;
  if (visited.has(folder)) continue;
  visited.add(folder);
  const info = JSON.parse(readFileSync(join(folder,'package.json'),'utf8'));
  for (const dependency of Object.keys(info.dependencies || {})) {
    let cursor = folder, found = false;
    while (dirname(cursor) !== cursor) {
      const candidate = join(cursor,'node_modules',dependency);
      if (existsSync(join(candidate,'package.json'))) {
        const pkg = JSON.parse(readFileSync(join(candidate,'package.json'),'utf8'));
        owners.set(candidate,`${pkg.name} ${pkg.version || ''} (${pkg.license || 'see notice'})`);
        queue.push(candidate); found = true; break;
      }
      cursor = dirname(cursor);
    }
    if (!found) throw new Error(`Missing installed dependency notice source: ${dependency}`);
  }
}
const notices:string[] = ['License notices for the site, Mermaid and its installed declared dependencies. Prebundled code also retains upstream inline notices. This is not a binary software bill of materials.'];
for (const [folder,name] of [...owners].sort((a,b)=>a[1].localeCompare(b[1]))) {
  const files = readdirSync(folder).filter(n=>/^(license|licence|copying|notice)([._-].*)?$/i.test(n));
  if (!files.length) throw new Error(`Missing redistributed license notice: ${name}`);
  notices.push(name,...files.map(n=>`${n}\n${readFileSync(join(folder,n),'utf8')}`));
}
await writeFile(join(out,'third-party-notices.txt'),notices.join('\n\n----------------------------------------\n\n'));
await writeFile(join(out,'.nojekyll'),'');
console.log(`Built landing page, ${pages.length} documentation pages and ${owners.size} package notices at ${out}`);
