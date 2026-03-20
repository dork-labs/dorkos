# Task Breakdown: Chat Adapter Tool Approval via Platform-Native Buttons

Generated: 2026-03-18
Source: specs/slack-tool-approval/02-specification.md
Last Decompose: 2026-03-18

## Overview

When agents run with `permissionMode === 'default'`, the SDK emits `approval_required` events for non-read-only tools. Currently, chat adapters (Slack, Telegram) silently drop these events, causing agents to appear frozen until the 10-minute timeout auto-denies the tool call. This feature adds platform-native interactive buttons so chat users can approve or deny tool calls without leaving their messaging platform.

The implementation spans four adapter boundaries:

- **Slack outbound** renders Block Kit cards with Approve/Deny buttons
- **Slack inbound** handles `app.action()` button clicks, publishes responses to relay
- **Telegram outbound** renders inline keyboards with Approve/Deny buttons
- **Telegram inbound** handles `callback_query:data` button clicks, publishes responses to relay
- **CCA adapter** subscribes to `relay.system.approval.>` and calls `approveTool()` to resolve pending interactions

---

## Phase 1: Foundation

### Task 1.1: Add extractApprovalData helper to payload-utils.ts

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.2, 1.3, 1.4

**Technical Requirements**:

- Add `extractApprovalData()` function to `packages/relay/src/lib/payload-utils.ts` following the pattern of `extractTextDelta()` and `extractErrorMessage()`
- Add `formatToolDescription()` helper for human-readable tool action summaries
- Export `ApprovalData` interface

**Implementation Steps**:

1. Define `ApprovalData` interface with `toolCallId`, `toolName`, `input`, `timeoutMs`
2. Implement `extractApprovalData()` with null guards for missing fields
3. Implement `formatToolDescription()` with JSON parsing for Write/Edit/Bash tools
4. Write 14 unit tests covering valid/invalid payloads, defaults, and tool descriptions

**Acceptance Criteria**:

- [ ] `extractApprovalData()` is exported from `payload-utils.ts`
- [ ] `formatToolDescription()` is exported from `payload-utils.ts`
- [ ] `ApprovalData` interface is exported
- [ ] All 14 unit tests pass
- [ ] Existing payload-utils tests continue to pass
- [ ] `pnpm typecheck` passes

---

### Task 1.2: Add approveTool to AgentRuntimeLike interface

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1, 1.3, 1.4

**Technical Requirements**:

- Extend `AgentRuntimeLike` in `packages/relay/src/adapters/claude-code/types.ts`
- Add `approveTool(sessionId, toolCallId, approved): boolean` method
- Structural typing ensures `ClaudeCodeRuntime` automatically satisfies the updated interface

**Implementation Steps**:

1. Add `approveTool` method signature with TSDoc to `AgentRuntimeLike`
2. Run `pnpm typecheck` to verify structural compatibility with existing `ClaudeCodeRuntime`

**Acceptance Criteria**:

- [ ] `approveTool` is a required method on `AgentRuntimeLike`
- [ ] TSDoc comment explains purpose and parameters
- [ ] `pnpm typecheck` passes (no server-side changes needed)

---

### Task 1.3: Extend RelayPublisher with subscribe method

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1, 1.2, 1.4

**Technical Requirements**:

- Add `subscribe(pattern, handler): Unsubscribe` to `RelayPublisher` interface in `packages/relay/src/types.ts`
- `RelayCore` already implements `subscribe()` -- this just surfaces it through the interface
- Update all mock `RelayPublisher` instances in tests to include `subscribe` stub

**Implementation Steps**:

1. Add `subscribe` method signature to `RelayPublisher` interface
2. Search for and update all mock `RelayPublisher` objects in test files
3. Run `pnpm test -- --run` to verify no regressions

**Acceptance Criteria**:

- [ ] `subscribe` is a required method on `RelayPublisher`
- [ ] `RelayCore` compiles without changes
- [ ] All test mocks updated with `subscribe: vi.fn().mockReturnValue(() => {})`
- [ ] `pnpm typecheck` and `pnpm test -- --run` pass

---

### Task 1.4: Enrich approval_required events with agentId and ccaSessionKey

**Size**: Medium
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1, 1.2, 1.3

**Technical Requirements**:

- Modify `publishResponseWithCorrelation()` in `packages/relay/src/adapters/claude-code/publish.ts`
- Add optional `enrichment` parameter for injecting `agentId` into `approval_required` events
- Update `handleAgentMessage()` in `agent-handler.ts` to pass `{ agentId }` enrichment

**Implementation Steps**:

1. Add `enrichment?: { agentId?: string }` parameter to `publishResponseWithCorrelation()`
2. Detect `approval_required` events and enrich `data` with `agentId` and `ccaSessionKey`
3. Update call site in `agent-handler.ts` (line 148) to pass enrichment
4. Check and update any call site in `pulse-handler.ts`
5. Write unit tests for enrichment behavior

**Acceptance Criteria**:

- [ ] `approval_required` events carry `data.agentId` and `data.ccaSessionKey`
- [ ] Non-approval events are unaffected
- [ ] `correlationId` is still applied to enriched events
- [ ] All existing tests continue to pass

