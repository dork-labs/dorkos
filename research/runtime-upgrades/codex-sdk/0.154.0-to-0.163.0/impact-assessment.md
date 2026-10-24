# Impact Assessment: `@openai/codex-sdk` + `@openai/codex` 0.154.0 → 0.163.0

**Generated**: 2026-10-20 (read-only; repo copy `dorkos-wt/dor-3028-skills` at `c31970db88`)
**Codebase root**: `apps/server/src/services/runtimes/codex/`
**Abstraction boundary**: `AgentRuntime` (SDK, exec fallback) and `CodexTransport` (`transport/codex-transport.ts`, app-server, the default)
**Related ADRs**: 0255, 0309 (superseded), 0310, 261005-113107

See `changelog.md` for sourcing and the categorized changelog. Protocol evidence: `protocol-snapshot-diff.txt` (exact output `diffProtocolSnapshots` gives the committed snapshot vs the 0.163.0 binary) and `schema-snapshot-0.163.0.json` (the file `pnpm codex:protocol-snapshot` should produce; my rebuild of 0.154.0 with the same code matched the committed file byte-for-byte).

## Summary

| Category                                             | Count                   | Action required                                                                                                         |
| ---------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Breaking (SDK-typed)                                 | 0                       | `TurnOptions.cyberAccessProgram` is additive and optional                                                               |
| Breaking (app-server protocol, compile/test-visible) | 1 (4 new notifications) | Must fix: `methods.ts` union + `notification-mapper.ts` dispositions + snapshot                                         |
| Removed CLI/protocol surface DorkOS never used       | 4                       | None (`thread/rollback`, personality, zsh fork, prompt suggestions)                                                     |
| Deprecations touching DorkOS                         | 0                       | None                                                                                                                    |
| Behavioral (no compiler)                             | 8                       | Verify live: instant interrupts on steer, model default change, API-key catalog, stdin approval, trust, desktop signing |
| Features (medium)                                    | 4                       | Consider adopting (see below)                                                                                           |
| Features (low/none)                                  | many                    | No action                                                                                                               |
| Bug fixes (relevant)                                 | ~10                     | Auto-resolved                                                                                                           |
| New `ThreadEvent`/`ThreadItem` (SDK) members         | 0                       | Exec tripwire cannot fire                                                                                               |
| New app-server `ThreadItem` types / server requests  | 0 / 0                   | —                                                                                                                       |

**Overall upgrade risk: Medium-low.** The server side is low risk and fully guarded by the snapshot tests; the medium comes from (a) instant interrupts changing how steer behaves mid-response, and (b) the desktop bundle gaining 25 Mach-O files that must sign and notarize.
**Estimated effort: 2-4 hours** for the bump commit (pins, snapshot regen, 4 enum lines × 2 files, prose), plus the live checks and a desktop packaging dry-run.

## Breaking changes — detailed impact

### Four new app-server notifications

- **What changed**: the 0.163.0 binary's `ServerNotification` union adds `thread/readState/changed`, `thread/attachment/updated`, `thread/prediction/updated`, `account/gatewayOAuth/changed`. Insertions only; every existing method keeps its relative order.
- **Affected files**:
  - `app-server/protocol/methods.ts:51-139` `SERVER_NOTIFICATION_METHODS` — insert, at the binary's positions: `'thread/readState/changed'` after `'thread/started'`/`'thread/status/changed'` (new index 3, before `'thread/archived'`); `'thread/attachment/updated'` after `'thread/name/updated'` (index 11); `'thread/prediction/updated'` after `'thread/goal/updated'` (index 13); `'account/gatewayOAuth/changed'` after `'account/updated'` (index 48). Order matters: `protocol-schemas.test.ts:212` is `toEqual` on the array.
  - `app-server/notification-mapper.ts:52-135` `NOTIFICATION_DISPOSITION` — four entries, all `'ignored'` (none is about a DorkOS turn; read state, attachments, predictions and gateway OAuth are unused features). Compile error until added.
  - `app-server/protocol/methods.ts:21` `PINNED_CODEX_APP_SERVER_VERSION = '0.163.0'`; header line 3 (`codex-cli 0.154.0`, research file name).
  - `app-server/protocol/schema-snapshot.json` — regenerate with `pnpm codex:protocol-snapshot` (expected output = `schema-snapshot-0.163.0.json` (local scratch, not committed)).
- **Effort**: trivial (≈10 lines + regenerated JSON).
- **ADR conflicts**: none. ADR 261005-113107's posture (hand-written subset + snapshot) is exactly what catches this.

### Removed surface DorkOS never used

