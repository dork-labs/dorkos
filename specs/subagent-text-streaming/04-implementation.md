# Implementation Summary: Subagent Text Streaming via `forwardSubagentText`

**Created:** 2026-06-08
**Last Updated:** 2026-06-08
**Spec:** specs/subagent-text-streaming/01-ideation.md

## Progress

**Status:** Complete
**Tasks Completed:** Implemented directly from ideation (no `02-specification.md` / `03-tasks.json` existed; the ideation was detailed enough to implement as a single cohesive feature).

## What Was Built

Adopted the SDK `forwardSubagentText` option (0.2.119+, shipping in our pinned 0.3.168) so the operator can watch a subagent's live text inside its inline background-task block — not just a progress spinner.

**Data flow:** With `forwardSubagentText` on, the SDK forwards a subagent's text as **complete `assistant` messages** tagged with `parent_tool_use_id` (verified empirically against SDK 0.3.168 — it does _not_ deliver subagent text as `stream_event` deltas). The mapper extracts the `text` content blocks from those forwarded assistant messages and emits a new `subagent_text_delta` stream event carrying `{ parentToolUseId, text }`. The client correlates `parentToolUseId` → the `BackgroundTaskPart.toolUseId` captured from `background_task_started` (the SDK sets both to the spawning Agent/Task tool-use id), accumulates the text onto `BackgroundTaskPart.subagentText`, and renders it (expandable, auto-tailing) inside `SubagentBlock`.

### Critical correctness note

Turning on `forwardSubagentText` interleaves subagent-tagged messages with the main thread. The mapper distinguishes them by `parent_tool_use_id`:

- **`assistant` + `parent_tool_use_id`** → the subagent's output. Its `text` blocks become `subagent_text_delta`; `tool_use`/`thinking` blocks are dropped (v1 is text-only).
- **`user` + `parent_tool_use_id`** → the subagent's _input_ prompt — dropped (it is not subagent output).
- **`stream_event` + `parent_tool_use_id`** → dropped without emitting. Letting it fall through would corrupt the shared main-thread `toolState` and leak subagent text into the primary stream. (The SDK doesn't forward subagent text this way, so there's nothing to emit — the guard exists purely to protect main-thread state.)

Granularity caveat: because the SDK forwards complete assistant messages (not token deltas), subagent text appears **per turn**, not character-by-character.

## Files Modified/Created

**Source files (server):**

- `apps/server/src/services/runtimes/claude-code/message-sender.ts` — set `forwardSubagentText: true` in `sdkOptions`.
- `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts` — branch on `parent_tool_use_id`; emit `subagent_text_delta`; guard `assistant`/`user` handlers against forwarded subagent messages.

**Source files (shared):**

- `packages/shared/src/schemas.ts` — added `subagent_text_delta` to `StreamEventTypeSchema`; `SubagentTextDeltaEventSchema`; added it to the `StreamEventSchema` union; added `toolUseId` + `subagentText` to `BackgroundTaskPartSchema`.
- `packages/shared/src/types.ts` — exported `SubagentTextDeltaEvent`.

**Source files (client):**

- `apps/client/src/layers/features/chat/model/stream/stream-event-types.ts` — `findBackgroundTaskPartByToolUseId` on `StreamHandlerHelpers`.
- `apps/client/src/layers/features/chat/model/stream/stream-event-helpers.ts` — implemented the finder.
- `apps/client/src/layers/features/chat/model/stream/stream-tool-handlers.ts` — `handleSubagentStarted` persists `toolUseId`; added `handleSubagentTextDelta`.
- `apps/client/src/layers/features/chat/model/stream/stream-event-handler.ts` — registered the `subagent_text_delta` case.
- `apps/client/src/layers/features/chat/ui/message/SubagentBlock.tsx` — renders `subagentText` in a calm, scrollable, auto-tailing area; expandable when present.

**Dev playground:**

- `apps/client/src/dev/mock-samples.ts` — `streaming` variant of `BACKGROUND_TASK_PARTS` with `subagentText`.
- `apps/client/src/dev/showcases/ToolShowcases.tsx` — updated SubagentBlock showcase description.
- `apps/client/src/dev/sections/chat-sections.ts` — added discoverability keywords.

**Test files:**

- `apps/server/.../__tests__/sdk-scenarios.ts` — `sdkSubagentTextDelta` builder; `tool_use_id` param on `sdkTaskStarted`.
- `apps/server/.../__tests__/sdk-event-mapper.test.ts` — emission, correlation, no-leak, no-toolState-corruption, dropped-assistant-message.
- `apps/client/.../ui/message/__tests__/SubagentBlock.test.tsx` — expandability + reveal of streamed text.
- `apps/client/.../model/__tests__/stream-event-handler-subagent.test.ts` — correlation, concurrent-task routing, orphan-drop.

## Verification

- `pnpm typecheck` — 21/21 tasks pass (includes client build).
- `pnpm lint` — 0 errors (warnings all pre-existing, in untouched files).
- Tests: shared 473, server claude-code runtime 269, client chat 766, dev playground 46 — all pass.

## Known Issues

None.

## Implementation Notes

- **Dependency cleared:** the ideation lists this as blocked by the SDK 0.3.168 upgrade (#250). That upgrade is already in `apps/server/package.json`; `apps/server` resolves `0.3.168`, which ships `forwardSubagentText`. Feature is unblocked.
- **v1 scope boundary:** rendered in the inline `SubagentBlock` (the canonical expandable, persistent-within-session affordance) rather than also threading text through the live `BackgroundTaskBar`/`TaskDetailRow`. The bar stays a compact live indicator; the inline block is where you read the work. Subagent _thinking_ and _tool-call_ blocks are intentionally dropped (text only). `subagentText` is live-only and not persisted to the transcript (matches the spec's out-of-scope note), so it is absent on session reload.
