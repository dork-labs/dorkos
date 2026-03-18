---
slug: slack-tool-approval
number: 145
created: 2026-03-18
status: ideation
---

# Interactive Tool Approval via Chat Adapter Buttons

**Slug:** slack-tool-approval
**Author:** Claude Code
**Date:** 2026-03-18
**Branch:** preflight/slack-tool-approval

---

## 1) Intent & Assumptions

- **Task brief:** Implement interactive tool approval in chat adapters (Slack and Telegram) using platform-native buttons, so that when an agent requests permission to use a tool (e.g., file write, shell command), the user sees a rich card with Approve/Deny buttons and can respond directly — unblocking the agent without needing the web UI.

- **Assumptions:**
  - Slack Socket Mode supports Block Kit interactive actions via `app.action()` (confirmed in research — Bolt v3+ handles `block_actions` over WebSocket)
  - Telegram polling mode supports inline keyboard buttons with `callback_data` natively
  - The relay message bus can carry approval response messages between adapters
  - The existing `canUseTool()` deferred promise pattern in `interactive-handlers.ts` is the correct resolution mechanism
  - `approval_required` events are already flowing through the adapter delivery pipeline (after the whitelist fix)
  - The Slack app manifest only needs `interactivity: { is_enabled: true }` under `settings` — no `request_url` required for Socket Mode

- **Out of scope:**
  - `question_prompt` events (AskUserQuestion) — different interaction pattern, future spec
  - Approval history/audit logging
  - Per-user approval permissions (any user in the channel/chat can approve)
  - Customizable approval timeout per adapter
  - Approval delegation or escalation workflows

## 2) Pre-reading Log

- `packages/relay/src/adapters/slack/outbound.ts`: Main delivery implementation (711 lines). Handles `text_delta`, `error`, `done` via whitelist model. The `approval_required` case would be a new branch at line ~688 before the silent-drop fallthrough. Uses `wrapSlackCall()` for API error handling and `resolveThreadTs()` for threading.

- `packages/relay/src/adapters/slack/slack-adapter.ts`: Adapter class (340 lines) with Socket Mode setup. Currently registers `app.message()` and `app.event('app_mention')` only. The `app.action()` handler for button clicks would be registered here during `start()`.

- `packages/relay/src/adapters/slack/inbound.ts`: Inbound message handler (309 lines). Defines `SUBJECT_PREFIX = 'relay.human.slack'`, `buildSubject()`, `extractChannelId()`. These utilities will be reused for routing approval responses.

- `packages/relay/src/adapters/telegram/outbound.ts`: Telegram delivery — similar whitelist structure. Would need an `approval_required` branch that sends inline keyboard buttons via `bot.api.sendMessage()` with `reply_markup: { inline_keyboard }`.

- `packages/relay/src/adapters/telegram/telegram-adapter.ts`: Telegram adapter with GrammY bot. Uses `bot.on('message:text')` for inbound. Would need `bot.on('callback_query:data')` for inline button responses.

- `apps/server/src/services/runtimes/claude-code/interactive-handlers.ts`: `handleToolApproval()` creates `approval_required` events with `toolCallId`, `toolName`, `input: JSON.stringify(input)`, `timeoutMs`. Stores deferred promise in `session.pendingInteractions`. The resolve callback receives `approved: boolean`.

- `apps/server/src/services/runtimes/claude-code/agent-types.ts`: `AgentSession.pendingInteractions: Map<string, PendingInteraction>` with `type: 'question' | 'approval'`, `resolve`, `reject`, `timeout`.

- `apps/server/src/routes/sessions.ts`: Routes `POST /api/sessions/:id/approve` and `POST /api/sessions/:id/deny` call `runtime.approveTool(sessionId, toolCallId, boolean)`.

- `packages/relay/src/adapters/claude-code/agent-handler.ts`: Handles `relay.agent.{agentId}` messages. `publishResponseWithCorrelation()` forwards stream events to adapters. The `approval_required` event flows through here to `replyTo` subjects.

