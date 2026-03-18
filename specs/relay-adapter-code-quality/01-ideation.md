---
slug: relay-adapter-code-quality
number: 149
created: 2026-03-18
status: specification
---

# Relay Adapter System Code Quality & DRY Remediation

**Slug:** relay-adapter-code-quality
**Author:** Claude Code
**Date:** 2026-03-18

---

## 1) Intent & Assumptions

- **Task brief:** Deep code review of the Relay system identified systematic DRY violations, file size limit breaches, module-level mutable state issues, incomplete implementations, and overcomplicated patterns. This spec addresses the structural and code quality gaps — not new features, but bringing the existing implementation up to the project's stated quality standard ("codebase excellence is non-negotiable").

- **Assumptions:**
  - The Relay architecture is sound — NATS-style subjects, Maildir+SQLite hybrid, adapter plugin system, BaseRelayAdapter pattern are all well-designed
  - The `RelayAdapter` interface and `AdapterRegistry` are stable — no interface changes needed
  - Both Telegram and Slack adapters are functionally correct — this is about code organization, not behavior changes
  - The `BaseRelayAdapter` class (added in spec 119) was the right pattern — we're extending its adoption
  - Module-level state was acceptable for single-instance adapters but is now problematic since `multiInstance: true` was enabled
  - File size limits (300 ideal, 500+ must split) are enforced project rules per `.claude/rules/file-size.md`

- **Out of scope:**
  - New adapter implementations (Discord, email, etc.)
  - Changes to the relay publish pipeline or core message flow
  - Relay Panel client-side UI changes
  - Binding system changes (BindingStore, BindingRouter logic)
  - Performance optimization of the Maildir or SQLite layers
  - Changes to the compliance test suite or adapter template

## 2) Pre-reading Log

### DRY Violations Identified

- `adapters/telegram/outbound.ts:341-356` and `adapters/slack/outbound.ts:844-859`: **Identical** `extractAgentIdFromEnvelope()` and `extractSessionIdFromEnvelope()` functions. Both extract `payload.data.agentId` and `payload.data.ccaSessionKey` from a RelayEnvelope with the same cast chain.

- `adapters/telegram/outbound.ts:60-66` and `adapters/slack/outbound.ts:42-56`: **Duplicated** `clearApprovalTimeout()` pattern — both clear a timer from a Map by key. Different stored shapes (Telegram: just timer, Slack: timer + channel + ts + client) but identical lifecycle.

- `adapters/telegram/telegram-adapter.ts:239-252` and `adapters/slack/slack-adapter.ts:336-349`: **Identical** `makeInboundCallbacks()` and `makeOutboundCallbacks()` factory methods wrapping `trackInbound`/`trackOutbound`/`recordError`.

- `adapters/telegram/inbound.ts` and `adapters/slack/inbound.ts`: Nearly identical module structure — constants (SUBJECT_PREFIX, GROUP_SEGMENT, MAX_MESSAGE_LENGTH, MAX_CONTENT_LENGTH), subject building/parsing, echo prevention, StandardPayload construction, error handling pattern.

- `adapters/webhook/webhook-adapter.ts:142-359`: WebhookAdapter manually manages its own `status` object with immutable spread patterns that `BaseRelayAdapter` already provides (trackInbound, trackOutbound, recordError, idempotent start/stop).

### File Size Violations

| File | Lines | Limit | Status |
|------|-------|-------|--------|
| `adapters/slack/outbound.ts` | 975 | 500 | **Must split** — nearly 2x hard limit |
| `apps/server/src/services/relay/adapter-manager.ts` | 590 | 500 | **Must split** |
| `sqlite-index.ts` | 466 | 300-500 | Should split |
| `maildir-store.ts` | 457 | 300-500 | Should split |
| `types.ts` | 445 | 300-500 | Should split |
| `adapters/webhook/webhook-adapter.ts` | 458 | 300-500 | Should split or shrink via BaseRelayAdapter |

### Module-Level Mutable State

Both outbound modules use module-level `Map`s for state:

**Telegram outbound (4 module-level Maps):**
- `typingIntervals: Map<number, ReturnType<typeof setInterval>>`
- `lastDraftUpdate: Map<number, number>`
- `callbackIdMap: Map<string, { toolCallId, sessionId, agentId }>`
- `pendingApprovalTimeouts: Map<string, ReturnType<typeof setTimeout>>`

**Slack outbound (1 module-level Map):**
- `pendingApprovalTimeouts: Map<string, { timer, channelId, messageTs, client }>`

