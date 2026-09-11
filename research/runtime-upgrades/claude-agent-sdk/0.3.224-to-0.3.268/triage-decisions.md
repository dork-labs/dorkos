# Triage Decisions

**Date**: 2026-09-11
**Decided by**: Dorian, on the `/app:runtime-upgrade` analysis in
[`impact-assessment.md`](./impact-assessment.md)
**Shape**: three PRs. This document is the split.

## PR A — the bump and everything it breaks (this PR)

- [x] Version bump 0.3.224 → 0.3.268 across **all seven** pin sites (root `pnpm.overrides`,
      `apps/server`, `apps/desktop` dependencies + its two per-platform optional deps,
      `packages/cli`, and `CLAUDE_SDK_VERSION` in `claude-code/tooling/provision.ts`)
- [x] `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` in the turn env — the task/todo surface goes dark
      silently without it. **Not** `allowedTools` (DOR-519) and **not** `tools`
- [x] `account_on_hold`, `verification_required`, `cloud_credential_error` added to
      `SURFACED_ASSISTANT_ERRORS`, each with its own sentence
- [x] `pluginDelivery: 'initialize'` — the argv length limit ADR-0239's design creates on
      Windows
- [x] `SDKContextUsageCategory.kind` replaces the display-name match in `sdk/context-usage.ts`;
      `'buffer'` counted as occupancy, deliberately
- [x] `session-turn-windows.ts` doc correction — `SDKResultError` now declares
      `user_message_uuid`, which the module stated as a load-bearing fact that it did not
- [x] Behavioral decisions recorded, zero code: multi-turn cwd persistence (0.3.265) accepted;
      `interrupt()`'s default stop scope (0.3.246) kept
- [x] All five non-import couplings re-derived at 0.3.268, the two-server 401 harness re-run
      live, every `sdk.d.ts:LINE` citation replaced with a symbol name, and
      `.claude/config/runtime-deps.json` rebuilt from a parse of every SDK import
- [x] **Found during verification, not in the assessment**: four schemas moved off `z.record()`
      /`z.json()`, without which SDK 0.3.257+ with zod 4.5.3+ serves the model **zero** DorkOS
      tools. See `mcp-tools/tool-exposure.ts`. Independently reproduced in review; the upstream
      bug is **[anthropics/claude-agent-sdk-typescript#454](https://github.com/anthropics/claude-agent-sdk-typescript/issues/454)**,
      OPEN as of 2026-09-11 with two reporters, and the zod half is #6497. **This is a
      workaround with an expiry**: on the next bump, check whether #454 is fixed and revert the
      `catchall` swap if it is. It costs the generated JSON Schema its `propertyNames` key
      bounds (still enforced at runtime) and carries two measured value-level differences, both
      unreachable over the wire — spelled out in `packages/shared/src/connector-schemas.ts`

## PR B — turn correlation

The three result fields that all serve `session-turn-windows.ts`, adopted together because
they are one subsystem and one set of tests:

- `user_message_uuids` (0.3.259) — every message a coalesced turn answered, replacing the
  inference the module's four-row table is built on
- `queued_turn_count` (0.3.243) — "is another turn coming?", answered by the CLI instead of
  tracked by DorkOS
- `resume_reason` / `local_command` / `result_index` (0.3.268) — three more field reads on
  the same object
- `user_message_uuid` on `thinking_tokens` system messages (0.3.260)

## PR C — cheap usage and context adoptions

- `ModelUsage.thinkingTokens` and `costBasis` (0.3.246 / 0.3.257) on the object
  `result-event-mapper.ts` already walks
- Evaluate `getContextUsage({ detail: 'summary' })` (0.3.257) against `'full'` — measure both
  before switching, since `'summary'` is an estimate
- `createSdkMcpServer({ timeout })` (0.3.248) — a per-server bound instead of fighting an
  inherited `MCP_TOOL_TIMEOUT`

## Separate specs — each is a product question, not an adoption

- `Query.reloadPlugins({ holdOnCacheImpact })` (0.3.268) — 23 call sites pay a silent cache
  invalidation today; `estimated_cache_write_usd` makes it a number an operator could decide
  about
- `permissionPrompts: 'none'` (0.3.259) — needs a ruling on which DorkOS session kinds count
  as unattended
- `classifierContext` on `PostToolUse` hooks (0.3.236) — the first lever for making auto mode
  smarter without widening auto-approval; DorkOS registers no `PostToolUse` hook today
- `ambient` / `is_backgrounded` / `spawn_depth` on task events (0.3.238, 0.3.247) — needs a UI
  surface, and `ambient` is directly the agent-etiquette "mostly quiet" standard

## Skipped

The 29 low/no-relevance items enumerated at the end of the impact assessment. Three of them
were checked far enough to be worth a sentence there (`canUseTool`'s `defaultToNo` /
`suppressAlwaysAllowRule`, `tool_use_result.resourceLinks`, `setModel()` confirming unknown
ids) and none changes anything DorkOS does today.

## Carried forward, still open

`api_error_status` (0.3.218/0.3.223) for ADR-0143's wasted-retry cost was identified at the
previous bump and is still unadopted. It is not this range's work, but it should not have to
be re-derived a third time.