- `packages/relay/src/adapters/claude-code/types.ts`: `AgentRuntimeLike` interface — `ensureSession()`, `sendMessage()`, `getSdkSessionId()`. Would need `approveTool()` method added for relay-based approval routing.

- `contributing/relay-adapters.md`: Adapter architecture guide. Shows `RelayAdapter` interface, `deliver()` contract, signal subscription patterns.

- `contributing/interactive-tools.md`: Full walkthrough of interactive tool architecture — canUseTool callback, deferred promise pattern, SSE event flow, client-side ToolApproval component.

- `research/20260317_relay_adapter_event_whitelist.md`: Root cause analysis of event filtering. Confirms `approval_required` was silently dropped by the old blacklist approach. The whitelist fix (Phase 1 from the relay-adapter-event-whitelist spec) is a prerequisite.

- `specs/relay-adapter-event-whitelist/02-specification.md`: Detailed Phase 1 fix for the whitelist model. Prerequisite for this feature.

## 3) Codebase Map

- **Primary components/modules:**
  - `packages/relay/src/adapters/slack/outbound.ts` — Delivery pipeline, needs `approval_required` branch
  - `packages/relay/src/adapters/slack/slack-adapter.ts` — Bolt app lifecycle, needs `app.action()` registration
  - `packages/relay/src/adapters/telegram/outbound.ts` — Delivery pipeline, needs `approval_required` branch with inline keyboard
  - `packages/relay/src/adapters/telegram/telegram-adapter.ts` — GrammY bot, needs `callback_query:data` handler
  - `packages/relay/src/adapters/claude-code/agent-handler.ts` — Stream event forwarding, needs to listen for approval relay messages
  - `packages/relay/src/adapters/claude-code/types.ts` — `AgentRuntimeLike`, needs `approveTool()` method
  - `apps/server/src/services/relay/adapter-manager.ts` — Wires adapter dependencies

- **Shared dependencies:**
  - `packages/relay/src/types.ts` — `RelayPublisher`, `DeliveryResult`, `AdapterContext`
  - `packages/relay/src/lib/payload-utils.ts` — `detectStreamEventType()`, `extractPayloadContent()`
  - `packages/shared/src/relay-schemas.ts` — `RelayEnvelope`, `StandardPayload`
  - `@slack/bolt` v4+ — Socket Mode, `app.action()` handler
  - `grammy` — Telegram Bot API, inline keyboards, callback queries

- **Data flow:**
  1. SDK calls `canUseTool()` → `interactive-handlers.ts` creates deferred promise + pushes `approval_required` to event queue
  2. Event streams through `agent-handler.ts` → `publishResponseWithCorrelation()` → published to `replyTo` subject (e.g., `relay.human.slack.D123`)
  3. Adapter registry routes to Slack/Telegram adapter's `deliver()` method
  4. `outbound.ts` detects `approval_required` event type → renders Block Kit card / inline keyboard with Approve/Deny buttons
  5. User clicks button → Slack `block_actions` / Telegram `callback_query` fires
  6. Adapter handler parses button value → publishes to `relay.system.approval.{agentId}` with `{ toolCallId, approved }`
  7. CCA adapter subscribes to `relay.system.approval.>` → calls `runtime.approveTool(sessionId, toolCallId, approved)`
  8. Deferred promise resolves → SDK resumes with `{ behavior: 'allow' | 'deny' }`

- **Feature flags/config:**
  - No new config fields needed — approval flow is automatic when `approval_required` events are whitelisted
  - Permission mode (`default`, `plan`, `bypassPermissions`) controls whether approvals are requested at all

- **Potential blast radius:**
  - Direct: 6-8 files (Slack outbound/adapter, Telegram outbound/adapter, CCA types/handler, adapter-manager)
  - Indirect: `contributing/relay-adapters.md` (document new pattern), `contributing/interactive-tools.md` (document adapter flow)
  - Tests: Slack outbound tests, Telegram outbound tests, Slack adapter tests, Telegram adapter tests, CCA adapter tests