Problem: `multiInstance: true` means multiple adapter instances share this global state. Approving a button on one bot's message could affect another instance. State persists across adapter stop/start cycles.

### Incomplete Implementation

- `lib/payload-utils.ts:172`: `formatForPlatform('telegram')` is a passthrough with a TODO comment. Telegram users see raw markdown markers instead of formatted text.

### Fragile API Casts

- `adapters/telegram/outbound.ts:196`: `bot.api as unknown as Record<string, ...>` for untyped `sendMessageDraft` API
- `adapters/slack/outbound.ts:285,323`: `client as unknown as Record<string, Record<string, ...>>` for untyped `chat.startStream`/`appendStream`/`stopStream` APIs

### Overcomplicated Type Aliases

- `types.ts:237-247`: `PublishResultLike` is structurally identical to `PublishResult` in `relay-publish.ts`, created to "avoid circular import" — but the dependency is unidirectional (`relay-publish.ts` imports from `types.ts`, not vice versa).

## 3) Codebase Map

**Primary Components/Modules:**

| File | Lines | Role |
|------|-------|------|
| `packages/relay/src/types.ts` | 445 | All relay types, adapter interfaces, config re-exports |
| `packages/relay/src/base-adapter.ts` | 241 | Optional abstract base class for adapters |
| `packages/relay/src/lib/payload-utils.ts` | 191 | Shared payload extraction, stream event detection, format conversion |
| `packages/relay/src/adapters/telegram/telegram-adapter.ts` | 288 | Telegram adapter facade |
| `packages/relay/src/adapters/telegram/inbound.ts` | 176 | Telegram inbound message handling |
| `packages/relay/src/adapters/telegram/outbound.ts` | 438 | Telegram outbound delivery + streaming + approvals |
| `packages/relay/src/adapters/slack/slack-adapter.ts` | 429 | Slack adapter facade |
| `packages/relay/src/adapters/slack/inbound.ts` | 308 | Slack inbound message handling + TTL cache |
| `packages/relay/src/adapters/slack/outbound.ts` | 975 | Slack outbound delivery + streaming + approvals |
| `packages/relay/src/adapters/webhook/webhook-adapter.ts` | 458 | Webhook adapter (monolithic, no BaseRelayAdapter) |
| `packages/relay/src/adapters/claude-code/claude-code-adapter.ts` | 269 | Claude Code adapter |
| `apps/server/src/services/relay/adapter-manager.ts` | 590 | Server-side adapter lifecycle + binding subsystem init |

**Dependency graph for changes:**
```
lib/payload-utils.ts          ← shared extraction, will gain envelope helpers
  ↑
base-adapter.ts               ← will gain makeInbound/OutboundCallbacks
  ↑
telegram/telegram-adapter.ts  ← delegates to inbound.ts, outbound.ts
telegram/inbound.ts           ← builds StandardPayload, publishes
telegram/outbound.ts          ← delivery, streaming, approvals
  ↑
slack/slack-adapter.ts        ← delegates to inbound.ts, outbound.ts
slack/inbound.ts              ← builds StandardPayload, publishes
slack/outbound.ts             ← delivery, streaming, approvals (MUST SPLIT)
  ↑
webhook/webhook-adapter.ts    ← will extend BaseRelayAdapter

adapter-manager.ts (server)   ← will extract binding subsystem init
```

## 4) Opportunity / Outcome

**Before:** 6 DRY violations, 2 files over hard size limit, module-level state shared across instances, incomplete Telegram formatting, fragile untyped API casts.

**After:** Shared utilities eliminate duplicated code, files comply with size rules, state is instance-scoped, Telegram users see formatted text, streaming APIs have typed wrappers.

**Value delivered:**
- **Developer safety**: Instance-scoped state prevents cross-adapter bugs when `multiInstance: true`
- **Maintainability**: Changes to approval handling, streaming, or format conversion happen in one place
- **User experience**: Telegram users get formatted markdown instead of raw markers
- **Code quality**: All files under size limits, no DRY violations, clean separation of concerns

## 5) Solution Sketch

### P0 — Must Fix (DRY + Size)

