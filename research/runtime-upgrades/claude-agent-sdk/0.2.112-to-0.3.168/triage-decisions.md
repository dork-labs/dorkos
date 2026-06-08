# Triage Decisions — claude-agent-sdk 0.2.112 → 0.3.168

**Date**: 2026-06-08
**Mode**: interactive → specs + execute bump

## Native-binary / onboarding model — **Hybrid (keep the check, make it smarter)**

Decision driver: the user requires the onboarding dependency check to stay — DorkOS must never silently break when no usable Claude Code binary exists. The honest nuance: 0.3.168 ships the binary _with_ the SDK (optional dep), so a separate global install is no longer strictly required — but optional deps can fail to install, which is exactly when the check earns its keep.

- **Resolution order**: explicit override → SDK bundled (version-matched) native binary → PATH `claude` fallback → error with install hint.
- **`checkClaudeDependency()` stays**, upgraded from "is there a global `claude`?" to "is a usable binary available by _any_ path?". Reports `missing` only when neither bundled nor PATH binary resolves; install hint remains the recovery path.
- **Bonus fix**: removes the version-skew risk of preferring a mismatched PATH `claude` over the SDK's bundled binary.
- Remove the dead `require.resolve('.../cli.js')` branch in `resolveClaudeCliPath()`.

## Included in Upgrade Spec (`claude-agent-sdk-upgrade-0.3.168`)

- [x] Version bump `0.2.112 → 0.3.168` (root `pnpm.overrides`, `apps/server`, `packages/cli`)
- [x] Peer-dependency declarations: add `@anthropic-ai/sdk` (apps/server + cli), `@modelcontextprotocol/sdk` (cli), override pin for `@anthropic-ai/sdk` (>=0.93.0)
- [x] Native-binary CLI-path **Hybrid** refactor (`sdk-utils.ts`, `check-dependency.ts`, `routes/config.ts`, `schemas.ts` claudeCliPath surface)
- [x] **Refusal surfacing** — handle `stop_reason: 'refusal'` + `stop_details` in `sdk-event-mapper.ts`
- [x] **`model_not_found` mapping** — clear "model unavailable" message in `sdk-event-mapper.ts`
- [x] **`title` option plumbing** — pass `title` through `Options` when a caller supplies it (`message-sender.ts`, `MessageOpts`)
- [x] Verification: Docker smoke/integration confirms native binary resolves; one real turn on the bundled binary

## Separate Spec

- **`subagent-text-streaming`** (`forwardSubagentText`, 0.2.119) — has its own UI/test surface (mapping forwarded subagent deltas into the console). Depends on the upgrade. The user opted to adopt it; routed to its own spec per the separate-spec criteria (new UI surface).

## Deferred (no spec now — noted for future)

- `skills` option (per-agent skill control) — aligns with `enabledToolGroups`; no current requirement.
- `MessageDisplay` hook, `SessionStart` `sessionTitle`/`reloadSkills` — could power richer session naming later (pairs with `title`).
- `sessionStore`/`deleteSession`/OpenTelemetry/`managedSettings`/`resolveSettings`/`extract` — not relevant to current embedding.

## Skipped (verified moot — no work)

- `env`-replaces-`process.env` (already spread), V2 session removal (unused), TodoWrite→Task (already dual-parsed), `updatedMCPToolOutput` + `'Skill'` deprecations (unused).
