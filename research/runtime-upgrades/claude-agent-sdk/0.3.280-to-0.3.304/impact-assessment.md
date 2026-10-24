# Impact Assessment: @anthropic-ai/claude-agent-sdk 0.3.280 → 0.3.304

**Generated**: 2026-10-20 (read-only analysis of `origin/main` at `c31970db88`)
**Codebase root**: `apps/server/src/services/runtimes/claude-code/`
**Abstraction boundary**: `AgentRuntime` interface
**Related ADRs**: 0089, 0143, 0239, 0240, 0261
**Companion**: [`changelog.md`](./changelog.md)

## Summary

| Category                         | Count | Action required                                                                                                            |
| -------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------- |
| Breaking — type/contract         | 1     | None (`Settings.attribution` widened; DorkOS never reads it)                                                               |
| Breaking — behavioral, act       | 3     | `sonnet`/`haiku` alias retarget (name in PR); "None" effort becomes adaptive on 5.5 models; new transcript rows (measure)  |
| Breaking — behavioral, no action | 6     | `permissionMode` default, fork subagents, hook `updatedInput`, priority `now`, `--flag=value`, more `system/informational` |
| Deprecations                     | 0     | —                                                                                                                          |
| Features (high)                  | 2     | Recommend adopt (follow-ups, not in the bump)                                                                              |
| Features (medium)                | 4     | Consider                                                                                                                   |
| Bug fixes (relevant)             | 6     | Auto-resolved                                                                                                              |

**Overall upgrade risk: LOW–MEDIUM.** No compile break expected: no export removed, the `SDKMessage` union is identical (39 members, so every `never` exhaustiveness check in the event mappers still compiles), `Options` gained no fields, every type DorkOS imports either is unchanged or grew an optional field. The medium part is behavioral and silent: two model aliases move to new models at new prices, and the CLI now writes large request-snapshot rows into the transcripts DorkOS reads.

**Estimated effort**: the bump itself is a 7-site version edit plus lockfile (trivial); plus one live smoke turn and the re-observations the upgrade notes require (about 1–2 hours).

## Files that must change