**5a. Split `slack/outbound.ts` (975 lines → 3 files)**
- `outbound.ts` (~350 lines): Main `deliverMessage` router + helpers (`wrapSlackCall`, `addTypingReaction`, `removeTypingReaction`, `streamKey`, `resolveThreadTs`)
- `stream.ts` (~350 lines): `handleTextDelta`, `handleDone`, `handleError`, `flushStreamBuffer`, `ActiveStream` type
- `approval.ts` (~250 lines): `handleApprovalRequired`, `extractAgentIdFromEnvelope`, `extractSessionIdFromEnvelope`, approval timeout management

**5b. Extract shared envelope helpers to `payload-utils.ts`**
Move `extractAgentIdFromEnvelope` and `extractSessionIdFromEnvelope` from both outbound files to `lib/payload-utils.ts`. Both adapters import from there.

**5c. Have `WebhookAdapter` extend `BaseRelayAdapter`**
Replace ~80 lines of manual status tracking with `extends BaseRelayAdapter`. Implement `_start()`, `_stop()`, and keep `deliver()` + `handleInbound()`.

**5d. Move callback factories to `BaseRelayAdapter`**
Add `protected makeInboundCallbacks()` and `protected makeOutboundCallbacks()` to `BaseRelayAdapter`. Remove duplicate methods from Telegram and Slack adapters.

### P1 — Should Fix (Quality + Correctness)

**5e. Move module-level mutable state into adapter instances**
- Telegram: Move `typingIntervals`, `lastDraftUpdate`, `callbackIdMap`, `pendingApprovalTimeouts` into `TelegramAdapter` class, pass into `deliverMessage` via options
- Slack: Move `pendingApprovalTimeouts` into `SlackAdapter` class, pass via options

**5f. Type the streaming API wrappers**
Create typed helper functions:
- `telegram/streaming.ts`: `sendMessageDraft(bot, chatId, text)` — encapsulates the `as unknown` cast
- `slack/streaming.ts`: `startStream(client, ...)`, `appendStream(client, ...)`, `stopStream(client, ...)` — encapsulates casts

**5g. Implement Telegram markdown formatting**
Close the TODO in `formatForPlatform('telegram')`. Use Telegram's MarkdownV2 format or find a lightweight converter. The Telegram adapter's `sendMessage` calls will need `parse_mode: 'MarkdownV2'`.

**5h. Split `adapter-manager.ts` (590 lines)**
Extract the binding subsystem initialization (`initBindingSubsystem`, binding store/router/session store getters) into a separate `binding-subsystem.ts` module in the same directory.

### P2 — Worth Doing (Polish)

**5i. Eliminate `PublishResultLike`**
Move `PublishResult` definition from `relay-publish.ts` to `types.ts`. Update `relay-publish.ts` to import it. Remove `PublishResultLike`.

**5j. Replace hand-rolled TTL cache in `slack/inbound.ts`**
Evaluate if a simple `Map` with periodic cleanup (already used in webhook's nonce map) is sufficient, or if `lru-cache` (already a transitive dep) would be better. The current implementation is correct but ~30 lines of reimplemented logic.

## 6) Unknowns & Risks

| Risk | Mitigation |
|------|------------|
| Telegram MarkdownV2 escaping is notoriously finicky | Research existing libraries (e.g., `telegram-format`). Use `slackify-markdown` as a model — it's already a dep. Consider a lightweight `telegramify-markdown` or inline implementation. |
| Slack native streaming API types may not exist in `@slack/web-api` yet | The typed wrapper approach isolates the cast to one file. When official types arrive, update one file instead of every call site. |
| Moving module-level state changes function signatures | State container pattern keeps the same function signatures — pass a state object via options instead of individual Maps. |
| `WebhookAdapter` extending `BaseRelayAdapter` changes its `handleInbound` pattern | `handleInbound` is a public method not on the `RelayAdapter` interface — it's called by Express routes. BaseRelayAdapter doesn't affect it. |
| Split of `slack/outbound.ts` changes import paths | All imports are internal to the slack adapter directory. The `slack/index.ts` barrel controls the public API — no external import changes. |

## 7) Open Questions

1. **Telegram markdown**: Should we use `parse_mode: 'MarkdownV2'` (requires escaping special chars) or `parse_mode: 'HTML'` (simpler escaping)? MarkdownV2 is closer to our source format but has painful escaping rules. HTML is more forgiving.

2. **TTL cache**: Is the hand-rolled cache in `slack/inbound.ts` a real problem worth fixing, or is it working fine and the ~30 lines aren't worth the dependency? It has correct eviction and TTL behavior.

3. **`PublishResultLike` removal**: Is there actually a circular import risk we're not seeing, or was it just defensive coding? Need to verify the import graph.
