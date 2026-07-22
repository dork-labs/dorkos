---
id: 260722-185415
title: Runtime readiness reads DorkOS-stored credentials before vendor CLI probes
status: accepted
created: 2026-07-22
spec: opencode-connect-overhaul
superseded-by: null
---

# 260722-185415. Runtime readiness reads DorkOS-stored credentials before vendor CLI probes

## Status

Accepted

## Context

ADR-0315 gave DorkOS its own credential store (encrypted references in `config.providers`, resolved at each runtime's env-injection seam), and ADR-0318 chose per-provider connect flows that write into it (OpenRouter OAuth/paste-key, Direct providers). But OpenCode's readiness check (`checkAuthState`) kept a single source of truth from before that store existed: shelling out to `opencode auth list`, which only sees credentials the OpenCode CLI wrote itself. DorkOS's connect flows never write there, so a successful connect left `GET /api/system/requirements` reporting `state: 'connect'` forever. That one gap produced both shipped bugs in the connect UX: the UI "forgot" authentication on every fresh probe, and the ready-flip that hands the runtime selection to the toolbar never fired, so sessions silently stayed on the default runtime. The gap was documented in the adapter's NOTES.md as an open follow-up.

## Decision

A runtime's auth readiness check consults DorkOS's own persisted provider state **first**, and treats the vendor CLI probe as the fallback, not the authority:

- If `config.runtimes.<runtime>.provider` is set and its credential requirement is met (a key-bearing provider's `config.providers[<provider>]` reference resolves via the credential-provider seam; a zero-auth provider like Ollama needs only the provider selection), the auth check is **satisfied**, with copy naming the source ("Connected via OpenRouter").
- Otherwise, fall back to the vendor CLI's own auth state (`opencode auth list`), so users who authenticated the CLI directly keep working.
- A selected provider whose stored reference no longer resolves reports **missing** with reconnect guidance — honest degradation, never silent success.

The general principle: whatever DorkOS's connect surface writes, DorkOS's readiness surface must read. A connect flow that persists state the readiness check cannot see is a contract violation, not a UX bug.

## Consequences

- Connecting once means connected across reloads, restarts, and fresh probes — the readiness endpoint and the connect flow finally share one source of truth.
- The client's ready-flip handoff (`onRuntimeReady` → pending runtime selection) becomes live without client changes.
- Codex and Claude are unaffected today (Codex deliberately stores nothing in DorkOS — its CLI _is_ the source of truth per ADR-0318; Claude has no auth check), but any future runtime whose connect flow writes DorkOS-stored credentials must follow this read-what-you-write rule.
- The readiness check gains a dependency on the credential-resolution seam; tests must cover the dangling-reference state so a deleted keychain entry degrades honestly rather than reporting ready.
