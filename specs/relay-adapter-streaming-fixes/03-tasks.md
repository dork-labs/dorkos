# Relay Adapter Streaming Fixes -- Task Breakdown

**Spec:** `specs/relay-adapter-streaming-fixes/02-specification.md`
**Generated:** 2026-03-14

---

## Phase 1: Bug Fixes

Three independent bug fixes that can be implemented in parallel.

### Task 1.1 -- Fix CWD propagation in BindingRouter envelope enrichment

**Size:** Medium | **Priority:** High | **Dependencies:** None | **Parallel with:** 1.2, 1.3

**File:** `apps/server/src/services/relay/binding-router.ts`

BindingRouter.handleInbound() republishes to `relay.agent.{sessionId}` with the original payload but never injects `cwd: binding.projectPath`. The agent handler's CWD resolution chain receives neither value, so the agent operates in the server's default directory.

**Fix:** Before the `relayCore.publish()` call, enrich the payload with `cwd: binding.projectPath`. Object payloads get `cwd` added via spread; primitive payloads are wrapped in `{ content, cwd }`.

**Tests:** Add `describe('CWD propagation')` block to `binding-router.test.ts` verifying enrichment for both object and primitive payloads. Update existing tests that assert on published payload shape.

---

### Task 1.2 -- Fix stream key collision in Slack outbound

**Size:** Large | **Priority:** High | **Dependencies:** None | **Parallel with:** 1.1, 1.3

**Files:** `packages/relay/src/adapters/slack/outbound.ts`

Three-part fix:

- **3a:** Harden `resolveThreadTs` with emptiness guards (`&& pd.threadTs`, `&& pd.ts`)
- **3b:** Add synthetic fallback `effectiveThreadTs = threadTs ?? envelope.id` for programmatic messages without `platformData`
- **3c:** Add `streamId: string` (via `randomUUID()`) to `ActiveStream` interface for race detection

**Tests:** Add `describe('streaming -- stream key isolation')` block verifying separate stream keys for concurrent responses, envelope.id fallback, and empty-string guards.

---

### Task 1.3 -- Fix intermediate newline collapsing in Slack streaming

**Size:** Small | **Priority:** Medium | **Dependencies:** None | **Parallel with:** 1.1, 1.2

**File:** `packages/relay/src/adapters/slack/outbound.ts`

`slackify-markdown` inserts `\n\n` paragraph separators during intermediate updates. Fix: after `formatForPlatform()` in `handleTextDelta`, collapse consecutive newlines via `formatted.replace(/\n{2,}/g, '\n')` for intermediate updates only. The final `handleDone` update preserves full paragraph formatting.

**Tests:** Add `describe('streaming -- intermediate newline collapsing')` block verifying collapsed newlines in intermediate updates and preserved paragraphs in final done update.

---

## Phase 2: Telegram Typing Refresh

### Task 2.1 -- Add interval refresh for Telegram typing indicator

**Size:** Medium | **Priority:** Medium | **Dependencies:** None

**Files:** `packages/relay/src/adapters/telegram/outbound.ts`, `packages/relay/src/adapters/telegram/telegram-adapter.ts`

Telegram's typing indicator expires after 5 seconds. Replace the single `sendChatAction` call with an interval-based refresh every 4 seconds. Add `clearTypingInterval(chatId)` helper and `clearAllTypingIntervals()` export called in `TelegramAdapter._stop()`.

**Tests:** Create `packages/relay/src/adapters/telegram/__tests__/outbound.test.ts` with fake timers testing immediate call, interval refresh, cleanup on stop, and error-based interval clearing.

---

## Phase 3: Streaming Toggle

### Task 3.1 -- Add streaming boolean to SlackAdapterConfig schema

**Size:** Small | **Priority:** Medium | **Dependencies:** None | **Parallel with:** 3.2

**File:** `packages/shared/src/relay-adapter-schemas.ts`

Add `streaming: z.boolean().default(true)` to `SlackAdapterConfigSchema`. Backward compatible -- existing configs default to streaming enabled.

---

### Task 3.2 -- Add streaming configField to Slack adapter manifest

**Size:** Small | **Priority:** Medium | **Dependencies:** None | **Parallel with:** 3.1

**File:** `packages/relay/src/adapters/slack/slack-adapter.ts`

Add a `streaming` configField of type `boolean` to `SLACK_MANIFEST.configFields` with description and helpMarkdown explaining both modes.

---

### Task 3.3 -- Implement buffered mode logic in Slack outbound delivery

**Size:** Large | **Priority:** Medium | **Dependencies:** 1.2, 3.1, 3.2

**Files:** `packages/relay/src/adapters/slack/outbound.ts`, `packages/relay/src/adapters/slack/slack-adapter.ts`

Thread `streaming` config through `SlackDeliverOptions`. When `streaming === false`:

- `text_delta`: Accumulate text in `streamState` with `messageTs: ''` (no Slack API calls)
- `done`: Send accumulated text via `chat.postMessage` (detect buffered mode by empty `messageTs`)
- `error`: Send accumulated text + error suffix via `chat.postMessage`

**Tests:** Add `describe('streaming toggle -- buffered mode')` block verifying silent accumulation, single-message flush on done, error handling in buffered mode, and default streaming behavior preservation.

---

## Phase 4: Slack Typing Indicator

### Task 4.1 -- Add typingIndicator config and emoji reaction typing for Slack

**Size:** Large | **Priority:** Low | **Dependencies:** 3.3

**Files:** `packages/shared/src/relay-adapter-schemas.ts`, `packages/relay/src/adapters/slack/slack-adapter.ts`, `packages/relay/src/adapters/slack/outbound.ts`

Full implementation:

1. Add `typingIndicator: z.enum(['none', 'reaction']).default('none')` to schema
2. Add `reactions:write` to `SLACK_APP_MANIFEST_YAML` bot scopes
3. Add `typingIndicator` configField to manifest
4. Thread through `SlackDeliverOptions`
5. Add `:hourglass_flowing_sand:` reaction on stream start (fire-and-forget)
6. Remove reaction on done/error (fire-and-forget)
7. Only add reactions when a real `threadTs` exists (not synthetic envelope ID fallbacks)

**Tests:** Add `describe('typing indicator -- emoji reaction')` block with mock `reactions.add/remove` methods, verifying add on start, remove on done/error, no-op for `typingIndicator: 'none'`, silent error swallowing, and no reaction without real threadTs.

---

## Dependency Graph

```
Phase 1 (parallel):
  1.1  CWD propagation ─────────────────────────────┐
  1.2  Stream key collision ─────────────────────────┤
  1.3  Newline collapsing ───────────────────────────┘
                                                      │
Phase 2 (independent):                                │
  2.1  Telegram typing refresh                        │
                                                      │
Phase 3:                                              │
  3.1  Schema: streaming field ──────┐                │
  3.2  Manifest: streaming field ────┤                │
                                     ▼                │
  3.3  Buffered mode logic ◄─────── 1.2 ◄────────────┘
                                     │
Phase 4:                             │
  4.1  Typing indicator ◄────────── 3.3
```

**Total tasks:** 8
**Estimated effort:** 3 small, 3 medium (task 2.1 relocated), 3 large = ~2-3 days
