# `@openai/codex-sdk` 0.153.4 → 0.154.0 — Impact Assessment

See `changelog.md` in this directory for the full categorized changelog and sourcing. This document covers codebase impact per `contributing/adding-a-runtime.md` §"Bumping a pinned SDK" and `.claude/config/runtime-deps.json`'s `upgrade_notes`.

## Summary

| Category                                     | Count    | Notes                                                                                                                                     |
| -------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 🔴 Breaking (SDK-typed)                      | 0        | `dist/index.d.ts` is **byte-identical** between the two versions (sha256 `954d28be…`); so is `dist/index.js`                              |
| 🔴 Breaking (CLI-level)                      | 1        | `codex mcp-server` subcommand removed (#42993) — confirmed never invoked by DorkOS                                                        |
| 🟡 Deprecated                                | 2        | Detached review delivery (#42602), legacy Guardian approval paths (#43462) — both unreachable under `approvalPolicy: 'never'`             |
| 🔵 Behavioral (no compiler catches these)    | 5        | Server-side model defaults; client-version-keyed model cache; workspace-trust hardening; macOS sandbox hardening; Windows sandbox service |
| 🟢 Feature (relevant)                        | 2        | MCP OAuth refresh coordination (medium); MCP tool-catalog freshness + discovery diagnostics (medium)                                      |
| 🟢 Feature (low / unadopted)                 | 5        | Codex version in turn metadata, rate-limit usage capabilities, thread originators, app-server configurability, SQLite history resilience  |
| 🟢 Feature (not relevant)                    | ~8       | Managed worktrees, async inline questions, Vim mode, rich-text copy, agent command center, voice/WebRTC, Daybreak — all TUI-only          |
| 🔧 Fix (relevant)                            | 2        | Plugin/skill/hook refresh in existing sessions; zombie-process handling in the Unix PID backend                                           |
| ⚡ Performance                               | 5        | Passive — filesystem-scan avoidance, jemalloc on musl, exec-server metrics                                                                |
| ⚪ Internal                                  | ~200 PRs | Rust-CLI-internal; none touch the npm package's TS surface — proven by the byte-identical tarball, not inferred                           |
| New `ThreadEvent`/`ThreadItem` union members | **0**    | Exhaustiveness tripwire **cannot** fire — the unions are byte-identical                                                                   |

**Overall risk: LOW. Overall effort: LOW** (version bump across the family + verification; no source changes required, two comment permalinks worth refreshing).

## Risk

This is the quietest possible SDK bump. The packed npm tarballs for 0.153.4 and 0.154.0 differ in exactly one file — `package.json` — and in exactly two fields within it: `version`, and the `@openai/codex` dependency pin. `dist/index.d.ts`, `dist/index.js`, `dist/index.js.map`, `README.md`, and `LICENSE` are byte-for-byte identical. There is no type surface to break, no union to extend, and no runtime behavior change inside the npm package itself.

That shifts the entire risk surface to the vendored Rust CLI, which DorkOS touches through two channels: the SDK's typed JSONL event stream (turns), and the separate `codex app-server --stdio` process `model-catalog.ts` drives for account-aware model discovery. Three items live on those channels:

**1. Model defaults moved server-side (#43177, #43355, #43261, #42639) — the one to actually verify.** `turn-input.ts:84` passes `model` conditionally: `...(settings.model !== undefined ? { model: settings.model } : {})`. A DorkOS session with no explicitly chosen model sends no `model` field, which is precisely the "implicit model settings" path these PRs moved from bundled-catalog resolution to app-server resolution. The resolved model for such a session can differ after the bump. Note this interacts with something already in our pin: 0.153.4's #42874 made GPT-6-Astra _the bundled default when no model is explicitly configured_. The bundled default and the server-resolved default are now two different mechanisms answering the same question, and 0.154.0 prefers the latter. Low severity (both resolve to a valid account model), but it is a user-visible "which model did my agent just use" question and deserves the live turn.

**2. The Codex model cache is keyed by client version, and the bump invalidates it.** `model-context-windows.ts:116` returns an empty map whenever `parsed.data.client_version !== options.clientVersion`. After the bump the CLI writes `client_version: "0.154.0"` into its `models_cache.json`, while any cache left behind by 0.153.4 says `0.153.4`. Expect a transient first-run window with no context-window enrichment on the model catalog, resolving within the 300-second freshness window (`model-context-windows.ts:16`). **Self-healing, no code change** — recorded here so it is not misread as a regression during post-bump verification.

**3. Workspace-trust hardening (#42324 "Avoid executing PATH helpers before workspace trust", #42716).** This is the same class of change the 0.144.1→0.147.0 research flagged as its single live-smoke item (0.147.0's #36960/#36935). DorkOS spawns Codex against arbitrary agent working directories — `~/.dork/agents/*` and user project roots — that no human has interactively trust-approved. Tightening what may execute before trust is established is the one lever that could change headless behavior in an untrusted cwd. Inferred from PR titles, not observed; **this is the bump's designated live-smoke target**, and it should be run in a directory the resolved CLI has never seen.

Nothing else rises to a risk. The `codex mcp-server` removal (#42993) is confirmed unused — DorkOS's own `codex-ui-mcp-server.ts` is a config payload injected into `CodexOptions.config.mcp_servers`, not the removed subcommand, and the only CLI subcommand DorkOS spawns directly is `app-server --stdio` (`model-catalog.ts:156`). The entire Guardian block is unreachable under `approvalPolicy: 'never'`.

## Effort

**Low.** No source changes anticipated. The bump is mechanical across the family (full pin list below), then the standard checklist:

1. ✅ **Dist-tag check** — done. `latest` = 0.154.0 (stable, 2026-09-09). `alpha` = 0.155.0-alpha.3.10 and is byte-identical at the TS surface; nothing there justifies deviating from the stable target.
2. ✅ **`.d.ts` diff** of `ThreadEvent`/`ThreadItem` and the 7 imported item types — done. Zero changes; the files hash identically.
3. **Recompile** to confirm the event-mapper's `never` checks still pass (`event-mapper.ts:282` for `ThreadEvent`, `event-mapper.ts:434` for `ThreadItem`). Expected to be a no-op — but run it anyway; the step proves the tripwire was armed, it does not predict the result.
4. **Run the conformance suite**: `pnpm vitest run apps/server/src/services/runtimes/codex`. Note `__tests__/provision.test.ts:202-205` asserts `@openai/codex` and `@openai/codex-sdk` resolve to the same version string as `CODEX_PACKAGE_VERSION` — **this test fails by design until every pin in the family moves together**, which is exactly what makes it the guard against a half-done bump.
5. **Verify the model picker** (`contributing/adding-a-runtime.md` requires this after any bump): the `initialize` → `initialized` → paginated `model/list` exchange in `model-catalog.ts` against the newly resolved binary, confirming the account's models still parse through `AppServerModelSchema` (`model`, `displayName`, `description`, `isDefault`, `supportedReasoningEfforts`, optional `inputModalities`/`additionalSpeedTiers`). #43421/#43423 removed the upstream app-server README and its docs-update requirement, so this protocol is now **less documented upstream than at our current pin** — the live check is the only remaining verification.
6. **One live smoke turn**, watching specifically for (a) trust-prompt behavior in a fresh working directory, and (b) which model a session with unset `settings.model` resolves to.

Two cosmetic follow-ups that belong in the same commit: the source permalinks at `model-context-windows.ts:14-15` and `turn-context-usage.ts:257` pin `rust-v0.153.4` and should move to `rust-v0.154.0`, as should the `0.153.4` version references in `NOTES.md` (lines 196, 256, 307, 309, 311) and the `@openai/codex-sdk@0.153.4` mentions in `media-capture.ts:5`, `runtime-constants.ts:66`, `context-gate.ts:11`, `runtime-constants.ts:50`, `runtime-constants.ts:127`, and `__tests__/agent-context.test.ts:325`. Each of those comments asserts a fact about the pinned SDK's surface — and since the surface is byte-identical, **every one of those assertions remains true**; only the version number in the prose is stale.

## Detailed findings

### Surface-map verification (`.claude/config/runtime-deps.json`'s `sdk_surface_map`)

Grepped every `@openai/codex-sdk` import in `apps/server/src` and read each importing file:

| File                                                                                              | Imports                                                                                                                                                        | Matches surface map?                       |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `services/runtimes/codex/codex-runtime.ts:35`                                                     | `Codex` **only**                                                                                                                                               | **Drift** — map claims `CodexOptions` here |
| `services/runtimes/codex/codex-options.ts:17`                                                     | `CodexOptions`                                                                                                                                                 | **Drift** — file not in the map at all     |
| `services/runtimes/codex/mcp-server-config.ts:37`                                                 | `CodexOptions`                                                                                                                                                 | Yes                                        |
| `services/runtimes/codex/turn-input.ts:15`                                                        | `ModelReasoningEffort`, `SandboxMode`, `ThreadOptions`                                                                                                         | Yes, exact match                           |
| `services/runtimes/codex/event-mapper.ts:29-39`                                                   | `AgentMessageItem`, `CommandExecutionItem`, `FileChangeItem`, `McpToolCallItem`, `ReasoningItem`, `ThreadEvent`, `ThreadItem`, `TodoListItem`, `WebSearchItem` | Yes, exact match                           |
| `services/runtimes/codex/__tests__/accounts-live-fixture.ts:77`                                   | `Thread` (dynamic `await import`)                                                                                                                              | Test fixture — not part of the map         |
| `services/runtimes/codex/__tests__/*.ts`, `routes/__tests__/sessions-list-aggregation.test.ts:63` | `ThreadEvent`, plus `vi.mock` factories                                                                                                                        | Test files — not part of the map           |

**Surface-map drift (config NOT edited per task instructions — exact corrections listed here):**

The current entry reads:

```
"Codex, CodexOptions": "codex-runtime.ts, mcp-server-config.ts"
```

This is wrong in both directions. `codex-runtime.ts` no longer imports `CodexOptions` at all — that import moved into a new file, `codex-options.ts`, which the map does not mention. Correct it to three entries:

```
"Codex": "codex-runtime.ts",
"CodexOptions": "codex-options.ts, mcp-server-config.ts",
"ThreadEvent, ThreadItem (+ AgentMessageItem, CommandExecutionItem, FileChangeItem, McpToolCallItem, ReasoningItem, TodoListItem, WebSearchItem)": "event-mapper.ts",
"ThreadOptions, SandboxMode, ModelReasoningEffort": "turn-input.ts"
```

(The last two entries are unchanged and already correct.) This drift predates the current bump: it was introduced when `codex-options.ts` was extracted, somewhere in the undocumented 0.147.0 → 0.153.4 window. All four files live under `services/runtimes/codex/`, so Hard Rule 2 (SDK import confinement) is intact throughout — the map is stale, not the code.

**A second, structural gap worth adding to `upgrade_notes`** — also inherited from the undocumented 0.147.0 → 0.153.4 window: `sdk_surface_map` maps _SDK imports_ to files, so by construction it cannot see the **app-server protocol path**, which imports nothing from the SDK but is version-coupled to the CLI pin just as tightly. `model-catalog.ts` spawns `codex app-server --stdio` and speaks `initialize`/`initialized`/`model/list` by hand; `model-context-windows.ts` parses the CLI's own `models_cache.json` and **rejects it on a `client_version` mismatch**. Both break silently on a CLI change that no `.d.ts` diff can reveal. The skill and `contributing/adding-a-runtime.md` already tell you to verify the model picker after a bump; the config's `upgrade_notes` should name these two files so the reason survives. Suggested addition:

> "The CLI pin is version-coupled beyond the SDK's type surface: `model-catalog.ts` speaks the app-server `initialize` + paginated `model/list` protocol directly, and `model-context-windows.ts` rejects Codex's own `models_cache.json` cache whenever its `client_version` differs from the running binary — so every CLI bump invalidates that cache for one 300-second freshness window. Neither file imports the SDK, so no `.d.ts` diff will ever flag them."

### ADR conflicts

- **ADR-0255** (per-session runtime binding in `session_metadata`, first-write-wins): **unaffected.** Nothing in this release touches session↔runtime binding.
- **ADR-0309** (Codex adapter: SDK threads mapped to DorkOS sessions): **no conflict, no resolution.** Its standing negative consequence — "No SDK thread-listing API means past Codex sessions are not rediscovered after a DorkOS server restart" — is **unchanged**. 0.154.0's substantial thread-side work (managed worktrees, thread naming, session-label resolution #43315, archive rollout reads #43494) is all CLI/app-server-only; `Thread` still exposes only `id`/`run`/`runStreamed`, so the gap does not close. The ADR's other claims hold: the 8-member event union is byte-identical, there is still no interactive approval channel, and the `logs_2.sqlite` consequence was already marked resolved at the 0.147.0 bump.
- **ADR-0310** (runtime-owned session storage, registry-aggregated listing with per-runtime degradation): **unaffected.** No new SDK method appeared that would change how `listSessions`/`getMessageHistory` work for this adapter.

No ADR needs an update for this bump.

### Breaking changes

**Zero in the SDK's typed surface** — established by hash equality, not inspection. The single CLI-level removal (`codex mcp-server`, #42993) is confirmed unused: DorkOS's only direct CLI invocation is `['app-server', '--stdio']` at `model-catalog.ts:156`, and turns go through the SDK, which spawns the binary itself. **Effort: none.**

### Deprecations

Both deprecations (#42602 detached review delivery, #43462 legacy Guardian approval paths) sit inside the CLI's approval/review subsystem, which DorkOS cannot reach: `turn-input.ts:81` sets `approvalPolicy: 'never'` on every turn and the runtime declares `supportsToolApproval: false` (NOTES.md Verdict 1 — approval-requiring calls are auto-cancelled in exec mode; the sandbox is the enforcement boundary, Verdict 2). **Effort: none.**

### Features — relevance assessment

| Feature                                                                                                                          | Relevance               | Effort if adopted                                                     | Dependencies                  | Value to DorkOS                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP OAuth refresh coordination, auth challenges surfaced, no auto-replay of rejected tool calls (#42413, #42552, #43428, #42384) | **Medium**, passive     | None                                                                  | none                          | Highest-value item in the release for DorkOS. `mcp-server-config.ts` folds OAuth-header-bearing managed MCP servers (via `agent-mcp-server-service.mergeOAuthHeaders`) into the Codex config; coordinated refresh stops concurrent tool calls racing one token refresh, and no-auto-replay removes a duplicate-side-effect hazard. Direct de-risking of DOR-892 with zero DorkOS work |
| MCP tool-catalog freshness + discovery diagnostics (#43031, #43039, #42598, #42406, #42370)                                      | **Medium**, passive     | None                                                                  | none                          | Same DOR-892 surface: a managed MCP server whose tool list changes mid-session is now picked up instead of going stale, and startup failures become diagnosable rather than silent                                                                                                                                                                                                    |
| Plugin/skill/hook refresh in existing sessions (#42284, #42593, #42990)                                                          | **Medium**, passive     | None                                                                  | none                          | DorkOS projects `.agents/` skills and plugins through `@dorkos/harness`; a long-lived Codex session that missed a projection refresh is a real failure mode this closes                                                                                                                                                                                                               |
| Server-advertised permission profiles (#42453)                                                                                   | **Low-medium**          | Moderate — new discovery call + reconciliation with `MODE_TO_SANDBOX` | app-server protocol extension | The only item here with a plausible future adoption: DorkOS hardcodes `MODE_TO_SANDBOX` (`turn-input.ts:32`) rather than discovering what the resolved CLI supports. **Not for this bump** — it is a separate spec if ever wanted                                                                                                                                                     |
| SQLite history projection survives invalid records (#42369)                                                                      | **Low**, passive        | None                                                                  | none                          | Same family as the `logs_2.sqlite` defect ADR-0309 tracked; a corrupt record no longer halts the projection                                                                                                                                                                                                                                                                           |
| Codex version exposed to commands/turn metadata (#42395)                                                                         | **Low**                 | Low, if ever needed                                                   | none                          | DorkOS already derives the version from the app-server `initialize` `userAgent` (`parseCodexAppServerVersion`); a second source is only interesting if that parse proves fragile                                                                                                                                                                                                      |
| Rate-limit reads extended with usage capabilities (#42358)                                                                       | **Low**                 | n/a                                                                   | n/a                           | Would matter only if DorkOS surfaced Codex quota/usage in the UI; no such surface exists                                                                                                                                                                                                                                                                                              |
| Thread originators through the app-server API (#42458, #42445)                                                                   | **Low**                 | n/a                                                                   | n/a                           | DorkOS already identifies as `dorkos/<version>`; reading originators back is not needed                                                                                                                                                                                                                                                                                               |
| App-server thread unload delay, always-available realtime sessions, experimental-feature discovery (#42320, #42377, #42425)      | **Low**                 | n/a                                                                   | n/a                           | `model-catalog.ts` speaks a deliberately minimal protocol slice; no reason to widen it                                                                                                                                                                                                                                                                                                |
| GPT-6-Astra in picker and Bedrock catalogs (#42879, #42619, #42607)                                                              | **None (already ours)** | n/a                                                                   | n/a                           | Backported to 0.153.1–0.153.4 (#42605, #42805, #42874) and already running at our current pin — the 0.154.0 notes describe mainline landing, not a new-model event                                                                                                                                                                                                                    |
| Managed worktrees (#42196, #42652, #43069, #43120, #43286, …)                                                                    | **None**                | n/a                                                                   | n/a                           | CLI/TUI-only; no typed `Thread` method appeared, so it does not close ADR-0309's thread-listing gap. Conceptually overlaps DorkOS's own worktree workflow but is unreachable                                                                                                                                                                                                          |
| Inline async questions (#42354, #42891, #42894, #42897)                                                                          | **None**                | n/a                                                                   | n/a                           | TUI composer feature; DorkOS turns are headless `runStreamed()` with no mid-turn input channel (`supportsSteer: false`, NOTES.md)                                                                                                                                                                                                                                                     |
| Vim replace mode, rich-text copy, agent command center, Astra sparkles, live compaction status                                   | **None**                | n/a                                                                   | n/a                           | TUI-only rendering and input features                                                                                                                                                                                                                                                                                                                                                 |
| Voice / WebRTC / GStreamer block (~18 PRs)                                                                                       | **None**                | n/a                                                                   | n/a                           | Separate Realtime path; the adapter is text-only                                                                                                                                                                                                                                                                                                                                      |
| Windows daemon + sandbox provisioning service (~20 PRs)                                                                          | **None today**          | n/a                                                                   | n/a                           | DorkOS dev and server run macOS/Linux. Material background for the Windows desktop alpha if it ever routes Codex sessions through the same server path                                                                                                                                                                                                                                |

### Behavioral changes no compiler catches

The category that carries this bump's entire real risk, restated compactly for the upgrade spec:

| Item                                                                | Where it bites                                       | Action                                                         |
| ------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------- |
| Model defaults resolve server-side (#43177, #43355, #43261, #42639) | `turn-input.ts:84` omits `model` when unset          | Live turn with `settings.model` unset; confirm resolved model  |
| Model cache keyed by client version                                 | `model-context-windows.ts:116` strict equality check | Expect one empty-map window ≤300s post-bump; no code change    |
| Workspace-trust hardening (#42324, #42716)                          | Codex spawned against untrusted agent cwds           | **Designated live-smoke target** — fresh, never-seen directory |
| macOS sandbox hardened vs terminal input injection (#42590)         | The actual enforcement boundary (NOTES.md Verdict 2) | None — pure upside                                             |
| Windows sandbox provisioning service (~16 PRs)                      | Windows desktop alpha only                           | None today; note for the Windows surface                       |

### TODO/FIXME/HACK/WORKAROUND audit

`grep -rn "TODO\|FIXME\|HACK\|WORKAROUND" apps/server/src/services/runtimes/codex/` returns **two hits, both false positives** — `event-mapper.ts:709` and `:734` reference a `CLEARED_TODO_TASK` constant for the `todo_list` item type, which is the SDK's own domain vocabulary, not a pending-work marker. There are no outstanding code-level workarounds in the adapter that this release could resolve.

`NOTES.md`'s "open items flagged for live re-verification" (line 238) remain the adapter's real pending list. Relative to this release:

- **resume-after-interrupt** — not advanced by anything in 0.154.0 (the 0.146.0 interruption/replay fixes were the relevant ones and are already in our pin). Still open.
- **no-approval-payload under `never` policy** — 0.154.0's Guardian churn is all inside paths this policy excludes; nothing to re-verify, but the live smoke turn confirms it for free.
- **`web_search` / `mcp_tool_call` under a read-only sandbox** — unchanged; the MCP reliability fixes above make this marginally more likely to behave, not less.
- **`on-failure` `ApprovalMode` drift** — the `.d.ts` is byte-identical, so `ApprovalMode` still types `on-failure`. Unresolved drift to keep watching; inert either way since DorkOS only ever sends `'never'`.

`NOTES.md`'s substantive verdicts (supportsSteer/supportsContextStaging false, the current-context usage semantics verified 2026-09-08 against 0.153.4) all rest on SDK-surface facts that are byte-identical at 0.154.0, so **they carry forward unchanged** — only their version labels need refreshing.

### Note on the undocumented 0.147.0 → 0.153.4 window

The codebase moved from 0.147.0 to 0.153.4 without a research doc (the work landed under spec `codex-session-reliability`, which records the reasoning). Two artifacts from that window are still unrecorded in the runtime-deps config and matter beyond this bump, both flagged above rather than silently carried: the `sdk_surface_map` drift (`codex-options.ts` extracted, `CodexOptions` no longer in `codex-runtime.ts`), and the structural blind spot that the app-server protocol path (`model-catalog.ts`, `model-context-windows.ts`) is CLI-version-coupled while importing nothing from the SDK — so no `.d.ts` diff will ever warn about it. Both corrections are listed verbatim under "Surface-map verification" for whoever edits the config next.

## The bump commit: the whole family moves together

`__tests__/provision.test.ts:202-205` asserts these resolve to one version, so a partial bump fails the suite by design. Every site holding `0.153.4` in the main checkout:

| File                                                            | Line(s) | Current                                                                               |
| --------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------- |
| `apps/server/package.json`                                      | 48, 49  | `"@openai/codex": "0.153.4"`, `"@openai/codex-sdk": "~0.153.4"`                       |
| `packages/cli/package.json`                                     | 68, 69  | `"@openai/codex": "0.153.4"`, `"@openai/codex-sdk": "~0.153.4"`                       |
| `apps/desktop/package.json`                                     | 37, 38  | `"@openai/codex": "0.153.4"`, `"@openai/codex-sdk": "~0.153.4"`                       |
| `apps/desktop/package.json` (optionalDependencies, npm aliases) | 25, 26  | `npm:@openai/codex@0.153.4-darwin-arm64`, `npm:@openai/codex@0.153.4-win32-x64`       |
| `apps/server/src/services/runtimes/codex/provision.ts`          | 34      | `export const CODEX_PACKAGE_VERSION = '0.153.4';`                                     |
| `pnpm-lock.yaml`                                                | —       | Regenerate: 6 per-platform `@openai/codex@0.153.4-*` entries plus the three importers |

Plus the test fixtures and prose that name the version (no behavioral content, but they will read as stale):

- `apps/server/src/services/runtimes/codex/__tests__/provision.test.ts:202-205` (the lockstep assertion itself)
- `apps/server/src/services/runtimes/codex/__tests__/model-catalog.test.ts:244, 261, 278, 296`
- `apps/server/src/services/runtimes/codex/__tests__/model-context-windows.test.ts:23, 49-52, 59, 61, 73, 92, 102, 114`
- `apps/server/src/services/runtimes/codex/model-context-windows.ts:12-15, 49-50` (source permalinks → `rust-v0.154.0`)
- `apps/server/src/services/runtimes/codex/turn-context-usage.ts:254, 257` (source permalink → `rust-v0.154.0`)
- `apps/server/src/services/runtimes/codex/NOTES.md:196, 256, 307, 309, 311`
- `apps/server/src/services/runtimes/codex/media-capture.ts:5`, `runtime-constants.ts:50, 66, 127`, `context-gate.ts:11`, `__tests__/media-capture.test.ts:7`, `__tests__/agent-context.test.ts:325`

Ignore `apps/server/dist/` and `packages/cli/dist/` — build output, regenerated. The `.claude/worktrees/dor-1931-spec/` copies belong to another worktree and are not this commit's concern.

## Alpha watch

`0.155.0-alpha.3.10` (the `alpha` dist-tag, published 2026-09-11) has a `dist/index.d.ts` **and** `dist/index.js` byte-identical to 0.154.0 stable — which is itself byte-identical to our current 0.153.4. The only delta is its `@openai/codex` pin. All seven `rust-v0.155.0-alpha.*` GitHub releases have empty bodies. **There is nothing alpha-only to weigh, and no reason to deviate from the stable 0.154.0 target.** See `changelog.md` for detail.
