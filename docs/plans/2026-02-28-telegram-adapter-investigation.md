# Telegram Adapter Investigation

**Date:** 2026-02-28
**Status:** Investigation complete, routing layer needed

## Issues Found & Fixed

### 1. "Aborted delay" error on test connection (FIXED)

**Root cause:** `testConnection()` called `adapter.start()` which fired off grammY's long-polling loop (`bot.start()`) in the background. When `stop()` was called in the `finally` block, it aborted grammY's internal retry sleep.

**Fix:** Added `testConnection()` method to `RelayAdapter` interface (optional) and implemented it in `TelegramAdapter`. It calls `bot.init()` (which hits Telegram's `getMe` API) to validate the token without starting the polling loop. `AdapterManager.testConnection()` now prefers this lightweight path when available.

**Files changed:**
- `packages/relay/src/types.ts` — added optional `testConnection?()` to `RelayAdapter`
- `packages/relay/src/adapters/telegram-adapter.ts` — implemented `testConnection()`
- `apps/server/src/services/relay/adapter-manager.ts` — prefer `adapter.testConnection()` over `start()`/`stop()`
- Tests updated in both packages

### 2. 409 Conflict: "terminated by other getUpdates request" (FIXED)

**Root cause:** Same as above. The test connection started a polling session with Telegram. Even after `bot.stop()`, Telegram briefly kept the polling session alive. When the real adapter started moments later with the same token, Telegram rejected it with 409.

**Fix:** Same as above — `testConnection()` never starts polling, so no lingering session.

### 3. Echo loop — bot repeats user messages back (FIXED)

**Root cause:** `RelayCore.publish()` unconditionally fans out to adapter delivery (line 330-335 in `relay-core.ts`). When TelegramAdapter publishes an inbound message to `relay.human.telegram.{chatId}`, the adapter registry matches it back to TelegramAdapter (same subject prefix), which calls `deliver()` and sends the message right back to the user.

**Fix:** Added an echo guard at the top of `deliver()`: if `envelope.from` starts with the adapter's own subject prefix (`relay.human.telegram`), skip delivery silently. Messages from agents (`from: 'relay.agent.*'`) pass through normally.

**Files changed:**
- `packages/relay/src/adapters/telegram-adapter.ts` — echo guard in `deliver()`
- Tests added for echo prevention

### 4. `startPollingMode` swallowed background errors (FIXED)

**Root cause:** `void bot.start()` discarded the promise, so errors from the background polling loop became unhandled rejections.

**Fix:** Changed to `bot.start().catch((err) => this.recordError(err))` so background polling errors surface in `getStatus()`.

## Remaining Gap: Messages Don't Reach Agents

### Current flow (broken end-to-end)

```
Telegram user sends message
  -> TelegramAdapter.handleInboundMessage()
  -> relay.publish('relay.human.telegram.{chatId}', payload)
  -> RelayCore.publish():
       1. findMatchingEndpoints() -> [] (no Maildir endpoints registered)
       2. BUG #70: early-return + dead-letter when no endpoints match
       3. adapter delivery is UNREACHABLE
  -> Message silently dead-lettered
  -> No agent ever sees it
```

### Two gaps remain

**Gap 1: Bug #70 (publish pipeline early return)**
- Spec exists: `specs/relay-publish-pipeline-fix/`
- When no Maildir endpoints match, `publish()` dead-letters immediately and skips adapter delivery
- Fix: remove early return, always attempt adapter delivery, dead-letter only when nothing delivered

**Gap 2: No routing from `relay.human.telegram.*` to agents**
- ClaudeCodeAdapter only claims `relay.agent.*` and `relay.system.pulse.*`
- Even after Bug #70 is fixed, no adapter matches `relay.human.telegram.*` (except TelegramAdapter itself, which we now guard against echoing)
- Need a mechanism to route inbound Telegram messages to Claude Code agent sessions

### Desired end-to-end flow

```
Telegram user sends message
  -> TelegramAdapter publishes to relay.human.telegram.{chatId}
  -> [ROUTING LAYER] maps chatId to an agent session
  -> Publishes to relay.agent.{sessionId} with replyTo: relay.human.telegram.{chatId}
  -> ClaudeCodeAdapter receives it, sends to agent
  -> Agent responds, response published to relay.human.telegram.{chatId}
  -> TelegramAdapter.deliver() sends response back to Telegram
```

### Routing layer design options

| Option | Description | Complexity | Notes |
|--------|-------------|------------|-------|
| **A. Default agent routing** | All Telegram messages go to a single configured agent session | Low | Good MVP. Config: `defaultAgentSession` in adapter config |
| **B. Chat-to-agent mapping** | Persist `chatId -> sessionId` mapping, create sessions on first message | Medium | Better UX. Needs storage + API |
| **C. Routing adapter** | New adapter claiming `relay.human.>` that does intelligent routing | Medium-High | Most flexible, but more code |
| **D. ClaudeCodeAdapter claims telegram subjects** | Extend ClaudeCodeAdapter to also handle `relay.human.telegram.*` | Low-Medium | Quick but couples adapters |

### Recommended approach

**Option B** with a simple implementation:
1. TelegramAdapter maintains a `Map<chatId, sessionId>` (persisted to disk)
2. On first message from a new chatId, create a new agent session and store the mapping
3. Re-publish the message to `relay.agent.{sessionId}` with `replyTo: relay.human.telegram.{chatId}`
4. Agent responses flow back through Relay to `relay.human.telegram.{chatId}` -> TelegramAdapter delivers to Telegram

This keeps the routing logic inside TelegramAdapter (no new components), leverages existing ClaudeCodeAdapter for agent dispatch, and creates per-chat conversations naturally.

## Files Reference

| File | Role |
|------|------|
| `packages/relay/src/adapters/telegram-adapter.ts` | Telegram adapter (start, stop, deliver, echo guard) |
| `packages/relay/src/types.ts` | `RelayAdapter` interface with optional `testConnection()` |
| `packages/relay/src/relay-core.ts` | Publish pipeline (Bug #70 lives here) |
| `packages/relay/src/adapter-registry.ts` | Routes messages to adapters by subject prefix |
| `packages/relay/src/adapters/claude-code-adapter.ts` | Handles `relay.agent.*` messages |
| `apps/server/src/services/relay/adapter-manager.ts` | Adapter lifecycle, testConnection, addAdapter |
| `specs/relay-publish-pipeline-fix/` | Spec #70 for the early-return bug |
| `specs/relay-external-adapters/` | Original spec for Telegram/external adapters |
