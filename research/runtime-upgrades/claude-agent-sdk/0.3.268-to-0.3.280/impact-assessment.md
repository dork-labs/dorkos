# Impact Assessment: @anthropic-ai/claude-agent-sdk 0.3.268 → 0.3.280

**Generated**: 2026-09-22
**Codebase root**: `apps/server/src/services/runtimes/claude-code/`
**Abstraction boundary**: `AgentRuntime` interface (`packages/shared/src/agent-runtime.ts`), enforced by ADR-0089 / Hard Rule 2
**Related ADRs**: 0089 (SDK import confinement), 0143 (retry depth over circuit breaker), 0239 (plugin activation via `options.plugins`), 0240 (permission-mode passthrough); also touched: 0261 (always launch with `allowDangerouslySkipPermissions`)
**Companion**: [`changelog.md`](./changelog.md)
**Predecessor**: [`../0.3.224-to-0.3.268/impact-assessment.md`](../0.3.224-to-0.3.268/impact-assessment.md)

## Summary

| Category                              | Count | Action Required                                                                                    |
| ------------------------------------- | ----- | -------------------------------------------------------------------------------------------------- |
| Breaking changes — compile-level      | 0     | None predicted (type diff read against every DorkOS import; not yet confirmed by a real typecheck) |
| Breaking changes — behavioral, act    | 2     | Opus alias retarget (wanted, verify labels and cost); cumulative `modelUsage` on resume            |
| Breaking changes — behavioral, verify | 4     | Plan-mode gating (0.3.269); empty queued results (0.3.274); elicitation cancel + state (0.3.280)   |
| Breaking changes — no DorkOS usage    | 6     | No action (documented below)                                                                       |
| Deprecations                          | 2     | None; DorkOS sets neither no-op setting                                                            |
| Features (high)                       | 2     | 1 include in the bump PR (MCP `source`), 1 is zero-code (Opus 5.5)                                 |
| Features (medium)                     | 5     | 1 fold into the carried-forward error spec, 3 separate specs, 1 skip for now                       |
| Features (low/none)                   | 19    | No action                                                                                          |
| Fixes resolving DorkOS exposure       | 8     | Auto-resolved by the bump                                                                          |
| Workarounds that can be retired       | 0     | **#454 is still open and still reproduces at 0.3.280.** Keep the `catchall` swap                   |

**Overall risk: LOW–MEDIUM.** No compile break, no change to the `SDKMessage` union, no packaging change, and every non-import coupling either holds or moved in a direction DorkOS already defends against. The medium part is two silent changes: the `opus` alias now runs a different model at a different price, and resumed sessions now report cumulative usage from before the resume, which DorkOS reads as one turn's totals.

**Estimated total effort**: **2–4 hours** for the bump (7 pin sites, one trivial trust fix, doc re-stamps on 3 coupling files, conformance suite, live checks). Separate specs are not bump scope.

---

## Opus 5.5 availability

The operator wants Claude Opus 5.5 (`claude-opus-5-5`) selectable in DorkOS. **The bump to 0.3.280 is what delivers it, and nothing in DorkOS needs to change for it to appear.**

### (a) Which versions know it — verified by string reads of the shipped binary

The model catalog lives in the platform binary (`@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`), not in `sdk.mjs` or `sdk.d.ts`: neither JS file mentions any model id at either version.

| Binary      | `claude-opus-5-5` | `Opus 5.5` | `opus` alias default (first-party) |
| ----------- | ----------------- | ---------- | ---------------------------------- |
| 0.3.268     | 0 hits            | 0 hits     | `claude-opus-5`                    |
| 0.3.278     | 0 hits            | 0 hits     | (not read; no 5.5 string present)  |
| **0.3.280** | 41 hits           | 17 hits    | **`claude-opus-5-5`**              |

At 0.3.280 the catalog entry reads `{id:"claude-opus-5-5",family:"opus",display_name:"Opus 5.5",knowledge_cutoff:"June 2026",…context:{window:1e6,native_1m:!0,…},max_output_tokens:{default:128000,upper:128000},pricing:"tier_4_20_cache_read_0_20",…}`, and `aliases:{opus:{default:"claude-opus-5-5",per_provider:{bedrock:"claude-opus-5-5",vertex:"claude-opus-5-5",foundry:"claude-opus-4-6",mantle:"claude-opus-5-5",anthropic_aws:"claude-opus-5-5",gateway:"claude-opus-4-7"}}…`. The picker builders produce `{value:"opus",label:"Opus",description:"Opus 5.5 · …"}` and `{value:"opus[1m]",label:"Opus (1M context)",description:"Opus 5.5 for long sessions…"}`. Only 1 of the 8 platform binaries was read (darwin-arm64); the other seven are assumed to carry the same catalog since they are built from one source. That assumption is **unverified**.

### (b) First version

**0.3.280.** 0.3.278 has no trace of it and 0.3.279 was never published. This matches the Claude Code 2.1.280 changelog: "Added Claude Opus 5.5 (`claude-opus-5-5`), now the default Opus model — 1M context, $4/$20 per Mtok with $0.20/Mtok cache reads".

