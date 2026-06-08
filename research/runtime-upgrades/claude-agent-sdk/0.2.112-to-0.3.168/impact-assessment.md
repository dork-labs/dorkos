# Impact Assessment: @anthropic-ai/claude-agent-sdk 0.2.112 → 0.3.168

**Generated**: 2026-06-08
**Codebase root**: `apps/server/src/services/runtimes/claude-code/`
**Abstraction boundary**: `AgentRuntime` interface (SDK imports confined here by ADR-0089)
**Related ADRs**: 0089 (SDK import confinement), 0143 (retry over circuit breaker), 0239 (plugin activation), 0240 (permission passthrough)

## Summary

| Category                         | Count | Action Required       |
| -------------------------------- | ----- | --------------------- |
| Breaking changes that affect us  | 2     | Must fix              |
| Breaking changes verified moot   | 5     | None (confirmed safe) |
| Behavioral changes to verify     | 2     | Verify / minor enrich |
| Deprecations affecting us        | 0     | None                  |
| Features (high relevance)        | 1     | Recommend adopt       |
| Features (medium relevance)      | 4     | Consider adopt        |
| Features (low/none relevance)    | 8     | No action             |
| Bug fixes (auto-resolved for us) | 5     | Free                  |

**Overall upgrade risk**: **Medium** — concentrated entirely in one place: the native-binary architecture change (CLI path resolution + packaging). Everything else is either already handled or additive.

**Estimated total effort**: Core upgrade (version bump + 2 breaking fixes + verification) ≈ **2–4 hours**. Optional feature adoptions add **1–3 hours each**, separable into their own specs.

---

## Breaking Changes — Detailed Impact

### 1. Native binary architecture (0.2.113) — **AFFECTS US**

- **What changed**: The SDK stopped shipping `cli.js` and now spawns a per-platform native binary delivered via 8 optional dependencies. Verified against `package.json@0.3.168`: `exports` = `['.', './extract', './browser', './bridge', './assistant', './sdk-tools', './sdk-tools.js']` — **no `./cli.js`**; `files` ships `sdk.mjs` etc. with **no `cli.js`**.
- **Affected files**:
  - `sdk-utils.ts:24-43` (`resolveClaudeCliPath`) — step 1 does `require.resolve('@anthropic-ai/claude-agent-sdk/cli.js')`. Post-upgrade this **always throws** (caught), so the function degrades to step 2 (`which claude` on PATH) or step 3 (`undefined`). The cli.js branch becomes **dead code**.
  - `claude-code-runtime.ts:90` caches `resolveClaudeCliPath()` into `this.claudeCliPath`; `:225` passes it as `claudeCliPath`.
  - `message-sender.ts:195` maps it to `pathToClaudeCodeExecutable` (option still exists in 0.3.168: `string | undefined`).
  - `routes/config.ts:77` surfaces `resolveClaudeCliPath()` to the UI as `claudeCliPath`.
- **Effort**: **Moderate**. The mechanical fix (remove the dead cli.js branch) is trivial. The real decision is _what should resolve to_ — see the product decision below.
- **ADR conflicts**: None. Change stays inside `services/runtimes/claude-code/` (ADR-0089 ✓).
- **Product decision (carries into triage)**: With the binary now bundled in the SDK, DorkOS could **stop requiring a separately-installed Claude Code CLI** and let the SDK resolve its own native binary (`pathToClaudeCodeExecutable: undefined`). That removes an onboarding step (`checkClaudeDependency()` at `check-dependency.ts`, the install hints, and the `claudeCliPath` UI surface become obsolete or change meaning). Alternatively, keep the PATH-`claude` preference for users who run a pinned global install. This is a real fork in onboarding UX — decide before implementing.
- **Migration approach**: Refactor `resolveClaudeCliPath()` to drop the cli.js resolution. Recommended: prefer the SDK's bundled native binary (return `undefined` so the SDK self-resolves), optionally still honoring an explicit override. Update `checkClaudeDependency()` and the `claudeCliPath` config surface to match whichever onboarding model is chosen.

### 2. Peer dependencies (0.3.143) — **AFFECTS US**

