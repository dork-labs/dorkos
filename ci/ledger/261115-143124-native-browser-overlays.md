---
id: 261115-143124
title: The macOS desktop smoke proves the native page steps aside only for app layers over it
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.desktop-smoke.packaged-runtime
prs: []
ratchet-release: []
field-changes: []
---

The existing CI-only native guest spec gains a second stock-Electron child for DOR-4417 and DOR-4418. It uses the same throwaway HOME, DORK_HOME, CLAUDE_CONFIG_DIR and profile, plus DORKOS_TEST_RUNTIME=true. It starts no DorkOS server, uses no native DB modules, sign-ins, accounts or public websites, and never reads the Keychain beyond `--use-mock-keychain`.

A local page bundles the client's real `useNativeBrowserSurface` hook with the shared Tooltip, Dialog and Drawer, and drives the production native bridge. The main process reads the native view's own visibility: it stays shown for a tooltip away from it, hides for a tooltip over it, a dialog and (on a 390-wide window) a drawer, and shows again after each closes.

No new job, runner, required context, job timeout or retry is added. The child has the same 60-second ceiling as the first. Revert if it flakes on an unchanged head: the four checks each poll the native flag for up to 5 seconds, so a red means the page did not move.

Files covered: apps/desktop/scripts/smoke-local-browser.ts, apps/desktop/scripts/local-browser-ci/overlays.ts, apps/desktop/scripts/local-browser-ci/overlay-page.tsx, apps/desktop/scripts/local-browser-ci/overlay-preload.ts.
