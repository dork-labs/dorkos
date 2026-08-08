# `@openai/codex-sdk` 0.144.1 → 0.147.0 — Impact Assessment

See `changelog.md` in this directory for the full categorized changelog and sourcing. This document covers codebase impact per `contributing/adding-a-runtime.md` §"Bumping a pinned SDK" and `.claude/config/runtime-deps.json`'s `upgrade_notes`.

## Summary

| Category                                     | Count    | Notes                                                                                                                                                    |
| -------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🔴 Breaking (SDK-typed)                      | 0        | `.d.ts` diff shows zero removed/renamed exports, zero signature changes, zero union-member changes                                                       |
| 🟡 Deprecated                                | 1        | `codex exec --full-auto` removed (0.147.0) — confirmed unused in the adapter                                                                             |
| 🟢 Feature (relevant)                        | 2        | Non-blocking MCP startup + MCP 2026-07-28 protocol (medium); `cache_write_input_tokens` usage field (low, passive)                                       |
| 🟢 Feature (not relevant)                    | ~6       | Agent Plugins, paginated thread history/forking, multi-agent v2, audio/realtime, Bedrock — all CLI/TUI-only or unreached by the adapter's headless usage |
| 🔧 Fix (relevant)                            | 4        | MCP connection reliability, secret redaction, interrupt/replay state preservation, rejection-reason consistency                                          |
| ⚡ Performance                               | 3        | Passive — skill/plugin discovery concurrency, serialization overhead, dependency bumps (MCP SDK 3.0.0, V8 150.4.0)                                       |
| ⚪ Internal                                  | ~700 PRs | Overwhelming majority of upstream churn; none touch the npm package's TS surface                                                                         |
| New `ThreadEvent`/`ThreadItem` union members | 0        | Exhaustiveness tripwire does **not** fire this cycle                                                                                                     |

**Overall risk: LOW. Overall effort: LOW** (version bump + verification only; no source changes required).

## Risk

The TypeScript SDK's public surface is essentially frozen across this range — diffing the packed 0.144.1 and 0.147.0 tarballs' `dist/index.d.ts` and `dist/index.js` directly shows exactly one substantive change (a new `cache_write_input_tokens: number` field on `Usage`, with a `??= 0` runtime default). Everything else in the nine-release changelog ships inside the vendored `@openai/codex` Rust binary the SDK spawns as a subprocess, which DorkOS only observes through the same 8-member `ThreadEvent` stream it already handles.