---

## Phase 2: Slack Adapter

### Task 2.1: Render Block Kit approval card in Slack outbound

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1, Task 1.4
**Can run parallel with**: Task 2.2

**Technical Requirements**:

- Insert `approval_required` branch in `deliverMessage()` (after `done` handler, before whitelist drop)
- Render Block Kit message with section blocks and action buttons
- Button `value` encodes only IDs (toolCallId, sessionId, agentId) -- never sensitive input
- Tool input preview truncated to 500 chars

**Implementation Steps**:

1. Import `extractApprovalData` and `formatToolDescription` from payload-utils
2. Add `extractAgentIdFromEnvelope()` and `extractSessionIdFromEnvelope()` helpers
3. Implement `handleApprovalRequired()` with Block Kit structure
4. Insert branch in `deliverMessage()` at the correct position
5. Write unit tests for rendering, truncation, and fallthrough

**Acceptance Criteria**:

- [ ] `approval_required` events render as Block Kit cards with Approve/Deny buttons
- [ ] Button values contain only IDs
- [ ] Tool input truncated to 500 chars
- [ ] Invalid data falls through to whitelist drop
- [ ] Existing outbound tests pass unchanged

---

### Task 2.2: Register Slack action handlers for approval buttons

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1, Task 1.3
**Can run parallel with**: Task 2.1

**Technical Requirements**:

- Register `app.action('tool_approve')` and `app.action('tool_deny')` in `SlackAdapter._start()`
- Handler publishes `ApprovalResponse` to `relay.system.approval.{agentId}`
- Handler updates original message via `chat.update()` to show decision result
- `ack()` called immediately to satisfy Slack's 3-second requirement

**Implementation Steps**:

1. Define `ApprovalResponse` interface
2. Register action handlers in `_start()` after existing event listeners
3. Implement `handleApprovalAction()` with relay publish and message update
4. Implement `extractToolNameFromBlocks()` helper
5. Write unit tests for approve, deny, malformed values

**Acceptance Criteria**:

- [ ] Action handlers registered in `_start()`
- [ ] Button click publishes correct `ApprovalResponse` to relay
- [ ] Original message updated with "Approved" or "Denied" text
- [ ] Malformed button values handled gracefully

---

## Phase 3: Telegram Adapter

### Task 3.1: Render inline keyboard approval card in Telegram outbound

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1, Task 1.4
**Can run parallel with**: Task 3.2

**Technical Requirements**:

- Insert `approval_required` branch in Telegram `deliverMessage()` before whitelist drop
- Use `callbackIdMap` (in-memory Map) to work around Telegram's 64-byte `callback_data` limit
- Short random key (12 chars) maps to full IDs in memory with 15-minute TTL
- Inline keyboard with Approve/Deny buttons

**Implementation Steps**:

1. Add `callbackIdMap` module-level Map (exported for inbound handler access)
2. Import `extractApprovalData` and `formatToolDescription` from payload-utils
3. Implement `handleApprovalRequired()` with inline keyboard
4. Insert branch in `deliverMessage()`
5. Write unit tests for rendering, callback_data size, TTL eviction

**Acceptance Criteria**:

- [ ] `approval_required` events render as inline keyboard messages
- [ ] `callbackIdMap` stores full IDs, callback_data under 64 bytes
- [ ] Stale entries evicted after 15 minutes
- [ ] Existing Telegram outbound tests pass unchanged

---

### Task 3.2: Register Telegram callback query handler for approval buttons

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1, Task 1.3, Task 3.1
**Can run parallel with**: None

**Technical Requirements**:

- Register `bot.on('callback_query:data')` in `TelegramAdapter._start()`
- Look up full IDs from `callbackIdMap`, delete entry after use (prevent double-click)
- Publish `ApprovalResponse` to relay, edit message to show result, answer callback query
- Handle expired keys and malformed data gracefully

**Implementation Steps**:

1. Import `callbackIdMap` from outbound module
2. Register callback handler in `_start()`
3. Implement `handleApprovalCallback()` with ID lookup, relay publish, message edit
4. Implement `extractToolNameFromMessage()` helper
5. Write unit tests for approve, deny, expired, malformed, double-click prevention

**Acceptance Criteria**:

- [ ] Callback handler registered in `_start()`
- [ ] Approve/Deny clicks publish correct `ApprovalResponse`
- [ ] Callback key deleted after use
- [ ] Expired keys show "Approval expired" answer
- [ ] Message edited to show result

---

## Phase 4: CCA Adapter Wiring

### Task 4.1: Create approval-handler.ts for CCA adapter subscription

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.2, Task 1.3
**Can run parallel with**: Task 4.2

**Technical Requirements**:

- New file `packages/relay/src/adapters/claude-code/approval-handler.ts`
- Subscribe to `relay.system.approval.>` using `relay.subscribe()`
- Route valid `ApprovalResponse` payloads to `agentManager.approveTool()`
- Handle missing interactions (returns false) with warning log, not throw

**Implementation Steps**:

