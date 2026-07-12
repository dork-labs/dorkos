---
id: 260711-150550
title: Cockpit-native floating PIP panel instead of the browser Document Picture-in-Picture API
status: accepted
created: 2026-07-11
spec: pip-panel
superseded-by: null
---

# 260711-150550. Cockpit-native floating PIP panel instead of the browser Document Picture-in-Picture API

## Status

Accepted

## Context

Two features need a small always-on-top surface inside the cockpit: MCP Apps' deferred `pip` display mode (mcp-apps-host decision D5: "no floating surface yet") and popping live gen-UI widgets out of the transcript (DOR-298). The browser offers a native Document Picture-in-Picture API, but it is Chromium-only, interacts poorly with the strict-sandbox (`allow-scripts`, opaque-origin) iframes MCP Apps require, and does not exist in the Electron desktop shell or the Obsidian embedded shell — two of DorkOS's four client surfaces.

## Decision

We will build the PIP surface as a cockpit-native floating panel: a React component portaled to `document.body` at `z-40`, mounted once per shell (both `AppShell.tsx` and the router-free embedded `App.tsx`), with hand-rolled pointer-event drag/resize and geometry persisted to localStorage. We will not use the Document Picture-in-Picture API or OS-level always-on-top windows.

## Consequences

### Positive

- Works identically on every surface DorkOS runs (web, Electron, Obsidian embedded); no capability sniffing.
- Sandboxed MCP App iframes render inside it with zero sandbox rework — placement is a pure layout change.
- Becomes a reusable primitive (pinned session, floating terminal, …), not a one-off browser feature.
- Fully testable with jsdom + pointer events; no browser-API mocking.

### Negative

- The panel cannot leave the browser window/viewport the way native PiP can (no floating over other apps).
- We own ~150 lines of gesture code (drag, resize, clamping) and its edge cases.
