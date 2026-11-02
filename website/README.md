# Rigwell website

The landing page for Rigwell. It is plain HTML, CSS and a small script, with no build step.

| File | What it is |
|---|---|
| `index.html` | The page |
| `styles.css` | The styles. Colors come from the desktop app (`desktop/renderer/styles.css`) and the app icon. Dark mode follows the system setting. |
| `main.js` | The phone menu and the Copy buttons. The page works without it. |
| `assets/` | The app icon and three screenshots of the desktop app |

## Preview

Serve the folder with any static server, then open http://localhost:8765:

```bash
python -m http.server 8765 --directory website
```

## Deploy

`.github/workflows/pages.yml` publishes this folder to GitHub Pages on a push to `main` that changes
`website/`, or when run by hand. Turn Pages on first: repo Settings > Pages > Source: GitHub Actions.
All paths in the page are relative, so it works under `/rigwell/`.

## Screenshots

The screenshots were taken from the real desktop app with a local fake model server and a small demo repo
(no keys, no personal data). To take new ones, launch the app with Playwright's Electron support the way
`test/desktop/helpers.ts` does, use a fake model server from `test/fakes/`, and save PNGs at a window size
of about 1360 by 850.

## Keeping it true

Every claim on the page was checked against the code. When a feature changes, update the page. Items that
are not proven or not built stay in the "Project status" section, marked that way.