The one item with a plausible-but-unverified path to affecting DorkOS: **0.147.0 introduces local-project "trust" gating** (#36960 "Prompt before trusting local project directories", #36935 "Trust undecided local projects automatically"). DorkOS's Codex adapter spawns `codex exec` against arbitrary agent working directories that no human has ever interactively `codex login`/trust-approved. The companion auto-trust-for-undecided-directories PR suggests non-interactive/exec contexts proceed without blocking, and the `index.js` diff shows the SDK passes no new flags related to trust — but this inference is from PR titles, not a verified live probe. **This is the one thing the required live smoke turn (checklist step 5) should specifically exercise**: run a turn in a working directory the pinned CLI has never seen, and confirm it does not hang or fail on a trust prompt.

No other risk items were identified. `codex exec --full-auto` was removed (0.147.0) but grep confirms the adapter never referenced it — sandbox selection goes entirely through the SDK's typed `SandboxMode` field. ADR-0309's outstanding negative consequence — no SDK thread-listing API — is unchanged; the new paginated-thread-history and thread-forking work (0.145.0–0.147.0) is CLI/app-server-only and does not add typed `Thread.list`/`Thread.fork` methods to the SDK, so it doesn't close that gap.

## Effort

**Trivial** (SDK-level). Version bump in `apps/server/package.json` (`~0.144.1` → `~0.147.0`), then the standard checklist:

1. ✅ Dist-tag check — done: `latest` is 0.147.0, stable.
2. ✅ `.d.ts` diff of `ThreadEvent`/`ThreadItem` and the 8 imported item types — done, zero changes.
3. Recompile to confirm the event-mapper's `never`-exhaustiveness checks still pass — expected to be a no-op compile (no union changed) but must still be run, since it's the checklist's designated tripwire.
4. Run `pnpm vitest run apps/server/src/services/runtimes/codex` (runtime conformance suite).
5. Run one live smoke turn (`DORKOS_CODEX_LIVE=1 pnpm vitest run src/services/runtimes/codex/__tests__/conformance.test.ts` from `apps/server`), specifically watching for the trust-gating behavior above and for clean resume-after-interrupt (NOTES.md's still-open verification item #1, made newly relevant by 0.146.0's interruption/replay state-preservation fixes).

No source changes are anticipated. If the live smoke turn surfaces trust-prompt blocking, that becomes a small follow-up (likely a `-c` config override or `codexPathOverride`-adjacent flag) rather than a large one — genuinely unknown until verified live, since it's inferred behavior, not observed.

## Detailed findings

### Surface-map verification (`.claude/config/runtime-deps.json`'s `sdk_surface_map`)

Grepped every `import.*from '@openai/codex-sdk'` in `apps/server/src` and read each importing file:

| File                                                                        | Imports                                                                                                                                                        | Matches surface map?                              |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `apps/server/src/services/runtimes/codex/codex-runtime.ts:33`               | `Codex`, `CodexOptions`                                                                                                                                        | Yes                                               |
| `apps/server/src/services/runtimes/codex/turn-input.ts:14`                  | `ModelReasoningEffort`, `SandboxMode`, `ThreadOptions`                                                                                                         | Yes, exact match                                  |
| `apps/server/src/services/runtimes/codex/event-mapper.ts:29-39`             | `AgentMessageItem`, `CommandExecutionItem`, `FileChangeItem`, `McpToolCallItem`, `ReasoningItem`, `ThreadEvent`, `ThreadItem`, `TodoListItem`, `WebSearchItem` | Yes, exact match (all 8 item types + both unions) |
| `apps/server/src/services/runtimes/codex/mcp-server-config.ts:21`           | `CodexOptions`                                                                                                                                                 | **Drift**: not listed in `sdk_surface_map`        |
| `apps/server/src/services/runtimes/codex/__tests__/event-mapper.test.ts:4`  | `ThreadEvent`                                                                                                                                                  | Test file, not part of the map (expected)         |
| `apps/server/src/services/runtimes/codex/__tests__/codex-runtime.test.ts:6` | `ThreadEvent`                                                                                                                                                  | Test file, not part of the map (expected)         |

**Surface-map drift (config file not edited per task instructions, reported here)**: `CodexOptions` is imported in two production files, not one. `sdk_surface_map` currently reads `"Codex, CodexOptions → codex-runtime.ts"`; `mcp-server-config.ts` also imports `CodexOptions` (for its `config` field shape, to build the `mcp_servers.*` config object it hands back to `codex-runtime.ts`). This is a legitimate, ESLint-confined use — both files live under `services/runtimes/codex/`, so it doesn't violate Hard Rule 2 (SDK import confinement) — but the map's file-to-type mapping is stale and should read something like `"Codex → codex-runtime.ts; CodexOptions → codex-runtime.ts, mcp-server-config.ts"` next time the config is touched.

Everything else matches the documented map exactly, including all 8 `ThreadItem` variants and both unions imported into `event-mapper.ts`.

### ADR conflicts

- **ADR-0255** (per-session runtime ownership in `session_metadata`): unaffected. Nothing in this SDK range touches session↔runtime binding.
- **ADR-0309** (Codex adapter: SDK threads mapped to DorkOS sessions): the "Negative" consequence "Known CLI-side logging-volume defect... only partially patched at 0.142.5 (#29599 lands in 0.143.0); re-pin to ≥0.143.0 during a stabilization pass" is **resolved by this upgrade** — 0.147.0 is well past 0.143.0, so `logs_2.sqlite`'s unbounded-write defect (openai/codex#28224) is fully patched at the target version. This ADR's consequence statement is now stale and worth a one-line update when the bump lands (not done here per "config only, no edits" scope — flagging for the actual upgrade spec). No other ADR-0309 claims (8-event-type union, no interactive approval channel, no thread-listing API) are contradicted by anything in this range.
- **ADR-0310** (runtime-owned session storage, registry-aggregated listing): unaffected. The new paginated-thread-history work is internal to the Codex CLI's own storage and does not surface a new SDK method DorkOS could adopt to change how `listSessions`/`getMessageHistory` work for this adapter.

### Breaking changes

None found in the SDK's typed surface (see Summary table). The one behavior-level item requiring live verification (trust gating) is documented under Risk above rather than filed as breaking, since it is not an API break and its actual effect on headless `codex exec` is unconfirmed.

### Deprecations

**`codex exec --full-auto` removed, 0.147.0** (`#36054`). Migration: use `--sandbox workspace-write` instead. Usage check: `grep -rn "full-auto\|dangerously-bypass" apps/server/src/services/runtimes/codex/*.ts` returns zero matches outside this research — the adapter never referenced the flag directly; `turn-input.ts`'s `MODE_TO_SANDBOX` map (`default` → `read-only`, `acceptEdits` → `workspace-write`, `bypassPermissions` → `danger-full-access`) drives sandbox selection entirely through the SDK's typed `SandboxMode` field, which the SDK translates to CLI args internally. **Effort: none** — nothing to migrate.

### Features — relevance assessment

| Feature                                                                                       | Relevance               | Effort if adopted                                                 | Dependencies | Value to DorkOS                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Non-blocking MCP startup / MCP 2026-07-28 protocol (0.145.0–0.147.0)                          | **Medium**              | None — passive behavior improvement, no adapter code touches this | none         | MCP servers DorkOS injects via `mcp-server-config.ts` (spec `mcp-server-management`, DOR-892) no longer risk stalling a turn during startup; directly de-risks that existing feature with zero DorkOS-side work |
| `cache_write_input_tokens` usage field (0.147.0/SDK)                                          | **Low**                 | None — additive field, defaults to 0                              | none         | Only useful if/when DorkOS surfaces per-token cost breakdowns for Codex sessions in the UI (no such surface exists today); flag for a future cost-visibility feature, not this upgrade                          |
| Secret/bearer-token redaction in command output & history (0.147.0)                           | **Low-medium**, passive | None                                                              | none         | Reduces risk of secrets leaking into DorkOS's own session transcripts via `CommandExecutionItem`; pure upside, no code change                                                                                   |
| MCP connection reliability (reconnect without restart, timeout enforcement) (0.145.0–0.146.0) | **Medium**, passive     | None                                                              | none         | Same MCP-server-management feature benefits from fewer broken/stalled MCP connections during a session's lifetime                                                                                               |
| Preserve state across interruptions/replay/imports/forks (0.146.0)                            | **Medium**, passive     | None (verify via live smoke)                                      | none         | Improves the reliability of `interruptQuery`'s abort-and-resume path, which NOTES.md already flags as needing live verification (open item #1)                                                                  |
| Agent Plugins (install/search/manifests)                                                      | None                    | n/a                                                               | n/a          | CLI/TUI-only; DorkOS drives Codex headlessly through the SDK, and plugin/marketplace distribution is already DorkOS's own concern via `@dorkos/marketplace`                                                     |
| Paginated thread history, naming, pinning, forking                                            | None                    | n/a                                                               | n/a          | Not exposed as typed SDK methods (`Thread` still only has `id`/`run`/`runStreamed`); doesn't close ADR-0309's "no thread-listing API" gap                                                                       |
| Multi-agent v2 stabilized                                                                     | None                    | n/a                                                               | n/a          | Not reachable through `startThread`/`runStreamed`; DorkOS's own sub-agent orchestration is a separate concern                                                                                                   |
| Audio inputs/outputs, realtime V3                                                             | None                    | n/a                                                               | n/a          | Adapter is text-only via `runStreamed()`; Realtime API is a different SDK surface entirely                                                                                                                      |
| Amazon Bedrock login/endpoints/cached search                                                  | None                    | n/a                                                               | n/a          | DorkOS routes Codex auth through `codex login` (OpenAI), not Bedrock                                                                                                                                            |

### TODO/FIXME/HACK/WORKAROUND audit

`grep -rn "TODO\|FIXME\|HACK\|WORKAROUND" apps/server/src/services/runtimes/codex/` (excluding `__tests__`) returns no markers of that kind — the directory's only inline annotations are the `NOTES.md` "live-verified SDK facts" doc and two TSDoc-adjacent comments unrelated to pending fixes. The one documented pending item is in `NOTES.md` itself, not a code comment:

> "**Recommendation:** acceptable at 0.142.5 (the two worst offenders are fixed); bump the pin to ≥ 0.143.0 during P2 stabilization to pick up #29599, and note the residual write churn in the runtime's docs until then."

**This is resolved by the 0.144.1 → 0.147.0 bump** — 0.147.0 is far past the 0.143.0 threshold `NOTES.md` and ADR-0309 both call out for the `logs_2.sqlite` unbounded-write fix (`#29599`, openai/codex#28224). The actual upgrade spec should update `NOTES.md`'s Verdict 4 section and ADR-0309's negative-consequences bullet to reflect this — both currently describe a pre-0.143.0 state that no longer matches the target pin. (Not edited here — config/docs are out of scope for this research pass per the task instructions.)

`NOTES.md`'s four still-open "live re-verification" items (resume-after-interrupt, no-approval-payload-under-`never`-policy, `web_search`/`mcp_tool_call` under read-only sandbox, `on-failure` acceptance) remain open and are not resolved by anything in this changelog range except item 1 (resume-after-interrupt), which the 0.146.0 interruption/replay-state fixes make a good candidate to finally verify during this bump's live smoke turn.

## Alpha watch

`0.148.0-alpha.2` (published same day as 0.147.0 stable) has a byte-identical `.d.ts` to 0.147.0 — nothing alpha-only to track for a future bump. See `changelog.md` for detail.
