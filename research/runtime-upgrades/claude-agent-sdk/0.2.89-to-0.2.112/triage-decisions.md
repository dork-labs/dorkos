# Triage Decisions — claude-agent-sdk 0.2.89 → 0.2.112

**Date**: 2026-04-16
**Mode chosen**: Aggressive adoption (bundle feasible feature work into the upgrade spec)
**Execution path**: Generate specs, then start `/spec:execute` on the upgrade spec

## Included in the Upgrade Spec

### Mandatory (upgrade itself)

- [x] Bump `@anthropic-ai/claude-agent-sdk` from `0.2.89` → `0.2.112` across all 3 workspace packages (`package.json`, `apps/server/package.json`, `packages/cli/package.json`)
- [x] Auto-applied fixes (no code changes): 8 bug fixes + GHSA-5474-4w2j-mq4c security patch + concurrent-query perf fix

### Cleanup (enabled by bump)

- [x] Remove `PermissionMode 'auto'` type-assertion workaround at `message-sender.ts:223-226` (0.2.91 added `'auto'` to the public `PermissionMode` type)

### Free features (already possible with bump)

- [x] Opus 4.7 support — no code changes needed; once the SDK is on 0.2.111+, `model: 'claude-opus-4-7'` works through the runtime

### Feature adoptions (aggressive mode)

- [x] **`terminal_reason` plumbing + UI chip**: read `result.terminal_reason` in `sdk-event-mapper.ts`, extend `session_status` `StreamEvent`, persist on session, render a small indicator in the UI for non-`completed` reasons (`max_turns`, `aborted_tools`, `blocking_limit`)
- [x] **`system/memory_recall` event + `memory_paths` on init**: new `memory_recall` `StreamEvent` variant + mapper handler + expose `memory_paths` from `system.init` on session metadata
- [x] **Richer `SDKStatus 'requesting'`**: extend `system_status` `StreamEvent` with optional `status` field; mapper forwards the SDK status value; UI can use it for richer loading affordance

## Separate Specs

- **`startup()` / `WarmQuery` warm-up** — gated on perf measurement; justifies its own spec because adoption needs benchmarking before/after to prove the win

## Deferred (Out of Scope, No Active Need)

- **`SDKUserMessage.shouldQuery: false`** — promising API, but no concrete DorkOS feature needs "append user message without triggering a turn" yet. Revisit when a spec asks for it.
- **Per-tool `permission_policy` on remote MCP servers (0.2.111)** — applies only to http/sse MCP servers; our MCP tools are all local stdio. Revisit when marketplace adapters (ADR-0239) start using remote MCP transports.
- **Simplifying the explicit `...process.env` spread at `message-sender.ts:192`** — the redundant spread is defensively harmless and keeps behavior stable if the SDK ever reverts. Leave as-is.

## Skipped

None.