## 4) Root Cause Analysis

N/A — this is a new feature, not a bug fix.

## 5) Research

### Potential Solutions

**1. Block Kit Buttons (Slack) + Inline Keyboards (Telegram)**
- Description: Use platform-native interactive components — Slack Block Kit action buttons with `app.action()` handlers, Telegram inline keyboard buttons with `callback_query:data` handlers
- Pros:
  - Rich, native UX on both platforms
  - One-click approval (no typing required)
  - Buttons auto-disable after click (via message update)
  - Socket Mode and polling mode both support interactive components natively
  - Idiomatic Slack/Telegram UX patterns
- Cons:
  - Requires Slack app manifest update (`interactivity.is_enabled: true`)
  - More implementation surface than text-based approach
  - Button `value` field has 2000 char limit (not a practical concern — we only encode IDs)
- Complexity: Medium
- Maintenance: Low

**2. Text-based approval ("reply approve/deny")**
- Description: Present approval requests as text messages; user replies with "approve" or "deny"
- Pros:
  - No new Slack/Telegram API surface needed
  - Works with current adapter capabilities
- Cons:
  - Poor UX — requires typing, easy to typo
  - Ambiguous parsing ("yes", "ok", "approve this one")
  - No visual feedback when approved
  - Can't distinguish approval replies from regular conversation
- Complexity: Low
- Maintenance: Medium (parsing edge cases)

**3. Emoji reaction-based approval**
- Description: User reacts with thumbs-up/thumbs-down emoji on the approval message
- Pros:
  - Low-friction interaction
  - Already have `reactions:write` scope
- Cons:
  - Slack doesn't push reaction events in Socket Mode reliably
  - No way to present tool details or context
  - Multiple reactions on same message cause confusion
  - Can't revoke or change decision easily
- Complexity: Low
- Maintenance: High (edge cases)

### Security Considerations
- Socket Mode eliminates replay attack surface (no HTTP endpoint exposed)
- Encode `allowedUserId` in button value to restrict who can approve (optional, out of scope for V1)
- Never encode sensitive tool input parameters in button values — keep server-side
- Slack's signature verification is handled automatically by Bolt SDK in Socket Mode

### Performance Considerations
- `ack()` must be called within 3 seconds of button click (Slack requirement)
- Message updates via `chat.update` are rate-limited (1 per second per message)
- Relay publish for approval response adds minimal latency (~1ms in-process)

### Recommendation

**Recommended Approach:** Block Kit Buttons (Slack) + Inline Keyboards (Telegram)

**Rationale:** This is the idiomatic approach for both platforms. The UX is dramatically better than text-based alternatives — one click vs. typing. Socket Mode and polling mode both support interactive components natively, so no webhook infrastructure is needed. The implementation complexity is manageable given the existing adapter patterns.

**Caveats:**
- Requires Slack app manifest update for interactivity
- Button value encoding must be kept small (IDs only, no tool input)

## 6) Decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Approval routing mechanism | Relay message bus (`relay.system.approval.{agentId}`) | Keeps adapters decoupled. Consistent with existing relay architecture. The CCA adapter subscribes to the approval subject and calls `runtime.approveTool()`. No new dependencies between chat adapters and server internals. |
| 2 | Event intercept point | New branch in `outbound.ts` `deliverMessage()` | The `approval_required` event is already flowing through `deliver()` — just needs a handler that renders Block Kit / inline keyboard instead of dropping it. Follows the existing whitelist model alongside `text_delta`, `error`, and `done`. |
| 3 | Approval card placement | In-thread (using `thread_ts` / reply-to-message) | Keeps context together — the user sees the conversation, then the approval request inline. Consistent with how text responses are already threaded on both platforms. |
| 4 | Platform scope | Both Slack + Telegram | Telegram's inline keyboards work with polling mode and have a similar API surface. Implementing both simultaneously delivers full adapter parity and allows shared design patterns. |
