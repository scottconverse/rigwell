# Rigwell website design and evidence

## Positioning

- Category: local coding workspace.
- Primary audience: developers and small teams coordinating AI-assisted repository work.
- Problem: work, approvals and agent context become scattered across individual chats and terminals.
- Differentiator: persistent Workstreams, isolated repository work and a shared desktop/terminal coordination layer across direct model adapters, signed-in coding clients and local endpoints.
- Value proposition: keep coding work, agent coordination and review in one local workspace while choosing how models run.
- Capability themes: persistent coordination; repository isolation and review; model choice; local operation and extensibility.
- Primary action: download the current release. Secondary action: read the user manual.
- Maturity: early release with explicit platform and qualification limits. No invented benchmarks or reliability guarantees.

## Visual system

Extend desktop/renderer/styles.css rather than rebrand the product. Warm neutral background #f2f0f0; white surfaces; dark text #1d1b1a; muted text #6b6664; border #d9d4d3; accent #3b6fe0. Dark product-evidence region uses #161413 and #ebe7e5. Semantic success and warning use labels as well as color.

System UI sans serif and system monospace preserve the product's actual font choices and avoid external font requests. Display text uses a restrained 40..88px responsive scale; body 17..20px, comfortable line height and 65-character prose measure. Spacing follows 4/8/12/16/24/32/48/72/96px. Content maximum 1200px. Corners 8px for controls, 16px for product frames; only product frames use a light shadow.

Navigation stays compact, with a working menu below 760px and visible keyboard focus. Use actual links and buttons, a skip link, reduced-motion handling and print styles. Sections alternate editorial text, product image, a workflow strip and a legible architecture diagram; avoid repeated card grids. One bold typographic hero carries the visual emphasis.

## Stack and location

Static HTML/CSS with a small JavaScript navigation module in website/. Bun 1.4.4 builds the landing page and Markdown documentation; reuse the desktop's installed Mermaid dependency for local diagram rendering on documentation pages. No new backend, provider connection, analytics or hosted font dependency. Output website/dist is generated and ignored. Deploy through GitHub Pages Actions under /rigwell/.

## Evidence and assets

- src/workstreams/{index,store,member,listeners}.ts and real subscription coordination receipts: persistent workspaces, members, messages and approval flow.
- src/worktree/{manager,pr}.ts and desktop review: separate branches/worktrees, confirmation before push and PR actions.
- src/agent/session.ts, src/adapters/, src/daemon/, src/sdk/: local orchestration and model execution boundaries.
- docs/auth.md: official clients own subscription login/refresh and native coding tools; Rigwell owns coordination. Do not claim native per-tool policies equal direct-adapter enforcement.
- desktop/renderer/components/Workstreams.tsx: actual renderer captured headlessly with isolated demonstration data and a real local daemon/fake provider. Caption the data honestly; provenance accompanies the PNG.
- Existing package CI, signing and installed receipts support the platform table. macOS remains unsigned and real Mac acceptance unavailable. Full long-session and model-family qualification remains in progress.
- Stax hosted option and broader reuse assessment are next-version work. Do not advertise them as current functionality.

No screenshots of personal settings, tokens, account details or private repositories. No claims of complete offline use with cloud models, unlimited subscription access, fully verified external integrations or Stax platform parity.
