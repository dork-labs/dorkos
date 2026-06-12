# Triage Decisions

**Date**: 2026-06-12
**Mode**: executed directly (user directive: "make any necessary changes in order to support Fable") — no breaking changes, all adopted items trivial-effort, so no separate upgrade spec was generated; this document records the decisions a spec would have carried.

## Included in Upgrade (this branch)

- [x] Version bump 0.3.168 → 0.3.175 in root `pnpm.overrides`, `apps/server`, `packages/cli`
- [x] Fable 5 tier inference — `inferTier()` maps `fable` → `flagship` (`runtime-cache.ts`)
- [x] Fable 5 entry added to the Obsidian DirectTransport static model list (`system-methods.ts`)

## Deferred (follow-up work, not blocking)

- `model_fallback` UI surfacing — map the SDK's `system/model_fallback` message (now emitted for `overloaded`/`server_error`/`last_resort` too) to a `system_status` StreamEvent so chat shows fallback notices. Needs UX decision.
- Refresh of the stale DirectTransport fallback model list (Sonnet 4.5 / Haiku 4.5 / Opus 4.6 era) — superseded long-term by Task 2.7 (per-session runtime routing for DirectTransport).

## Skipped

- `skipMcpDiscovery` — DorkOS intentionally delegates plugin MCP loading to the SDK (ADR-0239)
- `usage_EXPERIMENTAL_...()` — explicitly unstable API
- `BrowserQueryOptions.sse` — DorkOS does not use the browser SDK