**No other route delivers it at 0.3.268.** DorkOS's live model caches, written today by 0.3.268 (`~/.dork/cache/runtimes/claude-code/models.json` at 2026-09-22T20:00Z and the dev cache at 17:18Z), still resolve `opus` → `claude-opus-5` and `default` → `claude-opus-5[1m]`. So no server-side catalog update reached the old binary. Whether the CLI can fetch a remote catalog at all was not established; the observation is only that one had not done so by 20:00Z.

### (c) What in DorkOS could hide it or tier it wrongly

Checked one by one. None hides it.

- **What `supportedModels()` returns.** The cache shows six rows at 0.3.268: `default`, `opus[1m]`, `claude-fable-5-1[1m]`, `sonnet`, `haiku`, `opus`. The rows are **aliases**, not versioned ids. So after the bump Opus 5.5 shows up as the existing **"Opus"** and **"Opus (1M context)"** rows (their `resolvedModel` becomes `claude-opus-5-5` / `claude-opus-5-5[1m]`, their description says "Opus 5.5"), and as **"Default (recommended)"** wherever the account's default is Opus. There will probably be no separate row labelled "Opus 5.5", and no row for Opus 5 any more unless the CLI keeps one. What the live 0.3.280 list contains is **unverified**: it needs one warm-up after the bump.
- **`inferTier`** (`messaging/runtime-cache.ts`) matches `value.includes('opus')`, so `opus`, `opus[1m]` and `claude-opus-5-5` all get `tier: 'flagship'` and `supportsVision: true`. `default` gets neither, which is unchanged from today.
- **`extractFamily`** (`/^(claude-\w+-\d+)/`). On an alias it returns `undefined`, as it does today. On a full id `claude-opus-5-5` it returns `claude-opus-5`, the same family as Opus 5, because `\w` stops at the hyphen. Harmless: no client code reads `ModelOption.family`. The only consumer found is the schema field itself (`packages/shared/src/schemas.ts`). Worth a doc-comment fix if anyone relies on it later.
- **The model cache is invalidated by the bump.** `RuntimeCache` rejects a disk cache whose `sdkVersion !== CLAUDE_SDK_VERSION`, and `CLAUDE_SDK_VERSION` in `tooling/provision.ts` is one of the seven pin sites. Moving it forces a fresh `supportedModels()` read. If it were left at 0.3.268, a stale list saying "Opus 5" would be served until the TTL ran out.
- **Status line** (`apps/client/src/layers/features/status/lib/status-labels.ts`). It uses the catalog `displayName` ("Opus") and otherwise falls back to `/claude-(\w+)-/` → "Opus". It never shows "5.5" on its own, which is the same behavior every earlier Opus had.
- **No hard-coded default model.** `grep` for `claude-opus-*` across `apps/` and `packages/` finds no default-model constant. Every hit is a doc example, a test-mode `DEMO_MODEL = 'claude-sonnet-4-5'`, dev-playground mock data (`claude-opus-4-6`), or OpenRouter catalog prose. No allowlist can filter the new id out.
- **OpenCode / OpenRouter** tiers come from OpenRouter's live catalog (`opencode/providers/openrouter.ts`), not from this SDK. Opus 5.5 appears there whenever OpenRouter lists it. The bump has no bearing on it.
- **`provision.ts` re-check.** `ModelInfo` still reports nothing capability-shaped at 0.3.280 (no `supportsVision` / `supportsToolUse` / `supportsImageOutput`), so the asserted capabilities in `mapSdkModelToModelOption` stand.

**Consequences to name in the bump PR.** Every existing session or agent whose model is `opus`, `opus[1m]` or `default` (on an Opus-default account) moves to Opus 5.5 on the first launch after the bump. Its price moves with it: the catalog prices Opus 5.5 as `tier_4_20` and Opus 5 as `tier_5_25`. DorkOS has no switch that would keep them on Opus 5, short of a full id. If the operator wants Opus 5 to stay selectable, check the post-bump list. Pinning `claude-opus-5` by id still works because the CLI keeps the catalog entry.

**Verification owed**: one warm-up after the bump, then read `models.json` to confirm `resolvedModel: "claude-opus-5-5"` on the `opus` rows. Then pick "Opus" in the app's model picker and confirm the turn's `system/init` reports `model: claude-opus-5-5`.

---

## Surface-map drift found

Re-derived by parsing every `import … from '@anthropic-ai/claude-agent-sdk'` in `apps/server/src`, excluding `__tests__/` and `*.test.ts`. Result: **45 non-test files, 27 distinct symbols, all under `services/runtimes/claude-code/`** (ADR-0089 holds; zero imports outside the adapter). Reported, not edited.

