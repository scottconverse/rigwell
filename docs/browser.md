# Agent browser

The agent has browser_open, browser_snapshot, browser_click, browser_type, browser_press, browser_scroll, browser_screenshot, browser_wait, browser_evaluate and browser_close. The built-in agent-browser skill explains the workflow. Take a fresh accessibility snapshot after page changes and use its numbered refs for interaction.

Outside the desktop app, install Chrome or Chromium. Rigwell finds system installations or uses RIGWELL_BROWSER_EXECUTABLE as an explicit executable path. It starts a headless process with its own temporary profile; it does not drive your personal Chrome profile. In the desktop app it uses bundled Chromium in a hidden sandboxed window, or this session's browser pane when a tab is already open.

Network requests obey sandbox network domain policy. HTTP and HTTPS navigation is supported; file URLs and embedded URL credentials are refused. Screenshots and downloads go in .rigwell/browser/<session-id> beneath the session working directory and obey writable/protected path policy. Downloads are canceled when that directory is forbidden.

JavaScript evaluation requires an interactive permission decision, including at high autonomy or with unsafe skip permissions. One-shot runs refuse evaluation when no approver is available. Prefer the other interaction tools. Close with browser_close; session shutdown also releases owned browser resources. Temporary profiles may be preserved with a diagnostic if the browser does not exit or the filesystem keeps them locked.
