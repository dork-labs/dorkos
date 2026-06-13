---
number: 197
title: Use UtilityProcess for Electron Server Isolation
status: draft
created: 2026-03-24
spec: electron-desktop-app
superseded-by: null
---

# 0197. Use UtilityProcess for Electron Server Isolation

## Status

Draft (auto-extracted from spec: electron-desktop-app)

## Context

The DorkOS Electron desktop app needs to run the Express server alongside the React renderer. Three approaches were evaluated: (1) import server directly into the main process (like the Obsidian plugin's DirectTransport), (2) spawn server in an Electron UtilityProcess communicating via localhost HTTP, (3) build a custom IPC Transport adapter.

The Obsidian plugin already proves in-process works, but a desktop app has different reliability requirements — a server crash should not take down the entire UI.

## Decision

Run the Express server in an Electron UtilityProcess, communicating with the renderer via HTTP over localhost. The renderer reuses the existing HttpTransport unchanged. The main process picks a free port, passes it to the UtilityProcess via env vars, and exposes it to the renderer via contextBridge.

## Consequences

### Positive

- Server crash is isolated — UI can show error dialog and offer restart
- Zero changes to apps/client or apps/server — HttpTransport works as-is
- Debuggable — HTTP requests visible in DevTools Network tab
- Matches existing CLI architecture (server on localhost, client connects via HTTP)

### Negative

- ~1ms per-request latency over localhost (imperceptible for UI)
- Slightly more complex startup sequence (port discovery, ready signal)
- Two Node.js processes instead of one (marginal memory overhead)
