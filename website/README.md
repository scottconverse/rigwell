# Rigwell website

Static HTML, CSS and a small navigation script form the landing page. Bun renders repository Markdown into documentation pages and bundles the existing desktop Mermaid dependency for architecture diagrams. There are no hosted fonts, analytics scripts or additional framework dependencies.

## Build and preview

From the repository root, after `bun install` and `npm ci` in `desktop`:

```sh
bun run site:build
bun run site:preview
```

Open `http://127.0.0.1:4173/rigwell/`. `PORT` can select another port. Rebuild after source changes. `site:dev` rebuilds once and watches the preview server; it does not automatically rebuild edited content.

Build output is ignored under `website/dist`. The deployment prefix is `/rigwell/`, including local preview, so nested documentation and asset paths are exercised before deployment. The preview server binds only to loopback.

## Deployment

The `website` GitHub Actions workflow builds and deploys GitHub Pages from `phase-1-core-loop`. The public URL is https://scottconverse.github.io/rigwell/. Deployment needs Pages configured with the GitHub Actions source. Pull requests build without publishing.

## Maintenance

Edit `index.html` and `styles.css` for the landing page. Edit `docs/*.md` for user documentation. `build.ts` publishes top-level Markdown guides, excluding the internal decisions and Stax comparison, and links other repository material to GitHub. `DESIGN.md` records the source-backed positioning and existing product palette.

The Workstreams screenshot is the actual renderer using isolated demonstration data. Its provenance is in `public/assets/workstreams-provenance.json`. Do not replace it with fabricated product UI. Recheck the built site at mobile, tablet and desktop widths, navigation, link targets, diagram rendering, keyboard focus and console errors after relevant changes.

The build preserves upstream inline comments and generates `third-party-notices.txt` from directly bundled packages and Mermaid's installed declared runtime dependency tree. The footer links to the original license/notice texts. This attribution inventory is not a binary software bill of materials.
