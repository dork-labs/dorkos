---
title: 'Runtime Event Gap Audit — SDK Data Each Adapter Receives vs Forwards to the Client'
date: 2026-08-01
type: codebase-analysis
status: active
tags: [runtime, agent-runtime, sdk, event-mapper, streaming, claude-code, codex, opencode, chat-ui]
feature_slug: chat-touch-chips
---

# Runtime Event Gap Audit

Commissioned during the chat touch-chips design session (`specs/chat-touch-chips/`) to answer: what live context do the runtime SDKs offer that our adapters drop before it reaches the chat UI? Line references are as of main 2026-08-01 (`a0c71d31e`); re-verify before building.

## Normalized schema ceiling

`StreamEvent` (packages/shared/src/schemas.ts:1281-1319, 38 types) does not model: turn duration, API round-trip count (`num_turns`), first-class stop reason, file diff/patch payloads, or per-tool structured titles/metadata. Any adapter fix for the gaps below that needs these requires schema additions first.

## claude-code (@anthropic-ai/claude-agent-sdk)

Mapped well: `thinking_delta` + `input_json_delta` stream live (`includePartialMessages: true`, message-sender.ts:422); per-turn cost + `modelUsage`; hooks; memory recall; compact boundary; api_retry; rate-limit events. `thinking-config.ts:97-102` forces `display: 'summarized'` so Opus 4.7/4.8 keep streaming visible thinking (fixed in #669).

Dropped (highest value first):

| SDK capability                                                                                                                                                                                                   | Where dropped                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `getContextUsage()` full breakdown — `mcpTools[]`, `agents[]`, `skills{}`, `slashCommands{}`, `systemPromptSections[]`, `memoryFiles[]`, `messageBreakdown{toolCallTokens, toolResultTokens, attachmentTokens…}` | only 5 scalars survive `mapSdkContextUsage` (claude-code/context-usage.ts:37-51) |
| `SDKResult.duration_ms`, `duration_api_ms`, `num_turns`, `ttft_ms`, `stop_reason`, `permission_denials[]` (batch)                                                                                                | never read in result-event-mapper.ts — a complete "turn receipt" discarded       |
| `system.init` — `mcp_servers[]{status}`, `tools[]`, `agents[]`, `skills[]`, `plugins[]`, `slash_commands[]`, `claude_code_version`                                                                               | only `model` mapped (system-event-mapper.ts:29-39)                               |
| `system.task_updated`, `files_persisted`, `local_command_output`, `plugin_install`, `model_refusal_fallback`, `notification`                                                                                     | fall through to catch-all debug log (system-event-mapper.ts:344-349)             |
| top-level `auth_status` message                                                                                                                                                                                  | no case in sdk-event-mapper.ts:30-48                                             |
| `citations_delta`, `signature_delta`, compaction content deltas                                                                                                                                                  | no else-branch in stream-event-mapper.ts:57-77                                   |
| subagent thinking / tool_use / tool_result                                                                                                                                                                       | text-only by design (message-event-mapper.ts:97)                                 |

## codex (@openai/codex-sdk)

The SDK is thin; most gaps are SDK ceilings, not adapter oversights: no cost, no context-window size, no model echo per turn, no subagents, no incremental tool-input streaming, `file_change` carries `{path, kind}` only (no diff content, hence no diffstat on touch chips). One real adapter choice: `reasoning_output_tokens` is folded into `outputTokens` (event-mapper.ts:120-144) instead of reported separately.

## opencode (@opencode-ai/sdk)

Mapped: true per-token deltas, tool lifecycle, cost/model per message, todo updates, permission prompts.

Dropped:

| SDK capability                                                                                                                       | Where dropped                                       |
| ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| **`subtask` part (OpenCode's Task/subagent) — zero subagent visibility**                                                             | default `return []` branch, event-mapper.ts:349-354 |
| **`session.diff` — `FileDiff[]{file, before, after, additions, deletions}` pre-computed server-side**                                | explicit ignore list, event-mapper.ts:236           |
| Context-window max — already fetched for the model picker (models.ts:102,139) but never joined into `session_status`/`context_usage` | no emission anywhere in event-mapper.ts             |
| `ToolStateRunning/Completed.title`, `.metadata`, `.attachments`                                                                      | event-mapper.ts:438-467                             |
| `AssistantMessage.tokens.reasoning`, `.finish` (stop reason)                                                                         | mapMessageUpdated, event-mapper.ts:483-511          |
| `StepFinishPart` per-step cost/tokens; `RetryPart` rich error; `CompactionPart.auto` (compact_boundary emitted with empty payload)   | various, see event-mapper.ts:270-281, 547-555       |

## What these could power (deferred from the touch-chips program by design)

Recorded as round-2 candidates in `specs/chat-touch-chips/design-decisions.md` §1 (Options B/C, deliberately not shipped): live tool-input typing display, thinking-label shimmer + thought-token ticker, per-turn "receipt" chip (cost · tokens · api turns · model · ttft) from the dropped result fields, context fuel gauge with the full breakdown, OpenCode subagent blocks via `subtask`, richer diffs via `session.diff`.
