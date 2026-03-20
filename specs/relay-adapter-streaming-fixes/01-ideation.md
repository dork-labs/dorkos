---
slug: relay-adapter-streaming-fixes
number: 129
created: 2026-03-14
status: ideation
---

# Relay Adapter Streaming Fixes & Enhancements

**Slug:** relay-adapter-streaming-fixes
**Author:** Claude Code
**Date:** 2026-03-14
**Branch:** preflight/relay-adapter-streaming-fixes

---

## 1) Intent & Assumptions

- **Task brief:** Fix three bugs in the Slack adapter (streaming text appears on new lines, agent runs in wrong CWD instead of binding's project path, responses get edited into previous messages) and add two features (streaming on/off toggle, typing indicators for Slack and Telegram).
- **Assumptions:**
  - The relay/adapter architecture is sound -- these are implementation-level fixes
  - Slack adapter is already functional (Socket Mode connected, messages flowing)
  - Telegram adapter's typing signal infrastructure exists and just needs interval refresh
  - The `slackify-markdown` library's Issue #40 ("new sections between line breaks") is the primary cause of the newline bug
- **Out of scope:**
  - Migration to Slack's native `chatStream` API (future improvement)
  - Telegram streaming behavior changes (already buffers correctly)
  - UI changes to the relay panel or binding configuration screens
  - New adapter types

## 2) Pre-reading Log

- `packages/relay/src/adapters/slack/outbound.ts`: Streaming delivery via `chat.postMessage` (first delta) then `chat.update` (throttled at 1s). `streamKey()` uses `channelId:threadTs` -- buggy when `threadTs` is undefined. `accumulatedText` stores raw Markdown, converted via `formatForPlatform()` at send time.
- `packages/relay/src/adapters/slack/inbound.ts`: Inbound messages set `replyTo: subject` (e.g., `relay.human.slack.D123`). `platformData.ts` is always present for inbound Slack messages.
- `packages/relay/src/adapters/slack/slack-adapter.ts`: Extends `BaseRelayAdapter`. No signal subscription (no typing indicator). `streamState` Map managed per-instance.
- `packages/relay/src/lib/payload-utils.ts`: `formatForPlatform('slack')` delegates to `slackify-markdown`. Known Issue #40: creates `\n\n` paragraph separation between sections.
- `apps/server/src/services/relay/binding-router.ts`: Routes `relay.human.>` to `relay.agent.{sessionId}`. Creates sessions via `agentManager.createSession(binding.projectPath)`. Republishes envelope with same `replyTo` but does NOT attach `binding.projectPath` to payload or context.
- `packages/relay/src/adapters/claude-code/agent-handler.ts`: CWD resolution chain: `payloadCwd` > `context.agent.directory` > deferred. Neither is set by BindingRouter, so CWD falls through to session default (which may differ from binding's `projectPath`).
- `packages/relay/src/signal-emitter.ts`: Ephemeral signal bus with NATS-style pattern matching. `onSignal()` returns `Unsubscribe`.
- `packages/relay/src/adapters/telegram/outbound.ts`: Has `handleTypingSignal()` calling `sendChatAction(chatId, 'typing')` -- but only fires once (no interval refresh). Telegram's typing indicator expires after 5 seconds.
- `packages/relay/src/adapters/telegram/telegram-adapter.ts`: Subscribes to typing signals at line 136 via `relay.onSignal()`. Cleanup in `_stop()`.
- `packages/shared/src/relay-adapter-schemas.ts`: `SlackAdapterConfig` has `botToken`, `appToken`, `signingSecret` only. No `streaming` or `typingIndicator` fields.
- `specs/slack-adapter/02-specification.md`: Original spec designed streaming with `chat.update`. No toggle mentioned.
- `contributing/relay-adapters.md`: Documents adapter interface, lifecycle, compliance suite.

## 3) Codebase Map

- **Primary components/modules:**
  - `packages/relay/src/adapters/slack/outbound.ts` -- Stream-aware message delivery (handleTextDelta, handleDone, handleError)
  - `packages/relay/src/adapters/slack/slack-adapter.ts` -- Adapter lifecycle, Socket Mode, state management
  - `packages/relay/src/adapters/slack/inbound.ts` -- Inbound parsing, subject building, echo prevention
  - `packages/relay/src/lib/payload-utils.ts` -- `formatForPlatform()`, StreamEvent detection utilities
  - `apps/server/src/services/relay/binding-router.ts` -- Routes `relay.human.*` to `relay.agent.*`, session creation
  - `packages/relay/src/adapters/claude-code/agent-handler.ts` -- Handles `relay.agent.*`, CWD resolution, `ensureSession()`
  - `packages/relay/src/signal-emitter.ts` -- Ephemeral signal bus for typing/presence
  - `packages/relay/src/adapters/telegram/outbound.ts` -- Telegram delivery + typing handler (reference impl)
  - `packages/relay/src/adapters/telegram/telegram-adapter.ts` -- Telegram adapter lifecycle, signal subscription
  - `packages/shared/src/relay-adapter-schemas.ts` -- Zod schemas for adapter configs

- **Shared dependencies:**
  - `slackify-markdown` npm package (Markdown to mrkdwn conversion)
  - `@slack/bolt` (Socket Mode, WebClient)
  - `detectStreamEventType()`, `extractTextDelta()`, `extractErrorMessage()` in payload-utils
  - `BaseRelayAdapter` base class
  - Signal subscription via `relay.onSignal()` pattern

- **Data flow:**

  ```
  Inbound:  Slack event → handleInboundMessage → relay.human.slack.{channelId}
                        → BindingRouter → relay.agent.{sessionId}
                        → AgentHandler → ensureSession(cwd) → sendMessage()

  Outbound: Agent stream events → relay.human.slack.{channelId}
                               → SlackAdapter.deliver() → outbound.deliverMessage()
                               → chat.postMessage / chat.update (Slack API)
  ```

- **Feature flags/config:** None currently. New fields will be added to `SlackAdapterConfigSchema`.

- **Potential blast radius:**
  - `outbound.ts` -- Primary changes (streaming logic, typing, toggle)
  - `slack-adapter.ts` -- Signal subscription wiring, config threading
  - `relay-adapter-schemas.ts` -- New config fields (streaming, typingIndicator)
  - `binding-router.ts` -- CWD propagation fix
  - `agent-handler.ts` -- CWD resolution fallback
  - `telegram/outbound.ts` -- Typing interval refresh
  - `telegram-adapter.ts` -- Typing interval cleanup in `_stop()`
  - Test files for all above

## 4) Root Cause Analysis

### Bug 1: Streaming text appears on new lines

- **Observed:** Each new streaming chunk appears on a new line in Slack
- **Expected:** Text flows continuously, updating in-place like a typewriter
- **Evidence:** `slackify-markdown` Issue #40 (open, unresolved) causes `\n\n` paragraph separation between block-level elements. When `formatForPlatform(accumulatedText, 'slack')` runs on intermediate updates, the library converts Markdown paragraphs into double-newline-separated mrkdwn, which Slack renders as separate lines.
- **Root-cause hypotheses:**
  1. **`slackify-markdown` paragraph handling** (HIGH confidence) -- The library treats accumulated text as having paragraph breaks and inserts `\n\n` between sections in the mrkdwn output
  2. **Raw text chunks containing literal newlines** (MEDIUM confidence) -- Agent SDK `text_delta` events may include `\n` characters that accumulate into visible line breaks
- **Decision:** Fix by collapsing `\n{2,}` to `\n` on intermediate `chat.update` calls only. Preserve full paragraph formatting on the final `handleDone` flush.

### Bug 2: Messages going to wrong CMD (CWD mismatch)

- **Observed:** Agent responds but operates in the DorkOS server's directory instead of the binding's `projectPath`
- **Expected:** Agent should work in the project directory specified in the binding configuration
- **Evidence:** `binding-router.ts` line 131-135 republishes to `relay.agent.{sessionId}` but does NOT attach `binding.projectPath` to the envelope payload or context. `agent-handler.ts` lines 73-77 resolve CWD via `payloadCwd ?? context?.agent?.directory` -- both are undefined because BindingRouter doesn't set either. The session was created with `binding.projectPath` via `createNewSession()`, but `ensureSession()` in the agent handler doesn't preserve the original CWD if the session already exists.
- **Root-cause hypotheses:**
  1. **CWD not propagated from binding to agent handler** (HIGH confidence) -- BindingRouter creates the session with projectPath but doesn't attach it to subsequent messages
  2. **Session reuse with stale CWD** (MEDIUM confidence) -- Per-chat sessions created with one CWD may lose it on server restart
- **Decision:** Enrich envelope payload with `cwd: binding.projectPath` in BindingRouter before republishing. Agent handler already extracts `payloadCwd` from the payload.

### Bug 3: Responses edited into previous messages

- **Observed:** New agent responses get appended/edited into a previous message instead of posting as a new message
- **Expected:** Each agent response should create its own message
- **Evidence:** `streamKey()` (line 70-72) returns just `channelId` when `threadTs` is undefined. Two responses in the same channel with no thread context share the same stream key. The second response finds the first response's `ActiveStream` entry and calls `chat.update` on it instead of `chat.postMessage`.
- **Root-cause hypotheses:**
  1. **Stream key collision** (HIGH confidence) -- When `threadTs` is undefined, all responses in the same channel share key `channelId`
  2. **Orphaned stream state** (MEDIUM confidence) -- If a `done` event is missed, the old `ActiveStream` entry persists and the next response appends to it
  3. **Async race in handleDone** (LOW confidence) -- `streamState.delete(key)` before async `chat.update` creates a window where a new stream can start
- **Decision:** Fix `resolveThreadTs` to always return `platformData.ts` as fallback (always present for inbound Slack messages). Add synthetic correlation ID fallback for programmatic messages. Add `streamId` field to `ActiveStream` for race detection.

## 5) Research

### Potential solutions:

**1. Newline fix -- Collapse intermediate paragraph breaks**

- Description: Apply `.replace(/\n{2,}/g, '\n')` to intermediate `chat.update` text only; preserve full formatting on `handleDone`
- Pros: Surgical (1 line), no library changes, preserves final message formatting
- Cons: Loses paragraph structure mid-stream (acceptable -- it's a progressive preview)
- Complexity: Trivial

**2. Newline fix -- Switch to Slack's native `markdown` block type**

- Description: Use `blocks` API with `type: "markdown"` instead of `text` field
- Pros: Slack handles conversion server-side
- Cons: Requires `blocks` API migration, `text` field still needed as accessibility fallback
- Complexity: Medium

**3. CWD fix -- Enrich envelope payload with binding projectPath**

- Description: BindingRouter adds `cwd: binding.projectPath` to envelope payload before republishing
- Pros: Agent handler already extracts `payloadCwd` from payload (line 74-76). Zero changes to agent handler.
- Cons: Mutates payload (but this is standard practice for routing enrichment)
- Complexity: Trivial

**4. Stream key fix -- Fix resolveThreadTs + synthetic fallback**

- Description: Ensure `resolveThreadTs` returns `platformData.ts` as fallback; use synthetic ID when no platform data
- Pros: Uses existing data, correct per-conversation semantics
- Cons: None significant
- Complexity: Low

**5. Stream key fix -- Add streamId to ActiveStream**

- Description: Generate unique ID per stream for race detection in handleDone
- Pros: Eliminates async race completely, observable in logs
- Cons: Minor API surface expansion
- Complexity: Low

**6. Streaming toggle -- Per-adapter config boolean**

- Description: `streaming: z.boolean().default(true)` in `SlackAdapterConfigSchema`. When false, buffer all deltas and send single message on `done` (like Telegram).
- Pros: Clean, follows established pattern (Telegram's polling/webhook mode toggle). Per-workspace control.
- Cons: No per-channel granularity (acceptable)
- Complexity: Low

**7. Slack typing -- Emoji reaction**

- Description: `reactions.add(':hourglass_flowing_sand:')` on stream start, `reactions.remove` on done. Fire-and-forget.
- Pros: Visible, low noise, 2 API calls per stream. Works within Slack's API limitations.
- Cons: Requires `reactions:write` scope (users must re-install app). Not a native typing indicator.
- Complexity: Low

**8. Telegram typing -- Interval refresh**

- Description: `setInterval` at 4 seconds in `handleTypingSignal`, clear on stop/done
- Pros: Correct per Telegram docs (typing expires after 5s). ~30 lines of code.
- Cons: Needs cleanup in `_stop()` to prevent interval leaks
- Complexity: Low

- **Recommendation:** Solutions 1, 3, 4+5, 6, 7, 8 -- all are low complexity, high impact, and complementary. Implement in priority order: bugs first (3, 4+5, 1), then Telegram typing (8), then streaming toggle (6), then Slack typing (7).

## 6) Decisions

| #   | Decision                         | Choice                                           | Rationale                                                                                                                                                                                                                 |
| --- | -------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Slack typing indicator mechanism | Emoji reaction (`:hourglass_flowing_sand:`)      | No native bot typing API in modern Slack (confirmed by Slack team in bolt-js #885). Emoji reactions are visible, low-noise, and cost only 2 API calls per stream. Requires adding `reactions:write` scope.                |
| 2   | Streaming toggle scope           | Per-adapter config (`streaming: boolean`)        | Streaming is a delivery mechanism behavior, not a binding relationship property. Follows the pattern of Telegram's polling/webhook mode toggle. Simple, clean.                                                            |
| 3   | Routing bug diagnosis            | CWD not propagated from binding to agent handler | User confirmed: agent responds but works in wrong directory. BindingRouter creates session with `projectPath` but doesn't attach it to subsequent messages. Fix: enrich envelope payload with `cwd: binding.projectPath`. |
