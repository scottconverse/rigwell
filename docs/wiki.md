# Local project wiki

Open **Wiki** in the desktop sidebar, choose a repository and select **Build wiki**. Search page titles/content and open an overview, architecture, module or glossary page. The desktop renders Mermaid diagrams. **Update wiki** reads the current working tree and refreshes affected managed pages. The command palette also opens Wiki.

```text
rigwell wiki build --cwd C:/code/project
rigwell wiki update --cwd C:/code/project
rigwell wiki list --cwd C:/code/project
rigwell wiki search symbol --cwd C:/code/project
rigwell wiki read glossary.md --cwd C:/code/project
rigwell wiki video --cwd C:/code/project
rigwell wiki video --mp4 --cwd C:/code/project
```

Generation runs entirely locally without model inference, project scripts, package installation, Git hooks or network requests. The selected folder must be inside a Git repository; tracked and untracked nonignored files are considered. Supported code files use the same bundled tree-sitter grammars as semantic Review. README files and root package metadata supply project context. A module is a directory containing supported source code. The wiki records function/class declarations with source paths and line locations, a symbol glossary and resolved relative JavaScript/TypeScript import edges. It does not infer runtime behavior or undocumented business meaning. Dynamic imports, external package dependencies and other languages' imports are not resolved. Parser/coverage warnings are visible in the overview and desktop.

Files live under the selected project's `.rigwell/wiki/`. Generated page names and source hashes are in `index.json`; unchanged pages retain their modification times, changed source modules refresh their own pages and affected aggregate pages, and deleted modules lose their managed page. A full build uses the same incremental writer. Unrelated owner files remain untouched; an initial collision with an unmanaged page is refused. Generated pages are managed output and may be regenerated if edited. No Git ignore file is changed; keep the generated directory untracked unless you choose to publish it.

Evidence folders, dependencies, build output, `.git`, `.rigwell`, generated/minified files and private configuration are excluded. Source and wiki paths cannot follow custom links/junctions. Bounds are 2,000 eligible files, 16 MiB total source, 512 KiB per source and 2 MiB per generated page. Oversized sources are reported; total/page limit failures occur before page writes. Diagrams show at most 80 nodes with an explicit omission count; the repository map and module pages remain complete within the source limits. Source documentation may contain private project information: the wiki stays local and is not a redacted publication export.

Concurrent writers use a local `.lock` containing process identity/start time. A normal failure or cancellation releases it. After a crash, verify that the recorded process has stopped before removing that one lock; do not kill an unrelated process or delete documentation to bypass it.

The four bundled skills are `wiki`, `browse-wiki`, `install-wiki` and `wiki-video-gen`. The installer uses the existing approved **CreateAutomation** path, project scope and a five-minute schedule. Its prompt executes `rigwell wiki update --after-commit` in the selected repository. The command skips generation when HEAD matches the last source commit. This is polling while the daemon runs, not an instant Git hook. Explicit `wiki update` includes uncommitted edits even when HEAD is unchanged. Inspect, pause or remove the ordinary automation from the Automations page. Installation does not run it immediately, push or publish anything.

Walkthrough export always creates a self-contained `walkthrough.html` with ordered navigation and every page. It blocks remote assets and escapes source markup. Mermaid remains readable diagram source there; use the desktop for rendered diagrams. Optional MP4 rendering uses installed ffmpeg, a local TrueType font and Windows System.Speech, macOS say, or Linux espeak. Missing dependencies leave HTML available and report the reason. No cloud speech fallback is used and no audio is played. Narration covers at most eight non-glossary pages with up to 90 words each; returned page names disclose the selection. Temporary audio/slides are removed on success, failure or cancellation; only owned rendering processes are stopped. Output is `walkthrough.mp4` with H.264 video and AAC audio.

Acceptance uses temporary repositories, fake provider/renderer responses and a headless production page connected to the real daemon. It covers source citations, actual parsed declarations/imports, selective updates/deletions, preserved owner files, links/escapes/locks, commit polling, CLI commands, diagrams/search, agent reads and approved automation creation. A separate Windows local-tools check synthesized a file and verified real video/audio streams with ffprobe; this does not establish playback in an installed application or macOS/Linux local speech availability.