1. Define `APPROVAL_SUBJECT_PATTERN` constant
2. Define `ApprovalPayload` interface
3. Implement `subscribeToApprovals()` returning unsubscribe function
4. Implement `handleApprovalResponse()` with payload validation
5. Write 6 unit tests

**Acceptance Criteria**:

- [ ] Exports `subscribeToApprovals()` and `APPROVAL_SUBJECT_PATTERN`
- [ ] Valid payloads call `approveTool()` with correct params
- [ ] Missing interactions log warning but don't throw
- [ ] Malformed payloads rejected with warning
- [ ] Returns unsubscribe function

---

### Task 4.2: Wire approval subscription in ClaudeCodeAdapter start/stop

**Size**: Small
**Priority**: High
**Dependencies**: Task 4.1
**Can run parallel with**: None

**Technical Requirements**:

- Add `approvalUnsubscribe` private field to `ClaudeCodeAdapter`
- Call `subscribeToApprovals()` in `start()`
- Call unsubscribe in `stop()` before clearing relay reference
- Re-export `APPROVAL_SUBJECT_PATTERN` from index.ts

**Implementation Steps**:

1. Import `subscribeToApprovals` and `Unsubscribe` type
2. Add private field, update `start()` and `stop()`
3. Add re-export to index.ts
4. Write lifecycle tests

**Acceptance Criteria**:

- [ ] Subscription created in `start()`, cleaned up in `stop()`
- [ ] Existing CCA adapter tests continue to pass
- [ ] `pnpm typecheck` passes

---

## Phase 5: Timeout UX

### Task 5.1: Add timeout handling for Slack approval messages

**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 2.1, Task 2.2
**Can run parallel with**: Task 5.2

**Technical Requirements**:

- Register `setTimeout` matching `timeoutMs` from `approval_required` payload when sending Block Kit card
- On timeout fire, update message to "Timed out -- `ToolName` (auto-denied after 10 min)"
- Export `cancelApprovalTimeout()` for action handler to call on button click
- Track pending timeouts in module-level Map keyed by `toolCallId`

**Implementation Steps**:

1. Add `pendingApprovalTimeouts` Map to outbound module
2. Register timeout after successful `postMessage`
3. Export `cancelApprovalTimeout()` function
4. Import and call from action handler in `slack-adapter.ts`
5. Write tests with `vi.useFakeTimers()`

**Acceptance Criteria**:

- [ ] Message updated to "Timed out" after `timeoutMs`
- [ ] Button click cancels pending timeout
- [ ] Map entries cleaned up after fire or cancellation

---

### Task 5.2: Add timeout handling for Telegram approval messages

**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 3.1, Task 3.2
**Can run parallel with**: Task 5.1

**Technical Requirements**:

- Register `setTimeout` when sending inline keyboard message
- On timeout, edit message text to "Timed out" and remove keyboard
- Export `cancelApprovalTimeout()` for callback handler
- Track pending timeouts in module-level Map keyed by `toolCallId`

**Implementation Steps**:

1. Add `pendingApprovalTimeouts` Map to Telegram outbound module
2. Capture `sentMessage.message_id` for later editing
3. Export `cancelApprovalTimeout()` function
4. Import and call from callback handler in `telegram-adapter.ts`
5. Write tests with `vi.useFakeTimers()`

**Acceptance Criteria**:

- [ ] Message edited to "Timed out" after `timeoutMs`
- [ ] Button click cancels pending timeout
- [ ] Map entries cleaned up

---

## Phase 6: Integration & Documentation

### Task 6.1: Add integration test for full approval round-trip

**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 4.1, Task 4.2
**Can run parallel with**: Task 6.2

**Technical Requirements**:

- Create `packages/relay/src/adapters/__tests__/approval-integration.test.ts`
- Use real `RelayCore` instance (not mocked relay)
- Test publish/subscribe round-trip for both approval and denial

**Implementation Steps**:

1. Create `RelayCore` with temp data directory
2. Subscribe to `relay.system.approval.>` and wire to mock `approveTool()`
3. Publish `ApprovalResponse` to `relay.system.approval.agent-1`
4. Verify subscription fires and `approveTool()` called with correct params
5. Test both approve (true) and deny (false) paths

**Acceptance Criteria**:

- [ ] Full relay round-trip tested with real `RelayCore`
- [ ] Both approval and denial paths verified
- [ ] Tests pass independently

---

### Task 6.2: Update relay-adapters.md with approval event handling pattern

**Size**: Small
**Priority**: Low
**Dependencies**: Task 4.2
**Can run parallel with**: Task 6.1

**Technical Requirements**:

- Document `approval_required` event handling in `contributing/relay-adapters.md`
- Document `relay.system.approval.{agentId}` subject namespace
- Add `approval_required` to list of handled event types

**Implementation Steps**:

1. Read current content of `contributing/relay-adapters.md`
2. Add "Tool Approval Events" section explaining the flow
3. Add subject namespace documentation
4. Update event type listing

**Acceptance Criteria**:

- [ ] Approval flow documented in relay-adapters.md
- [ ] Subject namespace documented
- [ ] Event type listed
