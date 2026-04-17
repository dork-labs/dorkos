---
slug: memory-recall-indicator
number: 248
created: 2026-04-17
status: ideation
---

# Memory Recall Indicator

**Slug:** memory-recall-indicator
**Author:** Claude Code
**Date:** 2026-04-17
**Branch:** preflight/memory-recall-indicator

---

## 1) Intent & Assumptions

- **Task brief:** Surface when the SDK recalls memory during a turn. Backend plumbing is complete (spec 245); the `memory_recall` StreamEvent is currently unhandled on the client. Render it so users can see what context shaped a response, in a way that feels like _craft_, not telemetry.
- **Assumptions:**
  - Memory recall events typically fire early in a turn (during system initialization or the first assistant thought), but can fire mid-stream.
  - Recall may fire multiple times per turn; aggregation is mandatory to avoid noise.
  - The DorkOS chat UI is mobile-responsive by default; every surface must work on touch.
  - The `AgentSession.memoryPaths` field already de-duplicates paths server-side.
  - The existing `MessagePart` discriminated union (text | tool_call | background_task | thinking | error | elicitation) is the correct extension point for new assistant-message artifacts.
- **Out of scope:**
  - Dedicated memory browser / search UI.
  - Memory editing or deletion flows.
  - Cross-session memory analytics.
  - Server-side file-preview endpoint (deferred; not needed for the tap-to-copy interaction model chosen).
  - Navigation to recalled files (`?dir=` or new chat context) — deferred to a follow-up.

## 2) Pre-reading Log

- `specs/claude-agent-sdk-upgrade-0.2.112/02-specification.md`, `specs/claude-agent-sdk-upgrade-0.2.112/04-implementation.md` — Established the `memory_recall` StreamEvent contract and confirmed client-side rendering was explicitly deferred to this spec.
- `packages/shared/src/schemas.ts:598-613` — StreamEvent Zod schema: `{ type: 'memory_recall', data: { mode, memories: [{ path, scope, content? }] } }`.
- `apps/server/src/services/runtimes/claude-code/agent-types.ts:32` — `AgentSession.memoryPaths?: string[]`; deduplicated via Set during mapping.
- `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts:137-150` — Emission point: the `system.memory_recall` handler accumulates paths onto session state and emits the StreamEvent.
- `apps/client/src/layers/features/chat/model/stream/stream-event-handler.ts:80-293` — Giant switch over 30+ event types; new case belongs around line 257 (sibling to `system_status`).
- `apps/client/src/layers/features/chat/ui/status/ChatStatusStrip.tsx` — Loading strip with rotating verbs + contextual system messages (api_retry, compact_boundary). **Not** the rendering surface for this feature (see Decision 2).
- `apps/client/src/layers/features/chat/ui/message/AssistantMessageContent.tsx` — Renders `message.parts[]` via a type-dispatched component map (TextBlock, ToolCallCard, BackgroundTaskBlock, ThinkingBlock, ErrorBlock).
- `research/20260316_extended_thinking_visibility_ui_patterns.md` — Four-state lifecycle model (idle / streaming / collapsing / collapsed), CSS grid collapse animation, ARIA contract. Directly transferable to memory recall.
- `research/20260323_tool_call_display_overhaul.md` — Sequential tool-call grouping pattern (5+ calls → summary badge, `"Read 7 files · 2 searches"`). Structural sibling for "accumulate during streaming, render once" pattern.
- `contributing/design-system.md` — Spacing (8/12/16/24px), Badge component, 100/200ms motion tokens, `data-slot` styling hooks.

## 3) Codebase Map

- **Primary components/modules:**
  - `apps/client/src/layers/features/chat/model/stream/stream-event-handler.ts` — add `memory_recall` case; emit/update a new `MessagePart` of type `memory_recall` pinned at index 0 of the current assistant message's parts.
  - `apps/client/src/layers/features/chat/ui/message/AssistantMessageContent.tsx` — extend part-type dispatch with `memory_recall` rendering.
  - `apps/client/src/layers/features/chat/ui/message/MemoryRecallBlock.tsx` (new) — the lifecycle component (streaming → completed → collapsed), modeled on `ThinkingBlock`.
  - `packages/shared/src/schemas.ts` / `packages/shared/src/types.ts` — extend the `MessagePart` discriminated union with a `memory_recall` variant carrying `{ mode, memories, status: 'streaming' | 'complete' }`.