`thread/rollback` (#44915), `personality` (#44946/#45809), zsh fork flags (#52160), `tui.prompt_suggestions` (#48621). Grepped the adapter: none is sent or read. **Effort: none.**

## Deprecation migrations

None that DorkOS uses. `TurnStartParams.personality` and `mcpAppResourceUri` are deprecated upstream and unused here.

## Snapshot diff, read field by field (what the regenerated JSON will show)

| Change                                                                                                          | Used by (per diff)              | DorkOS impact                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TurnStartParams` + `parentTurnId`, `rootTurnId`, `disabledPluginIds` (optional)                                | `turn/start`                    | None; strict outbound schema in `schemas.ts` stays as is (DorkOS sends none). Adoption candidate                                                                                                                                 |
| `ThreadStartParams` + `daybreakEnabled`; personality descriptions                                               | `thread/start`, `thread/resume` | None                                                                                                                                                                                                                             |
| `InitializeCapabilities` + `explicitGatewayOauth`                                                               | `initialize`                    | None (`InitializeParamsSchema` is strict and only sends `experimentalApi`)                                                                                                                                                       |
| `thread/start                                                                                                   | resume                          | fork`results +`disabledPluginIds`; resume + `collaborationMode`; `thread/read`+`readState`                                                                                                                                       | loads | None (loose reads) |
| `Turn.rootTurnId`; `Turn.error` now "failed **or interrupted**"                                                 | turn notifications              | `TurnSchema` is loose; an interrupted turn may now carry an `error`. Check the interrupt path does not render it as a failure (`notification-mapper.ts:471-500`)                                                                 |
| `CodexErrorInfo` `oneOf`→`anyOf`, + `flexUnavailable`, `tooManyDenials`, open catch-all                         | errors, turn notifications      | `codexErrorInfo` is `z.unknown()`; `errors.ts:71` only probes `activeTurnNotSteerable`; mapper only checks `usageLimitExceeded`. Safe. `tooManyDenials` is a new reason a turn ends (repeated declines) worth its own copy later |
| `MessagePhase` + `partial_answer`                                                                               | agentMessage                    | Mapper never reads `phase`                                                                                                                                                                                                       |
| `PlanType` + `promax`                                                                                           | `account/rateLimits/*`          | `rate-limits.ts:34` passes the string through                                                                                                                                                                                    |
| `ThreadItem.subAgentActivity` + `model`, `reasoningEffort`                                                      | items                           | Loose; adoption candidate                                                                                                                                                                                                        |
| `ThreadItem.mcpToolCall` + `mcpAppUi`                                                                           | items                           | Loose                                                                                                                                                                                                                            |
| `UserInput.image` now `url` OR `fileId`                                                                         | thread/turn items               | DorkOS sends text only (`TextUserInputSchema`)                                                                                                                                                                                   |
| `ResponseItem` + `AdditionalToolsResponseItem` (variant inserted at index 0, causing 192 positional diff lines) | `thread/resume` result only     | Not read                                                                                                                                                                                                                         |
| `McpServerElicitationRequestParams` + `_meta`                                                                   | `mcpServer/elicitation/request` | Already read from the live payload (NOTES P2); refusal shape unchanged                                                                                                                                                           |
| `Model` + `availableAccessPrograms`, `ModelAccessPrograms`                                                      | `model/list`                    | `AppServerModelSchema` is `z.object` (strips)                                                                                                                                                                                    |
| `TurnToolOutput.retain`                                                                                         | items                           | Not read                                                                                                                                                                                                                         |
| `CyberAccessProgram`, `Thread.turns`, `MisalignmentErrorDetails.reviewTarget` descriptions/fields               | various                         | None                                                                                                                                                                                                                             |

`json-schema-check.ts` already handles `anyOf`, so `CodexErrorInfo`'s switch does not break the fixture validation in `protocol-schemas.test.ts`.

## Behavioral changes no compiler catches

| Item                                                                                                          | Where it bites                                                                                                                 | Action                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Instant interrupts default on** (#51812, #51835)                                                            | `turn/steer` and busy-thread `turn/start` now preempt the in-flight response                                                   | Re-run the binary steer test; one live steer mid-stream on a real model to confirm the cut message renders cleanly and no duplicate/empty text appears. Update NOTES P2 steer bullet ("the next model request carries the words") |
| **Default model is now GPT-6.1 Sol** (#49318, #49323); GPT-5.4 and other retired ids removed (#47932, #44250) | `thread-loader.ts:726` omits `model` when unset; an agent saved with a removed id                                              | Live turn with no model set; check one agent with an old saved model id gets an honest error or migration, not a silent wrong model                                                                                               |
| **API-key model discovery default on** (#49807)                                                               | `model-catalog.ts` `model/list` for `CODEX_API_KEY` users                                                                      | Verify the picker on an API-key sign-in                                                                                                                                                                                           |
| `models_cache.json` gains `identity`; invalidation via `MIN_UTC` (#43897, #43906)                             | `model-context-windows.ts`                                                                                                     | Safe by reading (strip + freshness check); the usual ≤300 s empty-enrichment window after any bump                                                                                                                                |
| **Terminal-input approval on** (#47799)                                                                       | Ask first / Workspace write cards                                                                                              | May add `requestApproval` cards for stdin writes to escalated commands; verify card copy reads sensibly                                                                                                                           |
| Implicit trust skipped for projectless dirs (#46328)                                                          | trust spike (`thread-loader.ts:717-719`)                                                                                       | DorkOS sends explicit trust; re-run `app-server.binary.test.ts` (trust-write coverage)                                                                                                                                            |
| Cold resume restores saved thread permissions (#53150, #53419)                                                | `thread/resume`                                                                                                                | DorkOS sends explicit overrides; a mode change in DorkOS must still win — covered by the reload/fork path, confirm once live                                                                                                      |
| Incomplete-response usage now counted in totals (#53670)                                                      | `thread/tokenUsage/updated` `total`                                                                                            | `turn-context-usage.ts` reads `last`; totals may run higher on failed turns. No change                                                                                                                                            |
| **Desktop: 25 new Mach-O files** (voice runtime) and zsh removed                                              | `apps/desktop/electron-builder.yml:197-199` unpack globs; signing + notarization; installer +~50 MB mac / +~67 MB win unpacked | Run the desktop packaging + notarize dry-run in CI before release; check `apps/desktop/scripts/smoke-packaged.ts` still finds the binary                                                                                          |

Credits (`credits-launch.ts`): the custom provider is outside Daybreak/Cyber routing and the API-key discovery path. #50459 adds optional `model_providers.<id>.capabilities`; omitted keeps defaults, so credits behavior is unchanged. `web_search = "disabled"` and `features.prevent_idle_sleep` (still `experimental`, default false in 0.163.0 per `codex features list`) remain valid. `credits-provider.binary.test.ts` covers the credits turn end to end for free.

## Recommended feature adoptions

### Turn lineage (`parentTurnId` / `rootTurnId`) (Relevance: Medium)

- **Value**: when one agent starts work in another Codex thread (helper agents, room hand-offs, background wakes), Codex can attribute it to the originating turn, which feeds its own budgets and history.
- **Effort**: trivial-moderate (two optional strict-schema keys + plumbing the parent turn id).
- **Dependencies**: none; protocol is in the 0.163.0 snapshot.

### Helper model on `subAgentActivity` (Relevance: Medium)

- **Value**: show which model and effort a Codex helper agent runs on in its background task row.
- **Effort**: trivial (read two fields in `notification-mapper.ts:720`).

### `capabilities` override for the credits provider (Relevance: Medium)

- **Value**: declare `remote_compaction` and `external_web_access` explicitly for `dorkos-credits` instead of relying on provider defaults that could change in a later release.
- **Effort**: trivial (config keys in `codexCreditsThreadConfig` / `codexCreditsConfig`), plus a check against the credits endpoint.

### `tooManyDenials` as its own turn-end copy (Relevance: Medium)

- **Value**: when Codex gives up after repeated declines, say so plainly instead of a generic failure.
- **Effort**: trivial (one branch where `usageLimitExceeded` is handled).

Low/none: thread read state, attachments, predictions, item lookup/pagination (possible future history reads), per-thread `disabledPluginIds`, MCP App UI metadata, everything TUI.

## Bug fixes that help DorkOS passively

Stale `thread/closed` after resume ignored (#47155); app-server SIGTERM handled and shutdown bounded (#44523); fd limit raised (#51470); streamed answers kept on failure/interrupt (#45549, #46867); resume includes latest history (#49599); SQLite corruption/stall fixes (#49701, #49032); prompt kept when pre-turn compaction fails (#44487); `Retry-After` honored (#49441, #50418); unknown error variants accepted (#49806); MCP OAuth reconnect and refresh fixes. No adapter workaround is retired by them: the adapter has no TODO/FIXME/HACK/WORKAROUND markers (`CLEARED_TODO_TASK` is SDK vocabulary).

Error classification (`app-server/protocol/errors.ts`) and usage-limit matching (`account-usage.ts:43-46`): every phrase is still present in the 0.163.0 binary's strings. A strings match is not proof of identical full wording, so the live checks above remain the real confirmation.

## Surface-map verification

`@openai/codex-sdk` imports in `apps/server/src` (non-test): `transport/exec-transport.ts` (`Codex`), `codex-options.ts`, `mcp-server-config.ts`, `credits-launch.ts` (`CodexOptions`), `event-mapper.ts` (event/item types), `turn-input.ts` (`ThreadOptions`, `SandboxMode`, `ModelReasoningEffort`). Matches `runtime-deps.json`'s `sdk_surface_map`. No drift. The `@openai/codex` entry's map is also accurate; the only maintenance is noting that the snapshot now has 4 more notifications.

## ADR check

- **261005-113107** (Codex runs on app-server): no conflict; its snapshot guard catches every protocol change in this bump.
- **0309** (superseded), **0310**, **0255**: unaffected.

## The bump commit: every pin and version reference

**Pins (must move together; `__tests__/provision.test.ts:175,202-205` enforces it):**

| File                                                                               | Line(s)  | Change                                                                                              |
| ---------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------- |
| `apps/server/package.json`                                                         | 58, 59   | `"@openai/codex": "0.163.0"`, `"@openai/codex-sdk": "~0.163.0"`                                     |
| `packages/cli/package.json`                                                        | 70, 71   | same                                                                                                |
| `apps/desktop/package.json`                                                        | 37, 38   | same                                                                                                |
| `apps/desktop/package.json` (optionalDependencies)                                 | 25, 26   | `npm:@openai/codex@0.163.0-darwin-arm64`, `npm:@openai/codex@0.163.0-win32-x64` (both exist on npm) |
| `apps/server/src/services/runtimes/codex/provision.ts`                             | 34       | `CODEX_PACKAGE_VERSION = '0.163.0'`                                                                 |
| `apps/server/src/services/runtimes/codex/app-server/protocol/methods.ts`           | 3, 21    | header + `PINNED_CODEX_APP_SERVER_VERSION = '0.163.0'`                                              |
| `apps/server/src/services/runtimes/codex/app-server/protocol/schema-snapshot.json` | all      | regenerate                                                                                          |
| `apps/server/src/services/runtimes/codex/__tests__/provision.test.ts`              | 202, 203 | expect `'0.163.0'`                                                                                  |
| `pnpm-lock.yaml`                                                                   | 39 refs  | regenerate via install                                                                              |

**Code the bump forces:**

- `app-server/protocol/methods.ts` — 4 inserted notification methods (positions above).
- `app-server/notification-mapper.ts` — 4 `'ignored'` dispositions.

**Prose and fixtures naming the version (no behavior; refresh so they stay true):**

- `apps/server/src/services/runtimes/codex/NOTES.md:202-227` (add a 2026-10 bump paragraph), `308`, `313` (pnpm store path), `359`, `361`, and the P2 steer bullet (instant interrupts). Spike-verdict headings (`367`, `399`, `451`) are dated records and stay as written.
- `model-context-windows.ts:12, 14, 15` (permalinks → `rust-v0.163.0`; TTL and filename verified unchanged), `49, 50` (example user agents).
- `turn-context-usage.ts:344, 347` (permalink → `rust-v0.163.0`; `token_usage.rs` verified identical).
- `runtime-constants.ts:51, 67`, `context-gate.ts:11`, `media-capture.ts:5`, `codex-options.ts:114` (`prevent_idle_sleep` still experimental and off by default at 0.163.0).
- Tests: `__tests__/media-capture.test.ts:7`, `__tests__/agent-context.test.ts:345` (comments); `__tests__/fake-app-server.ts:508` + `app-server/__tests__/process-pool.test.ts:72-73` (self-consistent fake version, optional); `__tests__/check-dependencies.test.ts:237-246` (example versions, optional); `app-server/protocol/snapshot.ts:37, 327` (doc examples, optional).
- `packages/evals/src/types.ts:148` and `packages/evals/src/runner/isolation/__tests__/child-process-launcher.test.ts:330` (the cited line moves `dist/index.js:258` → `:262`).
- `turn-input.ts:85` is a dated verification record ("Run 2026-09-26 against codex 0.154.0"); leave it.
- `.claude/config/runtime-deps.json`: no version pin. Optionally add an upgrade note that the vendored package now ships a voice runtime, so desktop signing must be re-verified on bumps.
- Not to touch: `blog/`, `docs/changelog-archive.mdx`, `changelog/archive/`, `specs/*` (historical), `.claude/commands/app/upgrade.md:660` (example), `apps/*/dist/`.

**Changelog fragment** in `changelog/unreleased/` (user-facing; covers the model default change and Codex upgrade).

## Verification plan

1. `pnpm codex:protocol-snapshot`, read the diff (should equal `protocol-snapshot-diff.txt`), commit.
2. `pnpm vitest run apps/server/src/services/runtimes/codex` (includes `protocol-schemas`, `protocol-snapshot.binary`, `app-server.binary`, `credits-provider.binary`, conformance; all free with a scripted local provider).
3. `pnpm --filter @dorkos/server typecheck` (notification-mapper exhaustiveness, event-mapper tripwires).
4. Live (one turn each, operator's sign-in): no model set → which model resolves; a steer mid-response; model picker on ChatGPT sign-in and, if available, an API-key sign-in.
5. Desktop: packaging + notarization dry-run in CI (25 new Mach-O files), and the Windows build.
