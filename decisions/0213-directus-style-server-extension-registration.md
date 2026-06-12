---
number: 213
title: Directus-Style register(router, ctx) for Server-Side Extensions
status: accepted
created: 2026-03-29
spec: linear-issue-status-extension
superseded-by: null
---

# 0213. Directus-Style register(router, ctx) for Server-Side Extensions

## Status

Accepted

## Context

Extensions need server-side capabilities (external API calls, secrets, background tasks) but the current system is browser-only. Seven extension architectures were evaluated: VS Code (Extension Host process), Grafana (Go binary per plugin), Raycast (worker threads), Backstage (YAML proxy), Directus (Express router injection), Chrome (service worker), and Obsidian (Electron full access). DorkOS is a single-user local Express server with file-based extensions — the simplest model that provides full capability is the right choice.

## Decision

Use the Directus pattern: extensions export a `register(router, ctx)` function from an optional `server.ts` file. The Extension Manager compiles this for Node.js (not browser), loads it in the main process at startup, creates a scoped `DataProviderContext`, and mounts the router at `/api/ext/{id}/*`. Server-side code runs in-process with no isolation boundary (consistent with ADR 204 full-trust model).

## Consequences

### Positive

- Simplest possible model — extension receives an Express router and a context object
- No IPC protocol, no separate process, no gRPC
- Full Node.js capabilities (fetch, crypto, fs) without restriction
- Familiar pattern for any developer who has written Express middleware
- `DataProviderContext` provides secrets, storage, scheduling, and SSE events in one object

### Negative

- A crashing server extension crashes the entire DorkOS server (mitigated: single-user, restart is trivial)
- No CPU or memory isolation between extensions (acceptable for trusted, developer-authored extensions)
- Dynamic `require()` for loading compiled modules leaks memory on repeated reloads (acceptable for 10-50 reloads per session)