- **Shared dependencies:**
  - `shared/ui/badge.tsx` (shadcn Badge) — for the collapsed chip.
  - `shared/ui/collapsible.tsx` (shadcn Collapsible) or the existing CSS grid collapse animation used by `ThinkingBlock`.
  - `@dorkos/icons` — need `BookOpen` / file-stack glyph for `select` mode and a sparkle glyph for `synthesize` mode.
  - `motion/react` animation primitives (see `contributing/animations.md`).
- **Data flow:**
  SDK → mapper emits `memory_recall` StreamEvent → SSE → client `stream-event-handler` → upserts a `memory_recall` part at `message.parts[0]` with mode + memories + `status: 'streaming'` → on `result` event, flip part status to `'complete'` → `MemoryRecallBlock` auto-collapses on status change → user can tap to re-expand.
- **Feature flags/config:** None. The feature is always-on when the event fires; zero-recall turns emit no part and no chip.
- **Potential blast radius:**
  - Direct: `stream-event-handler.ts`, `AssistantMessageContent.tsx`, new `MemoryRecallBlock.tsx`, `schemas.ts`/`types.ts` MessagePart union.
  - Indirect: tests in `stream-event-handler.test.ts` (existing pattern), any test that snapshots assistant-message rendering.
  - Tests needed: unit (handler accumulates paths, flips status on `result`), component (streaming / complete / collapsed states; tap-to-copy; mixed mode), integration (SSE → part rendered at top of bubble).

## 4) Research

**Competitive landscape (highlights):**

- **Perplexity** — inline `[1]` anchors + below-answer Sources panel. Gold standard for citation-forward UX, but paragraph-level granularity doesn't map to synthesized-memory responses.
- **ChatGPT memory** — invisible recall except for a "Memory updated" toast on write. Users explicitly distrust this black-box approach.
- **Cursor / Continue / Copilot Chat** — `@`/`#` context is visible as input pills; post-response attribution is not surfaced. Industry has not solved this.
- **Obsidian Copilot / Notion AI** — inline mention-link citations (e.g., `([Q4 Report])`) feel native to knowledge workflows. Strong fit for Priya.
- **NotebookLM** — hover-preview + click-to-navigate on per-source citations. Requires quoted passages that memory synthesis can't always provide.

**Pattern taxonomy takeaways:**

- **Aggregate, don't per-event.** Every mature tool that surfaces retrieval collects sources and renders once at the answer boundary. Per-event chips turn into visual noise fast.
- **Scope as secondary information.** No competitor leads with provenance badges; analogous tools use subtle favicon/icon cues inside expanded source rows.
- **Position matters.** Perplexity / Claude thinking blocks / Notion AI show sources at the top or before the answer — citation is context that _shaped_ the response, not a footnote to it.

**Anti-patterns observed:**

- Invisible recall (ChatGPT) — erodes trust.
- Per-event noise (unbounded badges) — clutters before the answer even appears.
- Generic "AI used context" chips with no specifics — brand-feel masquerading as transparency.
- Scope-as-primary information — feels like a security warning, not useful context.
- Blocking hover-preview on mobile — violates DorkOS's "responsive by default" bar.

**Research reports referenced:** `research/20260316_extended_thinking_visibility_ui_patterns.md`, `research/20260323_tool_call_display_overhaul.md`.

## 5) Design

**Lifecycle (top-of-bubble, modeled on `ThinkingBlock`):**

1. Memory recall event fires → a `memory_recall` part is inserted at `message.parts[0]` with `status: 'streaming'`.
2. A quiet line renders at the top of the (possibly still-empty) assistant bubble: _"Consulting memory…"_ — breathing opacity, same rhythm as `Thinking…`. Icon reflects mode (file-stack for `select`, sparkle for `synthesize`; mixed → file-stack).
3. Additional recall events during the same turn update the existing part in place: _"Consulting 3 memories…"_. Paths are appended to the part's `memories` array (server already dedupes; client re-confirms).
4. Text begins streaming below the recall line. The line stays pinned at the top of the bubble.
5. On `result` event, part status flips to `'complete'`. The line crystallizes into a collapsed `MemoryRecallBadge`: `"Recalled 3 memories"` with expand chevron.
6. Auto-collapses to the chip on completion (matching `ThinkingBlock`). Tap to re-expand.

**Expanded view (per Decision 1 — Option A):**

- Vertical list of rows, one per unique recalled path.
- Each row: mode-appropriate icon, monospace path (middle-ellipsis truncation on narrow viewports so the basename stays visible), muted `User` / `Users` icon for `personal` / `team` scope.
- `synthesize` rows: render the synthesis content paragraph instead of a path link; show the `<synthesis:DIR>` sentinel as a muted directory label underneath.
- Tap a row → copy the path (or the synthesis text) to clipboard with a toast confirmation.
- No hover-preview. No file navigation. (Deferred to a follow-up spec.)

