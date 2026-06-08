---
slug: claude-agent-sdk-upgrade-0.3.168
number: 250
created: 2026-06-08
status: ideation
---

# Claude Agent SDK Upgrade: 0.2.112 → 0.3.168

**Slug:** claude-agent-sdk-upgrade-0.3.168
**Author:** Claude Code
**Date:** 2026-06-08
**Branch:** runtime/claude-agent-sdk-upgrade-0.3.168

---

## 1) Intent & Assumptions

- **Task brief:** Upgrade `@anthropic-ai/claude-agent-sdk` from `0.2.112` to `0.3.168` (47 releases, a pre-1.0 minor bump treated as a major). The upgrade surface is small and confined to `apps/server/src/services/runtimes/claude-code/` (ADR-0089), but it has one real center of gravity — the **native-binary architecture change** (0.2.113) — plus a **peer-dependency** change (0.3.143). This spec covers the version bump, the two breaking changes that affect us, three trivial confined feature adoptions, and the verification gate.

- **Assumptions:**
  - The SDK now ships a per-platform native Claude Code binary as an optional dependency; a separately-installed global `claude` is no longer strictly required for the binary to exist, but optional deps **can** fail to install — so the onboarding dependency check must stay.
  - All `Options`/`Settings`/exported-function surfaces we use still exist in 0.3.168 (verified against `sdk.d.ts@0.3.168`: `pathToClaudeCodeExecutable`, `permissionMode`, `allowDangerouslySkipPermissions`, `includePartialMessages`, `promptSuggestions`, `agentProgressSummaries`, `settingSources`, `systemPrompt`, `toolConfig`, `mcpServers`, `allowedTools`, `canUseTool`, `onElicitation`, `plugins`, `effort`, `resume`, `env`, `managedSettings`, `title`, `forwardSubagentText`, `skills`, `sessionStore`; functions `renameSession`, `forkSession`, `deleteSession`).
  - The `env`-replaces-`process.env` breaking change (0.2.113) is already handled — `message-sender.ts:190-194` spreads `...process.env`.
  - Tests mock the SDK (Tier-1 `sdk-scenarios.ts`, `FakeAgentRuntime`), so typecheck/build/test can pass without the runtime CLI-path fix; the **Docker smoke/integration gate** is what proves the native binary resolves.

- **Out of scope:**
  - `forwardSubagentText` adoption → separate spec **`subagent-text-streaming`** (own UI/test surface).
  - `skills` option, `MessageDisplay` / `SessionStart` hook enhancements, `sessionStore`/`deleteSession`, OpenTelemetry, `managedSettings`, `resolveSettings`, `extract` export — deferred (see triage doc).
  - Any change outside `services/runtimes/claude-code/` except the necessary `package.json` peer-dep declarations and the `claudeCliPath` config surface.

