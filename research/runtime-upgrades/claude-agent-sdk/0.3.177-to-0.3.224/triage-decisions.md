# Triage Decisions

**Date**: 2026-08-07
**Decided by**: Dorian (interactive /app:runtime-upgrade run)

## Included in Upgrade Spec

- [x] Version bump 0.3.177 → 0.3.224 across all workspace packages (root, apps/desktop, apps/server, packages/cli)
- [x] All breaking-change verifications (14 identified; zero compile-level breaks — each verified no-exposure, see impact-assessment.md)
- [x] Re-verify the `mcp-revocation.ts` empirical anchor (dated to 0.3.177; its fixture-pinned test cannot detect staleness — 0.3.221 changed the MCP connect timing it reasons about)
- [x] Verify `resolveClaudeCliPath` behavior (native-binary packaging is version-sensitive per upgrade_notes)
- [x] Trivial in-bump adoptions:
  - `ModelInfo.resolvedModel` — match persisted model id to alias row in `runtime-cache.ts`
  - ~~`SDKAssistantMessage.aborted`~~ — **moved to the interrupt-receipts spec during
    execution (2026-08-07)**: DorkOS has no per-assistant-message event (text streams as
    deltas, and the durable transcript re-reads SDK JSONL per ADR-0310), so an honest
    truncation mark needs a new StreamEvent + client renderer + transcript-reader change
    — over the in-bump bar

## Separate Specs

- Interrupt receipt + `cancel_queued` — "Stop actually stops"; moderate→significant (now also owns `SDKAssistantMessage.aborted`)
- `Query.reinitialize()` — prompt redelivery after transport gaps; SDK-side twin of durable SSE replay
- Verified message origin (`SDKMessageOrigin.verifiedPeerPid`/`body`/`fromSession`) — first non-forgeable sender identity for Relay/Mesh
- `background_tasks_changed` — level-based background-task state to replace edge-derived mapping in `system-event-mapper.ts`

## Deferred (documented in impact assessment, no spec yet)

- `tool_result_meta` classification — trivial→moderate; revisit with the interrupt-receipt spec
- `tool_progress.subagent_retry` UI — moderate
- `resumeDropsTurn` anchoring — moderate
- `api_error_status: 529` handling (ADR-0143 wasted-retry cost) — moderate
- Plugin manifest `version` at runtime (ADR-0239 drift detection) — moderate

## Skipped

- None. Deprecations (`team_name` hook inputs, `maxThinkingTokens`) have zero usage — nothing to migrate.
