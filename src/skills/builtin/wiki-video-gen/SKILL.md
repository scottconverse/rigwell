---
name: wiki-video-gen
description: Export an offline HTML project walkthrough and optionally render narrated MP4 slides using local tools.
---

First check that the selected project has a current wiki. Use the wiki skill to build or update it when that work is requested. Run `rigwell wiki video --cwd <folder>` to create `.rigwell/wiki/walkthrough.html`, a self-contained document with ordered page navigation, source citations and the complete wiki content. It uses no remote assets; Mermaid diagram source remains readable as text in the HTML. The desktop Wiki renders those diagrams visually.

When the user wants a video, add `--mp4`. Rendering requires ffmpeg, a supported local font and an installed operating-system speech engine: Windows System.Speech, macOS say, or Linux espeak. Narration is synthesized directly to temporary files, never played through speakers or sent to a cloud API. The MP4 covers at most eight selected non-glossary pages with bounded narration; the HTML retains every page. Report which pages were selected rather than claiming complete narration.

If local dependencies are missing, return the successful HTML artifact and the precise missing requirement. Do not install packages or configure an online speech provider without authorization. Cancellation stops owned rendering commands and removes only their temporary working folder. Check the returned paths and command result before linking artifacts. Do not claim video output merely because the HTML was generated, or claim installed-player playback without observing it.