- **Dependencies:** None blocking. This spec is itself a prerequisite for `subagent-text-streaming` and for `claude-agent-sdk-warmup` (#246).

## 2) Pre-reading Log

### Related Artifacts

- `research/runtime-upgrades/claude-agent-sdk/0.2.112-to-0.3.168/changelog.md` — categorized changelog for all 47 releases.
- `research/runtime-upgrades/claude-agent-sdk/0.2.112-to-0.3.168/impact-assessment.md` — file:line impact analysis and verification checklist.
- `research/runtime-upgrades/claude-agent-sdk/0.2.112-to-0.3.168/triage-decisions.md` — the decisions this spec implements.
- `.claude/config/runtime-deps.json` — SDK surface map and related ADRs.
- Prior upgrade spec `claude-agent-sdk-upgrade-0.2.112` (#245, implemented) — pattern reference.

### Related ADRs

- **ADR-0089** (SDK import confinement) — all SDK changes stay inside `services/runtimes/claude-code/`. Peer-dep `package.json` edits and the `claudeCliPath` config surface are the only out-of-boundary touches.
- **ADR-0143** (retry over circuit breaker) — the 529→`overloaded` / 429→`rate_limit` reclassification (0.3.150) fits our retry model; we already forward `error_status`.
- **ADR-0239** (plugin activation) — `plugins` option unchanged (`SdkPluginConfig[]`); our `ClaudeAgentSdkPlugin` `{ type: 'local', path }` shape still matches.
- **ADR-0240** (permission passthrough) — `permissionMode` / `allowDangerouslySkipPermissions` unchanged.

## 3) Scope

### Must Do — Breaking Changes

1. **Version bump `0.2.112 → 0.3.168`.**
   - Root `pnpm.overrides.@anthropic-ai/claude-agent-sdk`.
   - `apps/server/package.json`, `packages/cli/package.json` dependency pins.

2. **Peer dependencies (0.3.143).**
   - Add `@anthropic-ai/sdk` to `apps/server` and `packages/cli` (the SDK no longer bundles it).
   - Add `@modelcontextprotocol/sdk` to `packages/cli` (already in `apps/server`).
   - Add a `pnpm.overrides` pin for `@anthropic-ai/sdk` (`>=0.93.0`) to keep one resolved version.
   - Verify after `pnpm install`: `node_modules/@anthropic-ai/sdk` present **and** a platform native binary (`@anthropic-ai/claude-agent-sdk-<platform>`) present.

3. **Native-binary CLI-path refactor (Hybrid — keep the check, make it smarter).**
   - `sdk-utils.ts` `resolveClaudeCliPath()`: remove the dead `require.resolve('.../cli.js')` branch. New order: explicit override → SDK bundled native binary (return `undefined` so the SDK self-resolves its version-matched binary) → PATH `claude` fallback. Document why (cli.js no longer published).
   - `check-dependency.ts` `checkClaudeDependency()`: report `satisfied` when **either** the SDK bundled binary **or** a PATH `claude` resolves; `missing` only when neither does. Keep the install hint as the recovery path.
   - `routes/config.ts` + `schemas.ts` (`claudeCliPath`): keep the surface; ensure it reflects the effective resolved binary (or `null` when the SDK self-resolves).
   - Rationale captured in code comment: the bundled binary is version-matched to the SDK; preferring a mismatched PATH `claude` was a latent skew risk.

### Should Do — Confined Feature Adoptions

4. **Refusal surfacing (0.3.162).** In `sdk-event-mapper.ts` `message_delta` handling (currently only branches on `stop_reason === 'max_tokens'`, ~line 335), add a `stop_reason === 'refusal'` branch that surfaces `stop_details` to the user (e.g. a `system_status` or dedicated event). Add a Tier-1 scenario + mapper test.

5. **`model_not_found` mapping (0.3.144).** In `sdk-event-mapper.ts` error handling (`mapErrorCategory` / assistant + StopFailure paths), map `error: 'model_not_found'` to a clear "model unavailable" message instead of the generic `execution_error`. Relevant because we persist per-session `model`. Add a test.

### Nice to Have — Trivial Plumbing

6. **`title` option plumbing (0.2.113).** Thread an optional `title` through `MessageOpts` → `sdkOptions.title` in `message-sender.ts` so callers (Tasks scheduler, relay-initiated sessions) can set a session title at creation and skip auto-generation. Plumbing only; specific caller wiring is opportunistic / future.

### Verification (the gate)

7. `pnpm install` → confirm peer + native binary resolution.
8. `pnpm typecheck` → catches any `Options`/`Settings` drift (`settings.fastMode` / `settings.disableAutoMode` at `message-sender.ts:238-245`, `effort` cast at `:234`).
9. `pnpm test` → Tier-1 SDK scenarios + event-mapper tests pass (plus new refusal / model_not_found tests).
10. `pnpm lint` → ADR-0089 boundary intact.
11. `pnpm build` + `pnpm smoke:docker` + `pnpm smoke:integration` → **key gate**: native binary resolves in `node:24-slim` (glibc); ideally extend integration to spawn one real turn on the bundled binary.
12. Manual: start a session, send a message, confirm streaming/tools/MCP status work against the native binary.

## 4) Out of Scope

- `forwardSubagentText` → `subagent-text-streaming` (separate spec, depends on this one).
- All other features/deprecations listed under "Deferred" / "Skipped" in the triage doc.

## 5) Risk Assessment

- **Overall risk: Medium**, concentrated in the native-binary path + packaging. Type-level risk is low (all surfaces verified present). The genuine unknown is runtime binary resolution across our four client surfaces (CLI, Electron desktop, web, Obsidian) and Docker — hence the explicit Docker + manual gate.
- **Rollback criteria:** revert if (a) the native binary fails to resolve on any supported platform after the Hybrid refactor and a PATH `claude` is not present, (b) Docker smoke/integration regresses, or (c) typecheck/test failures can't be resolved within the spec's effort budget. The version bump is committed separately from the migration fixes to make partial rollback clean.
- **ADR implications:** none require a new ADR. If the onboarding model changes materially (e.g. we later drop the PATH dependency entirely), revisit with an ADR at that time.

## 6) Task Ordering (for /spec:execute)

1. Branch + version bump + peer deps + `pnpm install` (commit 1: "the bump").
2. Native-binary CLI-path Hybrid refactor + dependency-check update (commit 2).
3. Refusal surfacing + `model_not_found` mapping + `title` plumbing + tests (commit 3).
4. Validation sweep + Docker gate + manual smoke.
