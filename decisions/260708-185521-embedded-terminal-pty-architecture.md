---
id: 260708-185521
title: Embedded terminal — xterm.js + node-pty over WebSocket, web-only, confined to session cwd
status: draft
created: 2026-07-08
spec: right-panel-workbench
superseded-by: null
---

# 260708-185521. Embedded terminal — xterm.js + node-pty over WebSocket, web-only, confined to session cwd

## Status

Draft (auto-extracted from spec: right-panel-workbench)

## Context

The workbench adds a terminal tab so an operator can run a shell command in the session's worktree without leaving the cockpit. The existing durable per-session event stream (`GET /api/sessions/:id/events`) is JSON-event SSE; a PTY needs a bidirectional byte channel, which SSE cannot provide. Ghostty-web was considered as a lighter same-API drop-in for the terminal renderer, but its `data:`-WASM loading breaks under the project's strict CSP and is unoptimized — rejected for v1 (spec D8, Chunk E).

## Decision

Spawn a PTY per terminal-session id, in the session cwd/worktree, via a new `apps/server/src/services/terminal/` domain, byte-streamed over a dedicated WebSocket (`GET /api/terminal/:id/socket`; input via POST or the same socket; resize as a control message; idle/exit teardown). The client renders with `@xterm/xterm` plus the fit and webgl addons. The feature is web-only: `DirectTransport` (Obsidian) throws "unsupported" and the terminal tab is hidden there. Terminal access is confined to the boundary-validated session cwd — the same trust level the agent already has via its own shell tool access, not a privilege escalation.

## Consequences

### Positive

- Operators get a real shell in the worktree without a context switch, reusing the boundary-confinement pattern already proven for file routes rather than inventing new sandboxing.
- The WebSocket byte channel keeps the durable SSE stream JSON-only and uncomplicated, instead of overloading it with binary PTY frames.

### Negative

- A terminal is arbitrary code execution by design: it must never be reachable from an untrusted embed context, and hiding it under `DirectTransport` is a hard requirement, not a nice-to-have.
- WebSocket is a new transport primitive alongside SSE, adding a connection type (idle teardown, reconnect) the rest of the app doesn't otherwise need.
- `node-pty`'s native addon must build cleanly inside the esbuild-bundled `dorkos` CLI across Node 20/22 — unverified at decision time; the Chunk-E spike must resolve this before the terminal UI is built, or escalate to a fallback architecture (sidecar process, or desktop/dev-only terminal).