- **What changed**: `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, and `zod` are now `peerDependencies` of the SDK (previously bundled `dependencies`).
- **Current state** (verified):
  - `@anthropic-ai/sdk` — **declared nowhere**, **not installed** (`node_modules/@anthropic-ai/` holds only `claude-agent-sdk`). Today it rides along as a bundled dep; post-upgrade it must be a peer.
  - `@modelcontextprotocol/sdk` — declared in `apps/server` (`1.29.0`, pinned via `pnpm.overrides`); **not** declared in `packages/cli`.
  - `zod` — declared in `apps/server` and `packages/cli` (`^4.3.6`). ✓
- **Affected files**: `package.json` (root `pnpm.overrides`), `apps/server/package.json`, `packages/cli/package.json`. The CLI build externalizes `@anthropic-ai/claude-agent-sdk` and `zod` (`packages/cli/scripts/build.ts:35,46`), so the published `dorkos` package resolves them at install time — peers must be installable there too.
- **Effort**: **Trivial–moderate**. Add `@anthropic-ai/sdk` to `apps/server` and `packages/cli`; add `@modelcontextprotocol/sdk` to `packages/cli`. Add an override pin for `@anthropic-ai/sdk` (>=0.93.0). pnpm `auto-install-peers` covers dev, but explicit declarations protect the published-CLI install path and the Docker `npm install -g` smoke/integration flow.
- **ADR conflicts**: None.
- **Migration approach**: Bump the override `@anthropic-ai/claude-agent-sdk` `0.2.112 → 0.3.168`; add the three peers explicitly; `pnpm install`; verify `node_modules/@anthropic-ai/` now contains `sdk` and a `claude-agent-sdk-darwin-arm64` (or platform-appropriate) native binary.

---

## Breaking Changes — Verified NOT Applicable

| Change (version)                                 | Why we're safe (evidence)                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `options.env` replaces `process.env` (0.2.113)   | We **already** spread the parent env: `message-sender.ts:190-194` → `env: { ...process.env, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' }`. Already correct, including the `0.3.149` `CLAUDE_AGENT_SDK_VERSION` fix.                                                                                                           |
| V2 session API removed (0.3.142)                 | Zero usage. `grep unstable_v2\|SDKSession` → **none**. We use `query()` + `options.resume` (`message-sender.ts:199`).                                                                                                                                                                                                         |
| `TodoWrite` → Task tools (0.3.142)               | We already parse **both**: `TASK_TOOL_NAMES = Set(['TaskCreate','TaskUpdate','TodoWrite'])` (`task-reader.ts:5`, `build-task-event.ts`). Accumulation is by task ID for Task tools; `TodoWrite` is kept for reading historical transcripts. `TodoWrite` handling is now effectively legacy-read-only — keep it, it's correct. |
| `updatedMCPToolOutput` deprecated (0.2.121)      | Zero usage (`grep` → none).                                                                                                                                                                                                                                                                                                   |
| `'Skill'` in `allowedTools` deprecated (0.2.133) | We never pass `'Skill'`; our `allowedTools` are all `mcp__dorkos__*` (`tool-filter.ts:41-97`).                                                                                                                                                                                                                                |

---

## Behavioral Changes — Verify (low risk)

### MCP background connect (0.3.142)

- We fetch MCP status non-blocking and already surface a `status` field per server: `message-sender.ts:304-326` maps `s.status`. A new `pending` value flows straight through to the client. **Verify** the client renders `pending` sensibly (and that no test asserts servers are always `connected` on first status). No code change expected.

### Retry classification 529 vs 429 (0.3.150)

- `sdk-event-mapper.ts:186-198` forwards `errorStatus: msg.error_status` — the recommended discriminator (`error_status === 529`). We do **not** read the new `error: 'overloaded'` string, but we don't need it. Fits ADR-0143 (retry, not circuit-breaker). **Optional**: enrich the `api_retry` event with the `error` label for clearer UI copy. No break.

---

## Recommended Feature Adoptions

### Native-binary onboarding (Relevance: **High**) — tied to Breaking Change #1

- **What it enables**: Claude Code ships _inside_ the SDK as a native binary. DorkOS can drop the "install the Claude Code CLI" prerequisite entirely.
- **Value to DorkOS**: One less onboarding step for Kai; removes a whole class of "claude not found on PATH" support issues; keeps the runtime binary version locked to the SDK version. Directly improves first-run success.
- **Adoption effort**: Moderate — co-located with the CLI-path refactor. Touches `sdk-utils.ts`, `check-dependency.ts`, the `claudeCliPath` config surface (`routes/config.ts`, `schemas.ts:1107`), and onboarding docs.
- **Dependencies**: The 0.3.168 upgrade itself. **Verify in Docker** (`smoke:docker`, `smoke:integration`) that the linux-x64 native binary installs in `node:24-slim` (glibc) and that a real session spawns — both Dockerfiles currently mock `claude` on PATH and don't spawn a session, so this needs explicit coverage.
- **Suggested approach**: Fold the decision into the upgrade spec; gate behind a verification that a session runs end-to-end on the bundled binary before removing the dependency check.

### Refusal surfacing (Relevance: **Medium**)

- **What it enables**: Show the user when the model declines, instead of an empty/confusing turn. `stop_reason: "refusal"` + `stop_details` (0.3.162).
- **Where**: `sdk-event-mapper.ts:325` reads `stop_reason` but only branches on `'max_tokens'` (`:335`). Add a `'refusal'` branch emitting a `system_status` (or a dedicated event) using `stop_details`.
- **Effort**: Trivial–moderate (mapper branch + optional client copy). Small own-test surface.

### `model_not_found` error mapping (Relevance: **Medium**)

- **What it enables**: A precise "model X is unavailable" message instead of a generic error when a session's pinned model disappears. (0.3.144)
- **Where**: `mapErrorCategory()` (`sdk-event-mapper.ts:27-40`) and the assistant/StopFailure error path. Today an unknown subtype falls to `'execution_error'`.
- **Effort**: Trivial. Relevant because we persist per-session `model` (`message-sender.ts:230-232`) which can become stale.

### `forwardSubagentText` (Relevance: **Medium**)

- **What it enables**: Stream subagent text deltas to the console, not just background-task progress summaries. We already do subagent discovery (`supportedAgents()`, `message-sender.ts:347-362`) and render `background_task_*` events (`sdk-event-mapper.ts:68-117`).
- **Effort**: Moderate — set the option, then map the forwarded deltas into the existing background-task UI. Has its own UI/test surface → **separate spec**.

### `title` option (Relevance: **Medium**)

- **What it enables**: Set a session title at creation and skip auto-generation (0.2.113). We already support post-hoc `renameSession` (`claude-code-runtime.ts:272`, surfaced in `transcript-reader.ts:302`).
- **Effort**: Trivial–moderate — pass `title` in `sdkOptions` when the caller provides one. Useful for Tasks/relay-initiated sessions that have a known purpose. **Consider** folding into a session-naming spec alongside the 0.3.152 `SessionStart` `sessionTitle` hook.

---

## No Action Required (low / none relevance)

- **`sessionStore` / `deleteSession` / `SDKMirrorErrorMessage` (0.2.113)** — we derive sessions from JSONL on disk (no external mirror). Note: our local `session-store.ts` is unrelated (it wraps `forkSession`); naming overlap only.
- **`skills` option (0.2.120)** — per-agent skill control; aligns with our `enabledToolGroups` model but no current requirement. Future feature.
- **`MessageDisplay` hook (0.3.152)** — no current need to transform displayed text.
- **Live agent switching / idempotent initialize (0.3.161)** — we don't call `applyFlagSettings` or `initialize` directly (`grep` → none). Robustness only.
- **Stop/SubagentStop `additionalContext` (0.3.163)** — we don't inject these hooks.
- **`managedSettings` (0.2.118), `resolveSettings()` (0.2.136), OpenTelemetry (0.2.113), `extract` export (0.3.144)** — not relevant to current embedding.
- **`origin` on result messages (0.2.126)** — informational; not consumed today.
- **~30 parity-only releases** — no SDK surface.

---

## Bug Fixes That Help Us (free with the bump)

| Fix (version)                                                 | Benefit to DorkOS                                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Abort during `PostToolUse` hook ends the turn (0.3.160)       | We use `canUseTool` + `onElicitation` (`message-sender.ts:259-267`); cleaner cancellation, fewer hangs. |
| stdio MCP restart false positives fixed (0.3.154)             | We inject MCP servers per query (`message-sender.ts:249-251`); fewer spurious restarts.                 |
| MCP resource tools at runtime via `mcp_set_servers` (0.3.166) | Correctness for runtime-added MCP servers.                                                              |
| MCP reconnect after transport abort (0.2.119)                 | Long-running relay/Tasks sessions survive proxy blips.                                                  |
| `options.env` keeps `CLAUDE_AGENT_SDK_VERSION` (0.3.149)      | Our spread-env pattern (`message-sender.ts:190`) now preserves the version var.                         |

---

## Verification Checklist (for the upgrade spec)

1. `pnpm install` after bumping the override → confirm `node_modules/@anthropic-ai/sdk` and a platform native binary (`claude-agent-sdk-darwin-arm64`) appear.
2. `pnpm typecheck` — catches any `Options`/`Settings` field drift (e.g. confirm `settings.fastMode` / `settings.disableAutoMode` at `message-sender.ts:238-245`, and `effort` cast at `:234`, still type-check).
3. `pnpm test` — Tier-1 SDK scenarios (`sdk-scenarios.ts`) and event-mapper tests still pass.
4. `pnpm lint` — ADR-0089 boundary intact.
5. `pnpm build` + `pnpm smoke:docker` + `pnpm smoke:integration` — **the key gate**: native binary resolves in `node:24-slim`; ideally extend integration to spawn one real turn on the bundled binary.
6. Manual: start a session, send a message, confirm streaming/tools/MCP status all work against the native binary.

---

## Post-implementation correction (2026-06-08)

The native-binary "affected files" list above **missed a second CLI-path check**: `packages/cli/src/check-claude.ts` (`checkClaude()`, used by `dorkos --post-install-check`) is a standalone PATH-only check, parallel to the server's `checkClaudeDependency()`. Updating only the server check left `--post-install-check` falsely reporting "Claude Code CLI missing" when only the bundled binary was present. `check-claude.ts` now mirrors the Hybrid resolver (kept self-contained because ADR-0089 keeps the server resolver un-importable from the CLI).

This was caught by the decisive gate — `docker build --build-arg MOCK_CLAUDE=false` (no PATH `claude` mock) — which then passed (`Installation verified.`), proving the bundled binary resolves end-to-end in a clean npm-global install. Lesson recorded in memory `project_claude_agent_sdk_native_binary`.