**Mobile behavior:**

- Collapsed chip stays single-line at 320px: icon + "Recalled N memories" + chevron.
- Expanded rows are full-width, ≥44px tap targets.
- Paths use middle-ellipsis (`~/.claude/…/CLAUDE.md`) so the basename remains readable.
- No hover dependencies — tap is the only interaction model.

## 6) Decisions

| #   | Decision                                      | Choice                                                                                                                                                                                            | Rationale                                                                                                                                                                                                                                                                                                            |
| --- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Placement**                                 | New `memory_recall` `MessagePart`, pinned at `message.parts[0]` (top of assistant bubble)                                                                                                         | Memory is context that _shaped_ the answer — it belongs above the response, like Perplexity sources, Claude thinking blocks, and Notion AI citations. Keeps it persistent in scrollback. Avoids the status-strip collision with the sibling status-aware-loading spec. Matches the existing `ThinkingBlock` pattern. |
| 2   | **Lifecycle — real-time vs. end-of-turn**     | Top-of-bubble lifecycle (Option D): streaming indicator during recall → crystallizes into badge on turn completion                                                                                | Signals recall as it happens (honest by design), then persists as a permanent record at the top of the message. Best UX per the Jobs/Ive filter — reads as craft, not a bolted-on artifact. Mobile-visible as the message enters viewport. Avoids the sibling spec's status-strip work.                              |
| 3   | **Grouping**                                  | One `memory_recall` part per turn, accumulating all paths (deduped by server; client re-confirms)                                                                                                 | Per-recall chips = noise. Every mature citation UX (Perplexity, NotebookLM, ChatGPT research mode) aggregates. Matches the existing tool-call grouping pattern in DorkOS.                                                                                                                                            |
| 4   | **Interactivity**                             | Tap path → copy to clipboard. No hover preview. No file navigation. (Option A from clarification.)                                                                                                | Ships the transparency win without building new file-read infrastructure. Mobile-native (no hover-port failure). Memory files live in known locations; a savvy user can open them via existing habits. Defer navigation to a follow-up once the feature proves value.                                                |
| 5   | **`select` vs. `synthesize` differentiation** | Different icon (file-stack vs. sparkle) on collapsed chip. Expanded view renders path rows for `select`, synthesis paragraph for `synthesize`. Mixed turns → file-stack icon, both kinds of rows. | Honest by design: a synthesized summary is not the same artifact as a directly retrieved file, and the UI should say so at a glance.                                                                                                                                                                                 |
| 6   | **Scope badge (`personal` vs. `team`)**       | Muted `User` / `Users` icon per row in the expanded view only. Never on the collapsed chip.                                                                                                       | Scope is secondary information. Leading with it would read as a security warning. Competitors use the same subtle-in-detail approach.                                                                                                                                                                                |
| 7   | **Auto-collapse on completion**               | Yes, matches `ThinkingBlock` pattern.                                                                                                                                                             | Established DorkOS convention; validated by `research/20260316_extended_thinking_visibility_ui_patterns.md`. Keeps the message quiet after the turn while leaving the chip discoverable.                                                                                                                             |
| 8   | **Zero-recall turns**                         | No part emitted, no chip.                                                                                                                                                                         | "Every element must justify its existence." An empty badge is visual noise and dishonest (the agent didn't consult anything).                                                                                                                                                                                        |
| 9   | **Follow-up scope (not this spec)**           | Server `GET /api/files/preview?path=…` endpoint + hover-preview + click-to-open navigation.                                                                                                       | Valuable but orthogonal. Decoupling keeps this spec focused on the transparency win; all data needed to add preview/nav later is already in the part.                                                                                                                                                                |

## 7) Related work

- **Sibling spec (flagged by user, not yet created):** _Status-aware loading affordance_ — threads `system_status.data.status` ('requesting' | 'compacting') into `ChatStatusStrip.tsx`. Touches the same 0.2.112 upgrade context but a different rendering surface. Decision 2 (top-of-bubble placement) was chosen in part to avoid collision with this sibling spec. No coordination work needed beyond awareness.
- **Spec 196 (Extended Thinking Visibility):** `ThinkingBlock` is the direct architectural precedent. Reuse its collapse animation, ARIA contract, and auto-collapse-on-completion behavior.
- **Spec 207 (Tool Progress Streaming) / Spec 169 (Tool Call Display Overhaul):** Same message-parts rendering pattern; the new component sits alongside these.
