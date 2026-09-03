---
covers:
  - 'refactor(client): a per-session panel holds only per-session switches (DOR-1758)'
  - 'refactor(client): every settings tab is named after what it holds (DOR-1758)'
  - 'fix(client): one headline per remote-access screen, one heading per group (DOR-1758)'
---

### Changed

- Settings is easier to find your way around. The tabs are grouped now — You, Agents & sessions, Access & privacy, System — and each one is named after what is inside it. "Advanced" is gone: the message box and background refresh moved to Preferences, the logging settings moved to Server, and what was left — reset and restart — is now a tab called "Danger zone". "Show dev tools" moved to Experiments, alongside the app's other developer switches. Security and DorkOS account are one "Access" tab with a section each, and Remote Access is a proper tab instead of a window that opened on top of the settings window. Old links you saved still land in the right place (DOR-1758)
- The Server tab leads with the two things people open it for — the version and the address to paste into other apps. The folder paths and Node version now sit in a "Diagnostics" section you can open when something is wrong, with one button that copies all of them at once (DOR-1758)
- The "Background refresh" switch is no longer in the session panel under the message box. It changed that setting for every window on your machine, not just the session you were looking at, so it now lives only in Settings → Preferences (DOR-1758)