| Config claim                                               | Reality                                                                                                                                                                                   | Correction       |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `$comment`: "25 distinct symbols across 55 non-test files" | **27 symbols, 45 files** (55 is not reproducible; 111 is the count with tests)                                                                                                            | Fix both numbers |
| `"Query": "9 files: …"`                                    | **10**: add `claude-code-runtime.ts`                                                                                                                                                      | Add file         |
| `"SDKMessage": "14 files: …"`                              | **15**: add `messaging/process-quiet.ts` (new since the last bump, #1898 / #1906)                                                                                                         | Add file         |
| `"tool()": "mcp-tools/*.ts (13 files …)"`                  | **11 files**: `adapter-tools`, `agent-tools`, `binding-tools`, `capability-mcp-tools`, `core-tools`, `extension-tools`, `index`, `mesh-tools`, `relay-tools`, `task-tools`, `trace-tools` | Say 11           |
| _(missing)_                                                | **`HookCallback`, `HookJSONOutput`** → `messaging/classifier-context.ts` (the PostToolUse classifier-context hook, #1817)                                                                 | Add entry        |
| All other entries                                          | Match exactly                                                                                                                                                                             | none             |

**`non_import_couplings` edits needed** (results below): the `sdk-utils.ts` entry should drop the android remark, since that branch is gone. The abort-predicate entry should record `permission-stop` as the fourth suppressed cause. The `plugin-activation.ts` entry can say "unchanged at 0.3.280". The `mcp-revocation.ts` entry should note the 0.3.274 first-turn wait change and that a live re-run is owed.

**`upgrade_notes` edit needed**: the #454 note should say "still OPEN and still reproducing at 0.3.280 with zod 4.6.5 (2026-09-22); the root cause is the bundled `zod-to-json-schema@3.25.2`, the latest published version, per the 2026-09-21 upstream comment".

---

## Breaking changes — detailed impact

### 1. `opus` alias → Claude Opus 5.5 (0.3.280): **behavioral, wanted, act**

See the **Opus 5.5 availability** section. **Effort: zero code.** Name the model and price change in the PR body and changelog fragment, and run the live check.

### 2. Resumed / forked sessions carry cumulative totals (0.3.277): **behavioral, exposed, act**

- **What changed**: after a resume, the first `result`'s `modelUsage` and `total_cost_usd` include every earlier turn.
- **DorkOS exposure**: `sdk/event-mappers/result-event-mapper.ts` sums `modelUsage` across models into `turnInputTokens` / `turnOutputTokens` / `turnThinkingTokens`, and its comment calls these "Turn TOTALS … the sum across every request in the turn". `services/observability/ai-metadata.ts` then records them as the per-turn `gen_ai.*` generation figures. The persistent pump relaunches with `resume` routinely, so after this change the first turn of every relaunch reports the whole session's tokens as one turn's.
- **Pre-existing, and now wider**: the `.d.ts` has said since before 0.3.268 that `modelUsage` is "cumulative across turns in streaming-input sessions: each result carries the running total so far". If that holds, the "turn totals" already over-count from the second turn of a warm pump. **Unverified whether this is observed in practice.** Check one warm multi-turn session's `turnInputTokens` sequence before and after.
- **Session cost** (`costUsd = result.total_cost_usd` → `session-event-normalizer.ts` `status.cost`) gets **more** correct: today it silently restarts at zero after each relaunch.
- **Effort**: moderate (6–30 lines). Take a delta against the previous result's cumulative figures per session, with a reset on `/clear`. Upstream already hints at the shape ("read the latest result rather than summing across results").
- **Recommendation**: **include in the bump PR** if the live check shows over-counting. Otherwise a one-line comment correction plus a follow-up issue. ADR conflicts: none.

### 3. Plan mode routes writes through `canUseTool` despite `allowDangerouslySkipPermissions` (0.3.269): **behavioral, exposed, verify**

- `messaging/launch-resolver.ts` sets `sdkOptions.allowDangerouslySkipPermissions = true` on **every** launch (ADR-0261). Its comment claims the flag is "verified inert in default/acceptEdits/plan, which still route to canUseTool". The 0.3.269 note says plan mode did **not** route writes through `canUseTool` while that flag was set, until 0.3.269. So at 0.3.268 the ADR-0261 claim was probably **false for plan mode's writes**, and the bump makes it true. DorkOS's own table (`resolveModeDecision`: `case 'plan'` → `'ask'`) never saw those calls.
- **Effort**: zero code. The fix works in DorkOS's favor. **Verify** with one plan-mode turn that attempts a write, and confirm an approval card appears. Then decide whether the ADR-0261 "verified" wording needs a dated amendment. Whether any write actually slipped past plan mode on ≤0.3.268 is **unverified**.

### 4. Queued background-task completions share one model call (0.3.274): **behavioral, exposed, verify**

- N queued completions now produce N `result`s, all but the last **empty with `num_turns: 0`**. `sessions/session-turn-windows.ts` closes windows from each result's `user_message_uuids`, and `result-event-mapper.ts` emits a `done`-shaped status per result. Those empty results carry no model work, so a "turn done" per empty result is noise, and a DOR-1314-style wait decision may fire early. `persistent-dispatch.ts` and the turn windows were built to handle synthetic, runtime-origin turns, so it is **likely benign**. No fixture covers an empty `num_turns: 0` result, though.
- **Effort**: verify (one session with two background Bash tasks finishing close together). Trivial fix if needed: skip the done-status for `num_turns === 0` results with no content.

### 5. MCP elicitation: `requires_action` state and cancel-on-tool-end (0.3.280): **behavioral, exposed, verify**

- DorkOS sets `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1'` (`launch-resolver.ts`), and `sdk/event-mappers/system-event-mapper.ts` already maps `session_state_changed` including `requires_action`. A pending elicitation now reports `requires_action`, which is **strictly more accurate** for DorkOS's needs-attention surfaces.
- Cancel-on-tool-end: `onElicitation` in `messaging/interactive-handlers.ts` listens on the SDK `signal` and tears the card down on abort. The card should therefore close when the CLI cancels the form. Whether the CLI's cancel reaches that `AbortSignal` is **unverified**. Verify with one MCP elicitation whose tool call is interrupted.

### 6–11. Breaking changes with zero DorkOS exposure: **verified, no action**

| Change                                                                          | Why DorkOS is unaffected                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TaskOutputInput` / `REPLInput` / `REPLOutput` removed from `./sdk-tools`       | Zero references to `./sdk-tools`, `TaskOutput` or `REPL` anywhere in `apps/` or `packages/`                                                                                                                                                              |
| `MonitorInput.persistent` removed                                               | Zero references to `MonitorInput`                                                                                                                                                                                                                        |
| `user_message_uuid` also on the first complete assistant message (0.3.269)      | DorkOS reads the uuid **only off `result` messages** (`session-turn-windows.ts` answered-id read; `turn-liveness.ts` on the closing result). `includePartialMessages: true` is set, so duplicates will arrive, but on frames nobody reads the field from |
| First turn no longer awaits deferred-tool settings/plugin MCP servers (0.3.274) | DorkOS's own tool server rides `options.mcpServers`, still awaited. The effect on external servers is covered under coupling 4                                                                                                                           |
| `Stop` / `SubagentStop` / `SessionStart` hook timeouts = no decision (0.3.273)  | DorkOS registers only `PreToolUse` and `PostToolUse` (`launch-resolver.ts`)                                                                                                                                                                              |
| `"type": "sdk"` MCP entries in config files skipped (CC 2.1.274)                | DorkOS registers its in-process server through `options.mcpServers`, never a config file. This actually **closes** a spoofing path, see feature 1                                                                                                        |

---

## Deprecation migrations

**None owed.** `taskOutputMaxChars` and `skipLfs` became no-ops. `grep` finds neither in `apps/` or `packages/`. The five `@deprecated` tags are unchanged.

---

## Recommended feature adoptions

### HIGH: `McpServerProvenance` / `canUseTool` `mcpServer.source` (0.3.274): **include in the bump PR**

- **What**: `canUseTool` options now carry `mcpServer: { name, source }`. `source === 'sdk'` is unforgeable: "only the host can register one, so a configured server of the same name never reads `sdk`". The SDK doc says in as many words: "Key trust decisions on `source`, not on the name or the tool-name prefix."
- **Why it matters to DorkOS**: DorkOS keys trust on the name today. `messaging/interactive-handlers.ts` auto-allows any call whose `toolName` is in `READ_ONLY_TOOLS` / `DORKOS_AGENT_TOOLS`, sets built with `inSessionToolName(…)` = `mcp__dorkos__<tool>` (`IN_SESSION_TOOL_PREFIX`, `mcp-tools/tool-exposure.ts`). A project `.mcp.json` server that names itself `dorkos` and exposes a tool called `mesh_register` or `memory_write` presents the same tool name. How the CLI resolves such a name collision is **unverified**, and it may never reach `canUseTool` with the configured server's tool. But the auto-allow gate should not have to depend on that. `messaging/classifier-context.ts` keys its classifier note on the same prefix.
- **Effort**: trivial (≤5 lines). Add `&& (context.mcpServer === undefined || context.mcpServer.source === 'sdk')` to the auto-allow condition. The field is absent for non-MCP tools and on older CLIs, so absent must keep today's behavior for the built-ins in `READ_ONLY_TOOLS`. `PostToolUse` input carries `mcp_server` too, for the classifier-context hook.
- **Test**: one unit test per branch (source `sdk` → auto-allow; source `project` with the same tool name → falls to the mode table).
- **ADR conflicts**: none. It narrows auto-approval, the direction DOR-519 argued for.

### HIGH: Claude Opus 5.5: **zero code; in the bump**

See the dedicated section above.

### MEDIUM: `startup_failure_reason` / `SDKStartupFailureReason` (0.3.274): **fold into a separate "structured result errors" spec together with `api_error_status`**

Sixteen machine-readable reasons a run refused to start (`cwd_unavailable`, `shell_tool_missing`, `cli_version_too_old`, `bypass_root`, `session_held_by_background`, the org-pin family, and so on). `sdk/sdk-error-mapping.ts` has no startup-failure branch today; such a run surfaces as generic error text. Several reasons have a clear fix a person could be offered ("the folder this agent works in was moved or deleted"). Some need `CLAUDE_CODE_STARTUP_FAILURE_RESULTS` in the env to be emitted at all. `bypass_root` is directly relevant: DorkOS always launches with the bypass capability (ADR-0261), which could hit it on a root-run server or container. **Effort: moderate.** It needs user-facing copy per reason (writing-for-humans), which is why it is a spec. It shares the error-mapping surface with `api_error_status`, which is still unadopted after three bumps, so doing both together retires that carry-forward.

### MEDIUM: `verbatimPrompts` / per-message `client_composed` (0.3.280): **separate spec**

DorkOS feeds the CLI text a person did not type: relay deliveries, room turns, scheduled-task prompts, agent-to-agent messages. The CLI currently runs `@path` expansion and slash-command dispatch on that text, so a room message containing `/something` or `@~/.ssh/config` is interpreted, not delivered. Per-message `client_composed: true` on those deliveries is the targeted lever. The global `verbatimPrompts` is wrong for DorkOS because the operator's own typed prompts need both features. **The cost is real**: on current CLIs the flag also skips the turn-start attachment pass (nested `CLAUDE.md`, rules files, skill and tool listings), which arrives only after the first tool call. That changes agent behavior on exactly the turns rooms care about. A product and security decision, so a spec. **Effort: moderate.**

### MEDIUM: `readMcpResource()` + `tools[]._meta` (0.3.280, alpha): **separate spec, wait for it to leave alpha**

DorkOS's MCP Apps host (`routes/session-mcp-app-resource-handler.ts`, `resolveAppResource`, ADR `260708-141143`) dials each server itself with a short-lived client built from a server-only cache of stdio/http configs (`RuntimeCache`'s per-cwd MCP config map). `readMcpResource` reads through the connection the CLI already holds, which removes the second connection, the config cache and its stdio-command handling. It would also work for OAuth servers whose credentials only the CLI holds. `_meta` on `mcpServerStatus()` gives the `ui://` resource URI without DorkOS parsing it. **Effort: moderate–significant**, and the method is `@alpha`. Revisit when it stabilizes.

### MEDIUM: `Options.projectConfigRoot` (types only): **separate spec**

For a session whose `cwd` is a git worktree, project settings, hooks, permissions, `.mcp.json`, the `.claude` trees and `CLAUDE_PROJECT_DIR` come from the trusted checkout instead of whatever the branch carries. DorkOS runs agents in worktrees routinely (workspaces, `/flow` EXECUTE). A branch that adds a hook or a permissive rule currently takes effect for the agent running on it. No release note describes this option, so its CLI-side support is **unverified**. Spec it with the workspaces work (DOR-1056).

### MEDIUM: `fireReason` + `CLAUDE_CODE_HOST_SCHEDULED_RUN` (0.3.280): **skip for now**

This would let DorkOS's task scheduler frame a scheduled run as the session's assigned task rather than a generic prompt. DorkOS does not inject `origin` on scheduled runs today, and the framing change is model-visible. Nobody has asked for it. Revisit if scheduled-run prompts show framing problems.

### LOW / NONE: no action (19 items)

`CLAUDE_CODE_MCP_STARTUP_WAIT_MS`, `CLAUDE_CODE_EMIT_STARTUP_TIMING`, `usage_report` / `SDKUsageReport` (DorkOS reads usage through `get_usage` in `sdk/subscription-usage.ts`), `task_notification.reason: 'worker_restart'`, the four remote latency fields, `pasted_content` / `inline_pastes`, `AgentDefinition.omitClaudeMd`, `updateSettings('userSettings')`, `SlashCommand.builtin` (a possible nicety for the command palette; `command-registry` merges SDK commands without distinguishing built-ins), `list_permission_rules` (no `Query` method), `get_hooks_listing`, `rename_session` `source`/`session_id`, `setMaxThinkingTokens('highlights')` (remote-only), `bashEditDiffEnabled`, npm marketplace `version`/`registry`, `CLAUDE_CODE_RETRY_WATCHDOG` `rate_limit_event`, `askSideQuestion()` (not in `sdk.d.ts`), `ForkSessionOptions.upToMessageId` accepting client uuids, `modelPricing` multiplier range.

---

## Relation to the previous triage (0.3.224 → 0.3.268): what already shipped

Checked against `git log` and the code, so nothing below gets proposed again:

| Previous item                                                                                                                  | Status                                                    | Evidence                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR A (bump, todo tools, error cards, `pluginDelivery`, `kind`, #454 swap)                                                      | **Shipped**                                               | #1798; `CLAUDE_CODE_ENABLE_TODO_TOOLS` and `pluginDelivery` in `launch-resolver.ts`                                                                                                                                             |
| PR B: `user_message_uuids`, `queued_turn_count`, `resume_reason` / `local_command` / `result_index`, uuid on `thinking_tokens` | **Shipped**                                               | #1802; all read in `sessions/session-turn-windows.ts`                                                                                                                                                                           |
| PR C: `thinkingTokens` + `costBasis`, `getContextUsage({ detail: 'summary' })`, `createSdkMcpServer({ timeout })`              | **Shipped**                                               | #1803; `result-event-mapper.ts`, `sdk/context-usage.ts`, `mcp-tools/tool-timeout.ts`                                                                                                                                            |
| Spec: `reloadPlugins({ holdOnCacheImpact })`                                                                                   | **Shipped**                                               | #1819; `messaging/plugin-reload-policy.ts`, spec `plugin-reload-cache-cost`                                                                                                                                                     |
| Spec: `classifierContext` on `PostToolUse`                                                                                     | **Shipped**                                               | #1817, #1827; `messaging/classifier-context.ts`, spec `auto-mode-classifier-context`                                                                                                                                            |
| Spec: `ambient` / `is_backgrounded` / `spawn_depth`                                                                            | **Shipped**                                               | #1820; `ambient` carried through; `is_backgrounded` / `spawn_depth` read and deliberately only logged (spec `ambient-background-tasks`, decision 9)                                                                             |
| Spec: `permissionPrompts: 'none'`                                                                                              | **Shipped differently, SDK option deliberately rejected** | #1818; `specs/unattended-session-permission-prompts/04-implementation.md` records it was tried then reverted: it denies more than `bypassPermissions` allows and forces `allowedTools`, which DOR-519 banned. Do not re-propose |
| Carried forward: `api_error_status` (0.3.218/0.3.223, ADR-0143)                                                                | **Still unadopted**                                       | zero hits in `apps/server/src`; field still on `SDKResultError` at 0.3.280                                                                                                                                                      |

**How the new items relate**: MCP `source` hardens the same auto-allow gate #1818 and DOR-519 shaped. `startup_failure_reason` is the natural partner for `api_error_status`, so the recommended spec closes the carry-forward. The 0.3.277 cumulative-usage change touches the `thinkingTokens` summing PR C added. The 0.3.274 empty-result change touches the turn windows PR B rewired. Plan-mode gating vindicates ADR-0261's stated assumption.

---

## The five non-import couplings, re-checked at 0.3.280

### 1. `sessions/project-slug.ts` (session-slug hash): **unchanged, no action beyond a re-stamp**

Located by string in both `sdk.mjs` bundles. Only identifiers moved:

|         | 0.3.268                                                                                     | 0.3.280                                                          |
| ------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Hash    | `function gC(e){let t=0;for(let n=0;n<e.length;n++)t=(t<<5)-t+e.charCodeAt(n)\|0;return t}` | `function KR(e){…identical body…}`                               |
| Base36  | `function A1e(e){return Math.abs(gC(e)).toString(36)}`                                      | `function WKe(e){return Math.abs(KR(e)).toString(36)}`           |
| Replace | `e.replace(/[^a-zA-Z0-9]/g,"-")`                                                            | identical                                                        |
| Slug    | `if(t.length<=Os)return t;return \`${t.slice(0,Os)}-${A1e(e)}\``                            | `if(t.length<=ri)return t;return \`${t.slice(0,ri)}-${WKe(e)}\`` |
| Cap     | `var Os=200`                                                                                | `var ri=200`                                                     |

Byte-identical algorithm, 200-char cap unchanged.

### 2. `messaging/plugin-activation.ts` (plugin shape): **unchanged**

`SdkPluginConfig` is `{ type: 'local'; path: string; skipMcpDiscovery?: boolean }` at both versions. The local `ClaudeAgentSdkPlugin` still carries `type` + `path` only: still assignable, and the same deliberate divergence as last time.

### 3. `sdk/sdk-utils.ts` `resolveClaudeCliPath()` (platform packages): **unchanged**

The same 8 optional-dependency names, version-locked, no `-android` variant. The dead android branch the last two assessments flagged is **gone** from `sdk-utils.ts` (no `android` hit), so update the coupling note.

### 4. `services/mesh/mcp-revocation.ts` (MCP connect timing): **static re-check done; a live re-run is owed**

- `McpServerStatus.status` union unchanged (`connected | failed | needs-auth | pending | disabled`). No `errorCode` crosses the boundary, so point 2 holds by construction. The type gained **`source?`** and **`tools[]._meta?`**, both additive. The module's "byte-identical" wording (about 0.3.224 vs 0.3.268) must not be extended to 0.3.280.
- **The timing premise moved.** The 0.3.268 live run recorded that "every unrelated project server reported `connected`, not `pending`, in the first `system/init` frame". 0.3.274 made the first turn **stop waiting** for settings-file and plugin MCP servers whose tools tool search defers, and added `CLAUDE_CODE_MCP_STARTUP_WAIT_MS`. So an external server from `.mcp.json` or a plugin can again read `pending` in the first frame. The module treats `pending` as "not evidence" (excluded, not a near-miss). A revoked server can therefore go undetected on a session's first turn and be caught on a later one. That is a delay, not a wrong verdict, because the live probe remains the arbiter. Which DorkOS-surfaced servers are "deferred by tool search" is **unverified**.
- **Action**: re-run the documented two-server 401 harness at 0.3.280 and commit a third fixture beside the two existing ones (the static fixtures pass whether stale or not). Re-stamp the module narrative. If first-frame `pending` is observed, decide whether to set `CLAUDE_CODE_MCP_STARTUP_WAIT_MS` or accept detection on the next turn. **Effort: moderate.**

### 5. `sdk/sdk-error-mapping.ts` (the CLI abort predicate): **re-extracted from the 0.3.280 binary: one new suppressed cause, no DorkOS impact by construction**

Using the recipe in `research/20260903_claude-cli-aborted-refusal-shapes.md` on the darwin-arm64 binaries:

- **Shape predicate unchanged**, verbatim: `function eH(e){return e==="aborted_streaming"||e==="aborted_tools"}` (0.3.268: `DR`). Still `INTERRUPTED_TERMINAL_REASONS` minus DorkOS's synthetic `'interrupted'`.
- **Person-initiated set unchanged**: `new Set(["user-cancel","remote-cancel","shutdown","interrupt","turn-abort"])`.
- **Suppression set grew to four**: `new Set(["interrupt","turn-abort","refusal-fallback-edit","permission-stop"])` (0.3.268: three, without `permission-stop`).
- **`permission-stop` is new**: it maps to `turn_teardown` (`case"permission-stop":return"turn_teardown"`), and it is raised when a permission decision is `deny` with `endsTurn` set (`if(Yt.behavior==="deny"&&Yt.endsTurn&&!s.abortController.signal.aborted)…abort(nc("permission-stop"))`). The per-turn predicate now reads `r==="turn-abort"||r==="permission-stop"`.
- **DorkOS impact: none.** `isStoppedTurnResult` ANDs the shape with DorkOS's own `stopWasRequested`, so a turn ended by a denial cannot suppress an error frame on its own. That is the second independent cause since the AND was added that confirms the design. Separately, DorkOS never returns `interrupt: true` on a deny (zero hits), which is the likeliest source of `endsTurn`. The mapping from `PermissionResult.interrupt` to `endsTurn` is **unverified**.
- **Action**: append a "Re-run on 0.3.280" section to the research file and update the coupling note. **Effort: trivial.**

---

## #454 workaround: **still required, do not revert**

- **Upstream**: `anthropics/claude-agent-sdk-typescript#454` is **OPEN** (checked 2026-09-22, last activity 2026-09-21), now with three independent reporters. The latest comment reproduces it on 0.3.278 with zod 4.6.5. It pins the cause on the bundled `zod-to-json-schema@3.25.2`, the newest published version of that package, so no upstream converter bump is available to fix it.
- **Reproduced locally against both tarballs** with the zod DorkOS's server actually resolves (`apps/server/node_modules/zod` → **4.6.5**). A `createSdkMcpServer` with one `tool()` was built, and its `tools/list` handler called directly:

  | Schema field                         | 0.3.268                                                       | 0.3.280                |
  | ------------------------------------ | ------------------------------------------------------------- | ---------------------- |
  | `z.record(z.string(), z.unknown())`  | throws `Cannot read properties of undefined (reading 'push')` | **throws, same error** |
  | `z.json()`                           | throws                                                        | **throws**             |
  | `z.object({}).catchall(z.unknown())` | OK, 1 tool                                                    | OK, 1 tool             |

- **Verdict**: keep the `catchall` swap in `mcp-tools/tool-exposure.ts`, `packages/shared/src/connector-schemas.ts` and `services/core/operator/operator-capabilities.ts`. Update the `upgrade_notes` date. Check again on the next bump.

---

## Bug fixes resolving DorkOS exposure (auto-resolved by the bump)

1. **CC 2.1.277: SDK sessions hanging with no result after an internal error.** A hang with no result is the worst case for the persistent pump and the turn-liveness watchdog. The CLI now reports and exits 1, which DorkOS's error mapping already handles.
2. **0.3.269: plan-mode writes now reach `canUseTool`** (breaking item 3). Security-positive.
3. **0.3.269: interrupts and permission responses delayed during a host-started MCP OAuth sign-in.** DorkOS drives MCP OAuth (`mcp-revocation.ts` sign-in path) while sessions run, and a delayed Stop is the trust failure the product filter names.
4. **0.3.269: missing `tool_use_id` on `task_started` / `task_notification` for CLI-resumed background subagents.** `system-event-mapper.ts` joins background-task events by `tool_use_id`, so an orphaned row gets its parent back.
5. **CC 2.1.280: messages to a background subagent silently lost** in SDK sessions while it finished its turn. DorkOS relays messages to running agents.
6. **0.3.275: `forkSession()` missing a turn's assistant message right after its `result`, rejecting non-UUID `upToMessageId`, and showing a re-run prompt twice.** DorkOS calls `forkSession` (`sessions/session-store.ts`) and passes `upToMessageId` through from `claude-code-runtime.ts`.
7. **0.3.271: `getSessionInfo` with `dir` missing sessions on a Windows mapped or SUBST drive.** DorkOS calls `getSessionInfo` (`sessions/transcript-reader.ts`) and ships a Windows alpha.
8. **CC 2.1.274: `"type": "sdk"` MCP entries in config files skipped.** A config file can no longer claim to be an in-process host server, which pairs with the `source` adoption above.

Also relevant but not DorkOS-specific: the CC 2.1.280 fix for a model switch from an SDK host causing a prompt-cache miss (DorkOS switches models mid-session), and 0.3.275's fix for `tool_use_result` keys on re-run deferred tools.

### TODO / FIXME / HACK / WORKAROUND sweep

`grep -rnE "TODO|FIXME|HACK|WORKAROUND"` over the adapter (non-test) returns one hit, `CLAUDE_CODE_ENABLE_TODO_TOOLS` in `launch-resolver.ts`, which is a false positive. `grep` for upstream issue references (`claude-agent-sdk-typescript#…`, `claude-code/issues/…`) across `apps/` and `packages/` returns nothing. The one parked workaround is the #454 `catchall` swap, which this range does **not** resolve.

---

## ADR conflicts

| ADR                                                             | Verdict                                                                                                                                                                        |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **0089** (SDK import confinement)                               | ✅ All 45 importing files are inside `services/runtimes/claude-code/`. The `source` adoption stays inside `interactive-handlers.ts`                                            |
| **0143** (retry depth)                                          | ✅ No conflict. `api_error_status` is still the unadopted lever, now paired with `startup_failure_reason` in the recommended spec                                              |
| **0239** (plugin activation)                                    | ✅ `SdkPluginConfig` unchanged; `pluginDelivery: 'initialize'` path unchanged                                                                                                  |
| **0240** (permission passthrough)                               | ✅ `PermissionMode` unchanged. `permission_denials` now includes path-scoped Read/Edit/Write denials: strictly more complete                                                   |
| **0261** (always launch with `allowDangerouslySkipPermissions`) | ⚠️ No conflict, but its "verified inert in … plan" claim was probably untrue for plan-mode writes until 0.3.269. Verify live, and amend the ADR with a dated note if confirmed |

---

## Dependency and pin check

Seven pin sites, all at `0.3.268` today, must move together to `0.3.280`:

| File                                                 | Entry                                                                                          |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `package.json`                                       | `pnpm.overrides` → `@anthropic-ai/claude-agent-sdk`                                            |
| `apps/server/package.json`                           | `@anthropic-ai/claude-agent-sdk`                                                               |
| `packages/cli/package.json`                          | `@anthropic-ai/claude-agent-sdk`                                                               |
| `apps/desktop/package.json`                          | `@anthropic-ai/claude-agent-sdk`                                                               |
| `apps/desktop/package.json`                          | `@anthropic-ai/claude-agent-sdk-darwin-arm64` (optional)                                       |
| `apps/desktop/package.json`                          | `@anthropic-ai/claude-agent-sdk-win32-x64` (optional)                                          |
| `services/runtimes/claude-code/tooling/provision.ts` | `CLAUDE_SDK_VERSION` (also invalidates the model disk cache, which the Opus 5.5 rollout needs) |

Peer deps, `engines`, `exports` and the optional-dependency set are unchanged.

---

## Validation plan

1. Bump all seven pin sites; `pnpm install`; rebuild `@dorkos/shared` if stale; `pnpm --filter @dorkos/server typecheck`. **Expect clean.** Treat any error as new information this assessment missed.
2. Apply the in-bump change: `mcpServer.source === 'sdk'` on the auto-allow gate, with tests.
3. `pnpm vitest run apps/server/src/services/runtimes/claude-code` (the `runtimeConformance` gate). Watch `session-turn-windows` and `result-event-mapper` tests.
4. Re-stamp coupling narratives: `project-slug.ts`, `mcp-revocation.ts`, the aborted-refusal research file (append the 0.3.280 section), and the `runtime-deps.json` surface map / couplings / #454 note per the drift table above.
5. Live checks (all behavioral, invisible to tests):
   - **Opus 5.5**: warm-up, then `models.json` shows `resolvedModel: claude-opus-5-5` on the `opus` rows. Pick "Opus" in the app and confirm `system/init` `model`;
   - **plan mode**: a write attempt raises an approval card;
   - **cumulative usage**: a warm multi-turn session, then a relaunch/resume, and read `turnInputTokens` across turns;
   - **empty queued results**: two background tasks finishing together, and no spurious done/turn state;
   - **MCP elicitation** interrupted mid-form: the card closes and the status shows needs-attention while it is open;
   - **the two-server 401 harness** for `mcp-revocation.ts` (third fixture).
6. Browser-verify one session end to end.

## Rollback criteria

Revert to 0.3.268 if any of the following happen:

- the conformance suite fails for a reason other than a mock update;
- the `opus` rows do not resolve to `claude-opus-5-5`, or the model picker loses rows;
- plan mode stops being able to write after approval;
- the persistent pump strands a turn window open or reports a turn done with nothing run;
- the MCP revocation harness shows a status shape `mcp-revocation.ts` cannot read;
- the DorkOS tools disappear from the model's tool list (would mean #454's surface moved again);
- the desktop app cannot spawn its bundled binary.