| #   | File                                                                 | Change                                                                                                            |
| --- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1   | `package.json` (`pnpm.overrides`)                                    | `"@anthropic-ai/claude-agent-sdk": "0.3.280"` → `"0.3.304"` (the one that binds)                                  |
| 2   | `apps/server/package.json` (dependencies)                            | same                                                                                                              |
| 3   | `apps/desktop/package.json` (dependencies)                           | same                                                                                                              |
| 4   | `packages/cli/package.json` (dependencies)                           | same                                                                                                              |
| 5   | `apps/desktop/package.json` (optionalDependencies `-darwin-arm64`)   | `0.3.280` → `0.3.304`                                                                                             |
| 6   | `apps/desktop/package.json` (optionalDependencies `-win32-x64`)      | `0.3.280` → `0.3.304`                                                                                             |
| 7   | `apps/server/src/services/runtimes/claude-code/tooling/provision.ts` | `CLAUDE_SDK_VERSION = '0.3.280'` → `'0.3.304'` (also invalidates the on-disk model cache)                         |
| 8   | `pnpm-lock.yaml`                                                     | regenerated (37 occurrences of `0.3.280` today)                                                                   |
| 9   | `.claude/config/runtime-deps.json`                                   | refresh `upgrade_notes` (#454 status, alias table) and `non_import_couplings` stamps; add the two couplings below |

All seven pins confirmed at `0.3.280` on `origin/main`. All nine npm packages exist at `0.3.304` (`@anthropic-ai/claude-agent-sdk` and `-darwin-arm64`, `-darwin-x64`, `-linux-arm64`, `-linux-arm64-musl`, `-linux-x64`, `-linux-x64-musl`, `-win32-arm64`, `-win32-x64`). Guards: `scripts/__tests__/dependabot-lockstep-families.test.ts` (manifest half), `tooling/__tests__/provision.test.ts` (asserts `CLAUDE_SDK_VERSION` equals the server dependency). The desktop packaging (`apps/desktop/electron-builder.yml` unpacks the whole `@anthropic-ai/claude-agent-sdk/**` dir; `build-server.ts` lockstep check reads the dependency) needs no edit for the new `core*.mjs` files: `sdk.mjs` imports neither chunk.

## Forced code changes

**None at compile time.** Symbol-level detail of every surface DorkOS imports (28 symbols across the runtime; `HookCallbackMatcher` in `audit-tool-hooks.ts` is missing from the surface map's 27):

| Symbol                                                                                                                                                                                                         | 0.3.280 → 0.3.304                                                                                                                                       | DorkOS effect                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `SDKMessage`                                                                                                                                                                                                   | identical member list                                                                                                                                   | none                                                                                   |
| `Options`                                                                                                                                                                                                      | docblocks only (`permissionMode`, `sandbox`, `managedSettings`, effort list moved)                                                                      | none                                                                                   |
| `Query`                                                                                                                                                                                                        | `reloadPlugins()` param gains `addPlugins?`; doc on `initializationResult()`                                                                            | none                                                                                   |
| `McpServerConfig` → `McpSdkServerConfig`                                                                                                                                                                       | `tools?: McpServerToolPolicy[]`                                                                                                                         | none (optional)                                                                        |
| `McpServerStatus`                                                                                                                                                                                              | doc only; `status` union unchanged (`connected` / `failed` / `needs-auth` / `pending` / `disabled`)                                                     | none                                                                                   |
| `ModelInfo`                                                                                                                                                                                                    | unchanged (still no capability fields, so `mapSdkModelToModelOption`'s asserted `supportsToolUse`/`supportsVision`/`supportsImageOutput` stay asserted) | none                                                                                   |
| `EffortLevel`, `ThinkingConfig`, `PermissionMode`, `PermissionResult`, `PermissionUpdate*`, `SpawnOptions`, `SpawnedProcess`, `SdkPluginConfig`, `ElicitationRequest/Result`, `HookCallback`, `HookJSONOutput` | unchanged structurally                                                                                                                                  | none                                                                                   |
| `SDKControlGetContextUsageResponse`                                                                                                                                                                            | additive: category `id?`, `mcpInstructions?`, `pluginId?`, `path?`, `pluginName?`                                                                       | none                                                                                   |
| `SDKControlGetUsageResponse`                                                                                                                                                                                   | insight `key` union widened by four values                                                                                                              | none (`sdk/subscription-usage.ts` iterates `WINDOW_LABELS`, no switch)                 |
| `NonNullableUsage`                                                                                                                                                                                             | `fallback_credit` may now be null                                                                                                                       | none (only `__tests__/sdk-scenarios.ts` sets it; assignable)                           |
| `SDKAssistantMessage` / `SDKUserMessage`                                                                                                                                                                       | `agent_id?`                                                                                                                                             | none                                                                                   |
| `SDKSystemMessage` (`init`)                                                                                                                                                                                    | `plugin_errors?` (now typed), `view_mode?`                                                                                                              | none; `launch-resolver.ts` already reads `plugin_errors` loosely                       |
| `SDKResultSuccess`                                                                                                                                                                                             | `first_text_post_queue_wait_ms?`, `first_text_post_queued_behind?`                                                                                      | none                                                                                   |
| `SDKConversationResetMessage`                                                                                                                                                                                  | `trigger?`, `user_message_uuid?`, `timestamp?`                                                                                                          | none (not mapped)                                                                      |
| `tool()`, `createSdkMcpServer()`, `query()`, `forkSession()`, `getSessionInfo()`, `renameSession()`                                                                                                            | signatures unchanged                                                                                                                                    | none                                                                                   |
| zod in `sdk.d.ts`                                                                                                                                                                                              | `z.ZodPreprocess<X, unknown>` (2 type params)                                                                                                           | none: app zod 4.6.5 declares `ZodPreprocess<B, I = unknown>`, and `skipLibCheck` is on |

## The upgrade-note checks

### 1. Upstream #454 (z.record / z.json tool schemas vanish): issue OPEN, fix not in release notes, but fixed in practice since 0.3.285

- **Upstream state** (`gh issue view 454`): **OPEN**, label `bug`, five comments, last activity 2026-09-23. No maintainer reply, nothing linked, no release note between 0.3.281 and 0.3.304 names #454 or a zod bump.
- **What did change, per release notes**: 0.3.286 "Fixed an SDK MCP server listing no tools when one tool's schema cannot be converted to JSON Schema; that tool is now left out with a warning naming it". That makes the failure smaller (one tool missing, not the whole server), not gone. 0.3.282's `/core` entry "uses your installed zod and MCP SDK", which is the fix the issue thread proposed, but only for apps that switch entry point.
- **What changed without a note (measured)**: the zod bundled in `sdk.mjs` moved **4.4.3 → 4.5.4 at 0.3.285** and to **4.6.2 by 0.3.300** (bisected over `sdk.mjs` at 0.3.281, .282, .284, .285, .286, …, .300). The 4.5.4+ conversion context carries both `deferred: []` and `intersections: []`, which is exactly what the app-zod record and intersection processors push onto.
- **Repro** (in-process only: `createSdkMcpServer().instance` listed over `InMemoryTransport`, zod 4.6.5, MCP SDK 1.31.0, Node 22; no CLI, no model):

  | Schema                              | 0.3.280 main entry                                          | 0.3.304 main entry | 0.3.304 `/core` |
  | ----------------------------------- | ----------------------------------------------------------- | ------------------ | --------------- |
  | `z.record(z.string(), z.unknown())` | FAIL `Cannot read properties of undefined (reading 'push')` | OK                 | OK              |
  | `z.json()`                          | FAIL (same)                                                 | OK                 | OK              |
  | `z.object({}).catchall(...)`        | OK                                                          | OK                 | OK              |

  At 0.3.304 a `z.record(z.string().max(5), z.number())` converts with its `propertyNames` bound intact; `z.json()` converts to a `$ref` into `definitions.__schema0`; `z.intersection` converts.

- **Verdict**: **Not fixed upstream on the record** (issue open, release notes silent). **Effectively fixed in the shipped bundle since 0.3.285** by a silent bundled-zod bump. Per the rule, **do not revert the `catchall` swap in this bump**: keep the four schemas (`CONTROL_UI_INPUT.content`, `operator.config_patch` `patch`, `McpServerTransportSchema` `env`/`headers`, `ConnectorJsonValueSchema`) as they are, and update the `tool-exposure.ts` TSDoc and `runtime-deps.json` note to record what was measured. A revert is a separate follow-up that needs (a) a live `tools/list` through a real `query()` turn (the repro bypasses the CLI), and (b) a check that the API accepts the `$ref`/`definitions` form `z.json()` now emits. The hazard class is not closed either: it returns whenever the app's zod adds a context field the bundled zod lacks (app 4.6.5 vs bundled 4.6.2 today).
- **Guard still holds**: `mcp-tools/__tests__/tool-exposure.test.ts` asserts exact tool totals per session shape, so after 0.3.286 a bad schema now reds as "one tool missing" instead of "all missing". Same test, different symptom.

### 2. Model alias table (platform binary, `strings` of `claude-agent-sdk-darwin-arm64/claude`)

| Alias                         | 0.3.280 (first-party) | 0.3.304 (first-party)   | Third-party targets                       |
| ----------------------------- | --------------------- | ----------------------- | ----------------------------------------- |
| `opus`                        | `claude-opus-5-5`     | `claude-opus-5-5`       | unchanged                                 |
| `sonnet`                      | `claude-sonnet-5`     | **`claude-sonnet-5-5`** | unchanged (`-4-5` / `-4-6`)               |
| `haiku`                       | `claude-haiku-4-5`    | **`claude-haiku-5-5`**  | new block, all stay on `claude-haiku-4-5` |
| `fable`                       | `claude-fable-5-1`    | `claude-fable-5-1`      | gateway `claude-fable-5`, unchanged       |
| `best`                        | `fable`               | `fable`                 | —                                         |
| `defaults`, `alias_migration` | `{}`                  | `{}`                    | —                                         |

`latest_per_family` moves the same way (sonnet → `claude-sonnet-5-5`, haiku → `claude-haiku-5-5`). `default` is chosen per account tier at runtime and is not in the table; on a Sonnet-default account it now lands on Sonnet 5.5.

| Model               | Context | Default output | Default effort | Price (binary key)                                            |
| ------------------- | ------- | -------------- | -------------- | ------------------------------------------------------------- |
| `claude-sonnet-5`   | 1M      | 64k            | high           | `tier_2_10`: $2 / $10, cache read $0.20                       |
| `claude-sonnet-5-5` | 1M      | 128k           | **medium**     | `tier_2_10_cache_read_0_10`: $2 / $10, cache read $0.10       |
| `claude-haiku-4-5`  | 200k    | 32k            | —              | `haiku_45`: $1 / $5                                           |
| `claude-haiku-5-5`  | **1M**  | 128k           | medium         | `haiku_55`: $0.10 / $0.50 (≤100k prompt), $0.50 / $2.50 above |

Both 5.5 models carry `rejects_disabled_thinking`. DorkOS impact: every session or agent whose model is `sonnet` or `haiku` changes model on the first launch after the bump (both cheaper, but Sonnet 5.5 defaults to less effort). Only alias use found in app code is the family heuristic in `messaging/runtime-cache.ts` (`includes('sonnet')` → `balanced`, `includes('haiku')` → `fast`), which still holds. No server default pins an alias. Test-mode scenarios and `packages/evals` (`DEFAULT_CHEAP_MODEL = 'claude-haiku-4-5'`) pin full ids and do not move. Name both retargets in the bump PR and changelog fragment.

### 3. `modelUsage` / `total_cost_usd` lifecycle

The docblocks on `SDKResultSuccess`/`SDKResultError` `modelUsage` and `total_cost_usd` are **byte-identical** between 0.3.280 and 0.3.304 (running totals across warm turns, carried across resume/fork when the transcript saved them, reset by a mid-session `/clear`). `sdk/turn-usage.ts` already treats a drop as a new lifetime and clamps negatives. No change needed. New, usable: `conversation_reset.trigger === 'clear'` + `user_message_uuid` now names the exact reset, if the ledger ever wants to stop inferring it.

### 4. MCP server provenance on `canUseTool` / hooks

Present and unchanged: `CanUseTool` options `mcpServer?: { name, source }` and five `mcp_server?: McpServerProvenance` hook inputs at both versions; `McpServerProvenance.source` docs still say "an open set; treat unknown values as … never as sdk". `isHostServedOrUnattributed` in `mcp-tools/tool-exposure.ts` needs no change.

### 5. `sdk.d.ts` diff

See the forced-changes table and `changelog.md`. New exports: `BUILTIN_TOOL_NAMES`, `LEGACY_TOOL_NAME_ALIASES`, `prewarm`, `SpareProcess`, `ClaimOptions`. Removed: none. New `SDKMessage` members: none. New control request `get_task_output` (`SDKControlGetTaskOutputRequest/Response`, not exported, no `Query` method).

### 6. Pins

All seven confirmed; see "Files that must change".

### Non-import couplings, re-checked

| Coupling                                                           | Result at 0.3.304                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessions/project-slug.ts` slug hash                               | unchanged: sanitizer `e.replace(/[^a-zA-Z0-9]/g,"-")`, hash `t=(t<<5)-t+e.charCodeAt(n)\|0`, `Math.abs(…).toString(36)` over the original path, cut `=200`                                                                                                          |
| `messaging/plugin-activation.ts` vs `SdkPluginConfig`              | unchanged (`type`, `path`, `skipMcpDiscovery?`)                                                                                                                                                                                                                     |
| `sdk/sdk-utils.ts` `resolveClaudeCliPath()`                        | same 8 platform packages, all published                                                                                                                                                                                                                             |
| `sdk/sdk-error-mapping.ts` abort suppression set                   | unchanged, four members: `interrupt`, `turn-abort`, `refusal-fallback-edit`, `permission-stop`                                                                                                                                                                      |
| `services/mesh/mcp-revocation.ts`                                  | `McpServerStatus.status` union unchanged; 0.3.284 now waits up to 2 s for servers named in `allowedTools` even with `CLAUDE_CODE_MCP_STARTUP_WAIT_MS=0`. The upgrade note asks for a live re-run of the two-server 401 harness; not done here (no CLI runs allowed) |
| **Not in the config: `packages/skills/src/shell-commands.ts`**     | mirrors the CLI's skill/command shell patterns. Both still present verbatim at 0.3.304: `/```!\s*\n?([\s\S]*?)\n?```/g` and `/(?<=^\|\s)!`([^`]+)`/gm`                                                                                                              |
| **Not in the config: `services/core/turn-power/prompt-defuse.ts`** | mirrors the CLI's `@`-mention and leading-`/` parsing. Defuses every `@`, so a changed start set cannot get past it; not re-measured                                                                                                                                |

Add the last two to `non_import_couplings`.

## Behavioral changes — detailed impact

### A. `sonnet` / `haiku` alias retarget (act: name it)

See check 2. No code change. Status line and picker show the catalog's `displayName`, so labels follow on their own.

### B. "None" effort on Sonnet 5.5 / Haiku 5.5 becomes adaptive thinking (act: follow-up)

- `messaging/thinking-config.ts` `resolveThinkingOptions` sends `thinking: { type: 'disabled' }` for effort `'none'` on adaptive models. From 0.3.300 the CLI runs that as adaptive thinking on models that reject disabled thinking, and both 5.5 models do. A person who picks "None" on `sonnet` or `haiku` gets thinking anyway.
- `ModelInfo` has no "can disable thinking" field, so the picker cannot tell. Effort: moderate. Options: hide "None" for these families, or label it honestly. Not a blocker for the bump.

### C. New transcript rows `api-request` / `api-request-shape` / `api-request-blob` (act: measure in the smoke turn)

- Seen in two real transcripts on this machine written by a 2.1.300 CLI: a ~650 KB burst (one 105–111 KB shape row, up to 231 blob rows up to 107 KB each), once, mid-file.
- DorkOS readers skip unknown `type`s (`transcript-parser.ts`, `search/projections/claude-code.ts` key on `type === 'user'` etc.), so nothing breaks on parse. Two costs to measure: (1) `transcript-reader.ts` `readTailStatus` reads only the last 64 KB (`TRANSCRIPT.TAIL_BUFFER_BYTES`), so a burst near the end of a file can push `model` / `permissionMode` / title rows out of the window (it falls back to best effort); (2) full-file reads (history, FTS indexing) carry the extra bytes. How often a DorkOS session writes a burst (per launch? per tool-shape change?) is the open question.

### D. No action

- **Omitted `permissionMode`** (0.3.286/0.3.302): every turn sets it (`launch-resolver.ts` `sdkOptions.permissionMode = effectivePermissionMode`, `claude-code-runtime.ts` sets `'default'`); the two no-prompt probes (`runtime-cache.ts` warm-up, the plugin-command probe) never run a tool.
- **Hook `updatedInput` validation** (0.3.300): DorkOS returns `updatedInput` only from `canUseTool` (`interactive-handlers.ts`), which is unchanged; its hooks (`classifier-context.ts`, `teammate-tier-hook.ts`) return context, not input.
- **Fork subagents on by default** (0.3.302): DorkOS does not set `CLAUDE_CODE_FORK_SUBAGENT`; forks just appear as subagents. Higher context cost per fork, worth a line in the PR.
- **Priority `now`** (0.3.286): DorkOS never sets it (`phantom-cancellation.ts` says so).
- **`--flag=value` argv** (0.3.295): `sessions/tracked-spawn.ts` passes `args` straight through; nothing in the server matches CLI flags.
- **`system/informational` now emitted** (0.3.283): already in the union at 0.3.280; the mapper ignores it.
- **Binary size** 217 → 271 MB: desktop download and CLI install grow by ~54 MB per platform.

## Bug fixes relevant to DorkOS (auto-resolved)

1. 0.3.284 — `query()` no longer closes stdin before a follow-up turn woken by a finished background agent ("Stream closed" in hooks, `canUseTool`, SDK MCP). Same class as DOR-1238 / DOR-2065.
2. 0.3.286 — one bad tool schema no longer takes the whole DorkOS MCP server down (see #454).
3. 0.3.301 — `setModel()` with a model id works at the five-hour/weekly limit (`sessions/launch-live-settings.ts` calls it).
4. 0.3.281 — permission callbacks no longer fire after `close()`; control requests after close no longer hang.
5. CLI 2.1.299/2.1.300 — MCP tool calls no longer fail or run twice on a background reconnect; resumed SDK sessions keep compaction summaries and kept messages.
6. 0.3.284/0.3.285 — `forkSession()` / `getSessionMessages()` history correctness after rewind and compaction (`sessions/session-store.ts` uses `forkSession`).

## Recommended feature adoptions (follow-ups, not in the bump)

| Feature                                                                                                           | Relevance | Effort      | Value                                                                               |
| ----------------------------------------------------------------------------------------------------------------- | --------- | ----------- | ----------------------------------------------------------------------------------- |
| Listen for `CLAUDE_SDK_MCP_TOOL_SCHEMA_UNCONVERTIBLE` process warnings (0.3.286) and log/surface the dropped tool | High      | trivial     | Turns the silent #454 class into a named log line                                   |
| Revert the `catchall` swap once a live `query()` `tools/list` confirms 0.3.304 (or move to `/core`, 0.3.282)      | High      | moderate    | Restores `propertyNames` bounds; ends a workaround                                  |
| `prewarm()` / `SpareProcess.claim()` (0.3.282, alpha)                                                             | Medium    | significant | Faster first reply on a new session; ~250 MB per parked process, alpha              |
| `getContextUsage()` stable row `id`s (0.3.304)                                                                    | Medium    | trivial     | `sdk/context-usage.ts` can match rows by id instead of English names                |
| Subagent `agent_id` / task `run_id` / `parent_task_id` (0.3.292)                                                  | Medium    | moderate    | Nest subagent output and tell resumed runs apart without pairing heuristics         |
| Per-tool `always_ask` / `always_deny` on sdk MCP servers (0.3.301)                                                | Medium    | moderate    | Declarative tool gating instead of `canUseTool` logic, if it maps onto DorkOS tiers |

## Verification plan for the bump PR

1. Seven-site edit + `pnpm install`; `pnpm --filter @dorkos/server typecheck` (expect clean).
2. `pnpm vitest run apps/server/src/services/runtimes/claude-code` (incl. `tool-exposure.test.ts`, `provision.test.ts`), `scripts/__tests__/dependabot-lockstep-families.test.ts`.
3. One live smoke turn on `sonnet` (confirms the retarget, `tools/list` count, and how big the new `api-request*` burst is in a DorkOS transcript); re-read `models.json` cache after warm-up.
4. Re-run the two-server 401 MCP revocation harness (upgrade note).
