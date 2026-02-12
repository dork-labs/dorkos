# Gateway Interactive Tool UI Architecture

**Status:** Draft
**Authors:** Claude Code
**Date:** 2026-02-08
**Spec Slug:** gateway-interactive-tool-ui
**Branch:** preflight/obsidian-copilot-plugin

---

## 1. Overview

Implement an extensible architecture for handling SDK tools that require user interaction in the Gateway UI. The system uses the Agent SDK's `canUseTool` callback to intercept tool execution, pause the SDK, emit events to the client, collect user input, and resume execution. Two interactive tools are implemented: **AskUserQuestion** (structured multi-question prompts with options) and **general tool approval** (approve/deny for tools when `permissionMode` is `'default'`). A developer guide documents the pattern for adding future interactive tools.

## 2. Background / Problem Statement

The Gateway currently streams SDK events to the client but has no mechanism to **pause** the SDK mid-execution and collect user input before continuing. The existing `pendingApproval` field on `AgentSession` and `approveTool`/`denyTool` on the Transport interface exist as stubs but are never triggered because no `canUseTool` callback is registered with the SDK.

The SDK's `AskUserQuestion` tool needs to present structured questions to the user and receive answers before the tool can execute. Without this, the SDK cannot use `AskUserQuestion` at all in the Gateway context. Similarly, tool approval (the SDK asking permission before running a tool) is non-functional.

## 3. Goals

- Register a `canUseTool` callback in the SDK integration that intercepts tool execution
- Implement `AskUserQuestion` rendering with radio/checkbox options, "Other" free-text, and compact post-submission state
- Implement general tool approval (approve/deny) through the same `canUseTool` mechanism, replacing the existing stub
- Design the pattern to be extensible so future interactive tools (e.g., `EnterPlanMode`, file upload, confirmations) require minimal changes to core infrastructure
- Support both `HttpTransport` (standalone web) and `DirectTransport` (Obsidian plugin) identically
- Create a developer guide at `guides/interactive-tools.md`

## 4. Non-Goals

- Implementing all future interactive tools (only AskUserQuestion and tool approval now)
- Multi-user session management or persistence beyond in-memory Maps
- SSE reconnection/replay (not needed for single-user local gateway)
- Changing how the SSE wire protocol works (it's already generic enough)
- Merging the QuestionPrompt and ToolApproval components (they serve different purposes)

## 5. Technical Dependencies

| Dependency | Version | Purpose |
|------------|---------|---------|
| `@anthropic-ai/claude-agent-sdk` | latest | `canUseTool` callback, `PermissionResult` type, `AskUserQuestionInput` type |
| `react` | ^19.0.0 | UI components |
| `lucide-react` | latest | Icons for the QuestionPrompt component |
| `motion` | ^12.33.0 | Animations for component transitions |
| `tailwindcss` | ^4.0.0 | Styling |

No new dependencies are required.

## 6. Detailed Design

### 6.1 Core Pattern: Deferred Promise + Event Queue

The architecture centers on two mechanisms working together:

1. **Deferred Promise**: The `canUseTool` callback creates a Promise that blocks SDK execution until user input resolves it.
2. **Event Queue**: Since `canUseTool` runs inside the SDK's execution context (not within our `sendMessage()` generator), we use a shared queue to pass StreamEvents from the callback to the generator.

```
┌─────────────────────────────────────────────────────────────┐
│ AgentManager.sendMessage() AsyncGenerator                    │
│                                                              │
│  ┌──────────┐     ┌──────────────┐     ┌──────────────┐    │
│  │ SDK      │────>│ mapSdkMessage│────>│ yield event  │    │
│  │ query()  │     │ ()           │     │ to consumer  │    │
│  └──────────┘     └──────────────┘     └──────────────┘    │
│       │                                       ▲             │
│       │ canUseTool()                          │             │
│       ▼                                       │             │
│  ┌──────────────┐   push    ┌──────────────┐ │ drain       │
│  │ canUseTool   │──────────>│ eventQueue[] │─┘             │
│  │ callback     │           └──────────────┘               │
│  │              │                                           │
│  │ await promise│<── resolve ── submitAnswers()             │
│  │              │<── resolve ── approveTool()               │
│  │              │<── reject  ── timeout (10 min)            │
│  └──────────────┘                                           │
└─────────────────────────────────────────────────────────────┘
```

### 6.2 AgentSession Changes

Replace the existing `pendingApproval` field with a generic `pendingInteractions` Map:

```typescript
interface PendingInteraction {
  type: 'question' | 'approval';
  toolCallId: string;
  resolve: (result: unknown) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface AgentSession {
  sdkSessionId: string;
  lastActivity: number;
  permissionMode: PermissionMode;
  model?: string;
  hasStarted: boolean;
  // Replace pendingApproval with:
  pendingInteractions: Map<string, PendingInteraction>;
  // Event queue for canUseTool-emitted events:
  eventQueue: StreamEvent[];
  eventQueueNotify?: () => void;  // resolve fn to wake generator
}
```

### 6.3 canUseTool Callback Implementation

The callback is registered in `sendMessage()` as part of `sdkOptions`:

```typescript
sdkOptions.canUseTool = async (
  toolName: string,
  input: Record<string, unknown>,
  context: {
    signal?: AbortSignal;
    toolUseID: string;
    decisionReason?: string;
    suggestions?: string[];
  }
) => {
  // 1. AskUserQuestion: pause, collect answers, inject into input
  if (toolName === 'AskUserQuestion') {
    return handleAskUserQuestion(session, context.toolUseID, input);
  }

  // 2. Tool approval: pause when permissionMode is 'default'
  if (session.permissionMode === 'default') {
    return handleToolApproval(session, context.toolUseID, toolName, input, context);
  }

  // 3. All other cases: allow immediately
  return { behavior: 'allow' as const };
};
```

#### handleAskUserQuestion

```typescript
async function handleAskUserQuestion(
  session: AgentSession,
  toolUseId: string,
  input: Record<string, unknown>
): Promise<PermissionResult> {
  // Emit question_prompt event to the queue
  session.eventQueue.push({
    type: 'question_prompt',
    data: {
      toolCallId: toolUseId,
      questions: input.questions,
    },
  });
  session.eventQueueNotify?.();

  // Create deferred promise
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      session.pendingInteractions.delete(toolUseId);
      resolve({ behavior: 'deny', message: 'User did not respond within 10 minutes' });
    }, 10 * 60 * 1000);

    session.pendingInteractions.set(toolUseId, {
      type: 'question',
      toolCallId: toolUseId,
      resolve: (answers) => {
        clearTimeout(timeout);
        session.pendingInteractions.delete(toolUseId);
        resolve({
          behavior: 'allow',
          updatedInput: { ...input, answers },
        });
      },
      reject: (reason) => {
        clearTimeout(timeout);
        session.pendingInteractions.delete(toolUseId);
        reject(reason);
      },
      timeout,
    });
  });
}
```

#### handleToolApproval

```typescript
async function handleToolApproval(
  session: AgentSession,
  toolUseId: string,
  toolName: string,
  input: Record<string, unknown>,
  context: { decisionReason?: string; suggestions?: string[] }
): Promise<PermissionResult> {
  // Emit approval_required event
  session.eventQueue.push({
    type: 'approval_required',
    data: {
      toolCallId: toolUseId,
      toolName,
      input: JSON.stringify(input),
    },
  });
  session.eventQueueNotify?.();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      session.pendingInteractions.delete(toolUseId);
      resolve({ behavior: 'deny', message: 'Tool approval timed out after 10 minutes' });
    }, 10 * 60 * 1000);

    session.pendingInteractions.set(toolUseId, {
      type: 'approval',
      toolCallId: toolUseId,
      resolve: (approved) => {
        clearTimeout(timeout);
        session.pendingInteractions.delete(toolUseId);
        resolve(approved
          ? { behavior: 'allow' }
          : { behavior: 'deny', message: 'User denied tool execution' }
        );
      },
      reject: (reason) => {
        clearTimeout(timeout);
        session.pendingInteractions.delete(toolUseId);
        reject(reason);
      },
      timeout,
    });
  });
}
```

### 6.4 Event Queue Draining in sendMessage()

The `sendMessage()` generator must drain the event queue between SDK messages. This is the key integration point:

```typescript
async *sendMessage(sessionId, content, opts?) {
  const session = this.sessions.get(sessionId)!;
  session.eventQueue = [];

  // ... setup sdkOptions with canUseTool ...

  const agentQuery = query({ prompt: content, options: sdkOptions });

  for await (const message of agentQuery) {
    // FIRST: drain any events pushed by canUseTool callbacks
    while (session.eventQueue.length > 0) {
      yield session.eventQueue.shift()!;
    }

    // THEN: process the SDK message normally
    for await (const event of this.mapSdkMessage(message, session, sessionId, toolState)) {
      yield event;
    }
  }

  // Final drain after query completes
  while (session.eventQueue.length > 0) {
    yield session.eventQueue.shift()!;
  }
}
```

**Important timing note**: The `canUseTool` callback is called by the SDK *before* it yields the corresponding `stream_event` message. This means the event queue will have the `question_prompt` or `approval_required` event ready to drain on the next iteration of the `for await` loop. The callback blocks (via the deferred promise) until the user responds, so the SDK won't yield further messages until the interaction is resolved.

However, there's a subtlety: the `for await (const message of agentQuery)` loop only advances when the SDK yields a message. If `canUseTool` is blocking, the SDK won't yield, so we need `eventQueueNotify` to wake the generator. The solution is to use a secondary polling mechanism or restructure the loop to also await the queue. A practical approach:

```typescript
async *sendMessage(sessionId, content, opts?) {
  const session = this.sessions.get(sessionId)!;
  session.eventQueue = [];

  // Create an async iterator that merges SDK messages and queued events
  const sdkIterator = agentQuery[Symbol.asyncIterator]();

  while (true) {
    // Drain queue first
    while (session.eventQueue.length > 0) {
      yield session.eventQueue.shift()!;
    }

    // If queue might get new items while SDK is blocked in canUseTool,
    // we need to race between "SDK yields next message" and "queue gets new item"
    const queuePromise = session.eventQueue.length === 0
      ? new Promise<'queue'>(resolve => { session.eventQueueNotify = () => resolve('queue'); })
      : Promise.resolve('queue' as const);

    const sdkPromise = sdkIterator.next().then(result => ({ sdk: true, result }));

    // Race: either SDK yields or queue gets a new event
    const winner = await Promise.race([queuePromise, sdkPromise]);

    if (winner === 'queue') {
      // Queue got new items, drain them and continue
      continue;
    }

    // SDK yielded a message
    const { result } = winner as { sdk: true; result: IteratorResult<SDKMessage> };
    if (result.done) break;

    for await (const event of this.mapSdkMessage(result.value, session, sessionId, toolState)) {
      yield event;
    }
  }
}
```

### 6.5 submitAnswers Method

New method on `AgentManager`:

```typescript
submitAnswers(
  sessionId: string,
  toolCallId: string,
  answers: Record<string, string>
): boolean {
  const session = this.sessions.get(sessionId);
  const pending = session?.pendingInteractions.get(toolCallId);
  if (!pending || pending.type !== 'question') return false;
  pending.resolve(answers);
  return true;
}
```

Update `approveTool` to use the new `pendingInteractions` Map:

```typescript
approveTool(sessionId: string, toolCallId: string, approved: boolean): boolean {
  const session = this.sessions.get(sessionId);
  const pending = session?.pendingInteractions.get(toolCallId);
  if (!pending || pending.type !== 'approval') return false;
  pending.resolve(approved);
  return true;
}
```

### 6.6 StreamEvent Type Changes

Add to `src/shared/types.ts`:

```typescript
export type StreamEventType =
  | 'text_delta'
  | 'tool_call_start'
  | 'tool_call_delta'
  | 'tool_call_end'
  | 'tool_result'
  | 'approval_required'
  | 'question_prompt'     // NEW
  | 'error'
  | 'done'
  | 'session_status';

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionItem {
  header: string;       // Max 12 chars, displayed as chip/tag
  question: string;     // Full question text
  options: QuestionOption[];  // 2-4 predefined options
  multiSelect: boolean;
}

export interface QuestionPromptEvent {
  toolCallId: string;
  questions: QuestionItem[];
}

// Update StreamEvent.data union to include QuestionPromptEvent
export interface StreamEvent {
  type: StreamEventType;
  data: TextDelta | ToolCallEvent | ApprovalEvent | QuestionPromptEvent | ErrorEvent | DoneEvent | SessionStatusEvent;
}
```

### 6.7 Transport Interface Extension

Add `submitAnswers` to `src/shared/transport.ts`:

```typescript
export interface Transport {
  // ... existing methods ...
  submitAnswers(
    sessionId: string,
    toolCallId: string,
    answers: Record<string, string>,
  ): Promise<{ ok: boolean }>;
}
```

The `answers` object maps question indices (as string keys) to selected option labels or "Other" text values. For multi-select questions, the value is a JSON-serialized array of selected labels.

### 6.8 Express Route

Add to `src/server/routes/sessions.ts`:

```typescript
// POST /api/sessions/:id/submit-answers - Submit answers for AskUserQuestion
router.post('/:id/submit-answers', async (req, res) => {
  const { toolCallId, answers } = req.body;
  if (!toolCallId || !answers) {
    return res.status(400).json({ error: 'toolCallId and answers are required' });
  }
  const ok = agentManager.submitAnswers(req.params.id, toolCallId, answers);
  if (!ok) return res.status(404).json({ error: 'No pending question' });
  res.json({ ok: true });
});
```

### 6.9 HttpTransport Implementation

Add to `src/client/lib/http-transport.ts`:

```typescript
async submitAnswers(sessionId: string, toolCallId: string, answers: Record<string, string>) {
  const res = await fetch(`${this.baseUrl}/api/sessions/${sessionId}/submit-answers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ toolCallId, answers }),
  });
  if (!res.ok) throw new Error(`Submit answers failed: ${res.statusText}`);
  return res.json();
}
```

### 6.10 DirectTransport Implementation

Add to `src/client/lib/direct-transport.ts`:

```typescript
async submitAnswers(sessionId: string, toolCallId: string, answers: Record<string, string>) {
  const ok = this.agentManager.submitAnswers(sessionId, toolCallId, answers);
  return { ok };
}
```

### 6.11 QuestionPrompt Component

Create `src/client/components/chat/QuestionPrompt.tsx`:

**Props:**
```typescript
interface QuestionPromptProps {
  sessionId: string;
  toolCallId: string;
  questions: QuestionItem[];
}
```

**States:**
- `pending` (default): Renders questions with options, "Other" input, submit button
- `submitting`: Disabled inputs, loading indicator on submit button
- `submitted`: Collapsed compact summary showing selected answers

**Rendering logic per question:**
- Display `header` as a colored chip/tag (similar to ToolApproval's shield icon area)
- Display `question` as the main text
- If `multiSelect === false`: render radio buttons for each option
- If `multiSelect === true`: render checkboxes for each option
- Always append an "Other" option with a free-text input field
- Each option shows `label` prominently and `description` as muted subtext

**Post-submission collapsed state:**
```
┌──────────────────────────────────────────────┐
│ ✓  [header chip] Selected: "Option Label"    │
│    [header chip] Selected: "Option A", ...   │
└──────────────────────────────────────────────┘
```

**Styling:**
- Pending: amber border/bg (matching ToolApproval pending state)
- Submitted: emerald border/bg (matching ToolApproval approved state)
- Uses `useTransport()` hook for `submitAnswers` call
- Motion animations for enter/collapse transitions

### 6.12 Hook Integration (use-chat-session)

Add two new cases to `handleStreamEvent()`:

```typescript
case 'question_prompt': {
  const qp = data as QuestionPromptEvent;
  // Store as a special tool call that renders QuestionPrompt instead of ToolCallCard
  currentToolCallsRef.current.push({
    toolCallId: qp.toolCallId,
    toolName: 'AskUserQuestion',
    input: JSON.stringify(qp.questions),
    status: 'pending',
    _interactiveType: 'question',  // marker for rendering
    _questions: qp.questions,
  });
  updateAssistantMessage(assistantId);
  break;
}

case 'approval_required': {
  const ap = data as ApprovalEvent;
  currentToolCallsRef.current.push({
    toolCallId: ap.toolCallId,
    toolName: ap.toolName,
    input: ap.input,
    status: 'pending',
    _interactiveType: 'approval',  // marker for rendering
  });
  updateAssistantMessage(assistantId);
  break;
}
```

**Note:** The `_interactiveType` and `_questions` fields extend `ToolCallState`. We add these as optional fields:

```typescript
export interface ToolCallState {
  toolCallId: string;
  toolName: string;
  input: string;
  result?: string;
  status: 'pending' | 'running' | 'complete' | 'error';
  interactiveType?: 'question' | 'approval';
  questions?: QuestionItem[];
}
```

### 6.13 MessageItem Integration

Update `src/client/components/chat/MessageItem.tsx` to render interactive components:

```tsx
{message.toolCalls?.map((tc) => {
  if (tc.interactiveType === 'question' && tc.questions) {
    return (
      <QuestionPrompt
        key={tc.toolCallId}
        sessionId={sessionId}
        toolCallId={tc.toolCallId}
        questions={tc.questions}
      />
    );
  }
  if (tc.interactiveType === 'approval') {
    return (
      <ToolApproval
        key={tc.toolCallId}
        sessionId={sessionId}
        toolCallId={tc.toolCallId}
        toolName={tc.toolName}
        input={tc.input}
      />
    );
  }
  return <ToolCallCard key={tc.toolCallId} toolCall={tc} />;
})}
```

This requires `sessionId` to be passed down through `MessageItem`. Add it as a prop.

## 7. User Experience

### AskUserQuestion Flow

1. During a conversation, Claude invokes `AskUserQuestion` with 1-4 questions
2. The SDK pauses, and a `question_prompt` event appears in the chat stream
3. The user sees an inline card with questions, each showing:
   - A header chip (e.g., "Approach")
   - The question text
   - Radio buttons or checkboxes for options, each with label and description
   - An "Other" free-text field at the bottom
4. The user selects answers and clicks "Submit"
5. The card collapses to a compact summary showing selected answers
6. The SDK resumes with the answers injected

### Tool Approval Flow

1. Claude attempts to use a tool (e.g., `Bash`, `Write`) in `default` permission mode
2. The SDK pauses, and an `approval_required` event appears in the chat stream
3. The user sees the existing ToolApproval card with the tool name, input preview, and Approve/Deny buttons
4. The user clicks Approve or Deny
5. The card collapses to show the decision
6. The SDK resumes (allowed or denied)

### Timeout Behavior

If the user doesn't respond within 10 minutes, the tool call is automatically denied. The UI should show a "Timed out" state on the card.

## 8. Testing Strategy

### Unit Tests

**`src/server/services/__tests__/agent-manager-interactive.test.ts`:**
- Test `canUseTool` callback registers correctly
- Test `handleAskUserQuestion` creates pending interaction and emits event to queue
- Test `handleToolApproval` creates pending interaction for default permission mode
- Test `submitAnswers` resolves the correct pending interaction
- Test `approveTool` resolves approval interactions
- Test timeout fires and denies after 10 minutes (use fake timers)
- Test AbortSignal propagation cleans up pending interactions
- Test event queue draining yields events in correct order
- Test `canUseTool` returns `{ behavior: 'allow' }` for non-interactive tools
- Test `canUseTool` skips approval when permissionMode is not `'default'`

**`src/client/components/chat/__tests__/QuestionPrompt.test.tsx`:**
- Test renders single question with radio buttons
- Test renders multiple questions with checkboxes for multiSelect
- Test "Other" free-text input is always present
- Test submit button calls `transport.submitAnswers()` with correct answers
- Test submit button is disabled when no selection made
- Test collapses to compact summary after submission
- Test displays correct selected answers in collapsed state
- Test handles submission error gracefully

**`src/client/hooks/__tests__/use-chat-session-interactive.test.ts`:**
- Test `question_prompt` event adds tool call with `interactiveType: 'question'`
- Test `approval_required` event adds tool call with `interactiveType: 'approval'`

### Integration Tests

**`src/server/routes/__tests__/sessions-interactive.test.ts`:**
- Test POST `/submit-answers` returns 200 with valid pending question
- Test POST `/submit-answers` returns 404 when no pending question
- Test POST `/submit-answers` returns 400 when missing toolCallId or answers

### Mocking Strategy

- Mock `@anthropic-ai/claude-agent-sdk` `query()` function to yield controlled messages
- Simulate `canUseTool` callback invocation by testing the handler functions directly
- Use `vi.useFakeTimers()` for timeout tests
- Inject mock `Transport` via `TransportProvider` wrapper for component tests (established pattern)
- Mock `motion/react` in component tests (established pattern)

## 9. Performance Considerations

- **Event queue**: Uses a simple array with shift(). For single-user gateway, this is sufficient. No performance concern.
- **Promise.race in generator**: Adds minimal overhead. The race between SDK iterator and queue notify is the critical path, but since we're waiting for human input, latency is irrelevant.
- **Timeout cleanup**: `clearTimeout` is called on resolution. No leaked timers.
- **Memory**: Pending interactions Map is bounded by active tool calls per session (typically 1-2 at most).

## 10. Security Considerations

- **Input validation**: `submitAnswers` should validate that the `answers` object keys match expected question indices and values are strings
- **Timeout**: 10-minute timeout prevents indefinite resource holding
- **No cross-session access**: `submitAnswers` looks up the session by ID first, preventing cross-session answer injection
- **XSS**: Question text and option labels from the SDK are rendered as text content, not dangerously set as HTML

## 11. Documentation

### New

- `guides/interactive-tools.md` — Full developer guide covering:
  - The `canUseTool` pattern (how it pauses/resumes the SDK)
  - Event queue mechanism
  - How `AskUserQuestion` is implemented end-to-end
  - How tool approval is implemented end-to-end
  - Step-by-step guide for adding a new interactive tool
  - Both HttpTransport and DirectTransport patterns
  - Testing interactive tools

### Updates

- `CLAUDE.md` — Add `guides/interactive-tools.md` to the guides table
- `guides/architecture.md` — Add section on interactive tool data flow

## 12. Implementation Phases

### Phase 1: Core Infrastructure

**Files:** `src/server/services/agent-manager.ts`, `src/shared/types.ts`

- Add `QuestionPromptEvent`, `QuestionItem`, `QuestionOption` types
- Add `question_prompt` to `StreamEventType` union
- Refactor `AgentSession` to use `pendingInteractions` Map and `eventQueue`
- Implement `canUseTool` callback with `handleAskUserQuestion` and `handleToolApproval`
- Implement event queue draining in `sendMessage()` generator
- Add `submitAnswers()` method
- Update `approveTool()` to use `pendingInteractions`
- Add 10-minute timeout with deny behavior

### Phase 2: Transport + Routes

**Files:** `src/shared/transport.ts`, `src/server/routes/sessions.ts`, `src/client/lib/http-transport.ts`, `src/client/lib/direct-transport.ts`

- Add `submitAnswers()` to Transport interface
- Add POST `/api/sessions/:id/submit-answers` route
- Implement `submitAnswers()` in HttpTransport
- Implement `submitAnswers()` in DirectTransport

### Phase 3: Client Integration

**Files:** `src/client/hooks/use-chat-session.ts`, `src/client/components/chat/MessageItem.tsx`

- Add `interactiveType` and `questions` fields to `ToolCallState`
- Handle `question_prompt` and `approval_required` in `handleStreamEvent()`
- Pass `sessionId` to `MessageItem`
- Render `QuestionPrompt` / `ToolApproval` / `ToolCallCard` based on `interactiveType`

### Phase 4: QuestionPrompt Component

**Files:** `src/client/components/chat/QuestionPrompt.tsx` (new)

- Build the full component with pending/submitting/submitted states
- Radio buttons for single-select, checkboxes for multi-select
- "Other" free-text option
- Compact collapsed summary after submission
- Styling consistent with ToolApproval

### Phase 5: Developer Guide + Tests

**Files:** `guides/interactive-tools.md` (new), test files

- Write comprehensive developer guide
- Write unit tests for agent-manager interactive functionality
- Write component tests for QuestionPrompt
- Write route integration tests for /submit-answers
- Update CLAUDE.md guides table

## 13. File Impact Summary

### Modified Files (8)

| File | Changes |
|------|---------|
| `src/server/services/agent-manager.ts` | `canUseTool` callback, event queue, `pendingInteractions` Map, `submitAnswers()`, refactored `approveTool()` |
| `src/shared/types.ts` | `question_prompt` event type, `QuestionPromptEvent`, `QuestionItem`, `QuestionOption` interfaces, `interactiveType` on `ToolCallState` (if exported) |
| `src/shared/transport.ts` | `submitAnswers()` method on Transport interface |
| `src/client/hooks/use-chat-session.ts` | `question_prompt` + `approval_required` handlers, `interactiveType`/`questions` on `ToolCallState` |
| `src/client/components/chat/MessageItem.tsx` | Conditional rendering for interactive tool calls, `sessionId` prop |
| `src/client/lib/http-transport.ts` | `submitAnswers()` implementation |
| `src/client/lib/direct-transport.ts` | `submitAnswers()` implementation |
| `src/server/routes/sessions.ts` | POST `/submit-answers` endpoint |

### New Files (2+)

| File | Purpose |
|------|---------|
| `src/client/components/chat/QuestionPrompt.tsx` | Interactive question UI component |
| `guides/interactive-tools.md` | Developer guide for the interactive tool pattern |

### Test Files (3-4)

| File | Purpose |
|------|---------|
| `src/server/services/__tests__/agent-manager-interactive.test.ts` | canUseTool, submitAnswers, timeout tests |
| `src/client/components/chat/__tests__/QuestionPrompt.test.tsx` | Component rendering, submission, collapse tests |
| `src/server/routes/__tests__/sessions-interactive.test.ts` | Route integration tests |
| `src/client/hooks/__tests__/use-chat-session-interactive.test.ts` | Event handling tests (optional, can combine) |

## 14. Open Questions

1. **Event queue race condition**: The `Promise.race` approach in section 6.4 is conceptually correct but may need refinement during implementation. If the SDK's async iterator doesn't yield between `canUseTool` calls, the queue drain may need to be triggered differently. The simplest fallback is polling the queue with a short interval, but the race approach should be tried first.

2. **ToolCallState extension**: Should `interactiveType` and `questions` live on `ToolCallState` (shared type) or on a separate state object in the hook? Putting them on `ToolCallState` is simpler but slightly muddies the shared type. Decision: put them on `ToolCallState` since it's already a client-side type (not in `shared/types.ts`).

3. **Approval for all tools**: When `permissionMode` is `'default'`, should `canUseTool` require approval for ALL tool calls, or only when the SDK specifically flags the tool as needing approval? The SDK's `decisionReason` parameter may indicate this. During implementation, check the SDK behavior to determine which tools actually need approval in `default` mode.

## 15. References

- `specs/gateway-interactive-tool-ui/01-ideation.md` — Discovery and research document
- `guides/architecture.md` — Hexagonal architecture documentation
- `src/client/components/chat/ToolApproval.tsx` — Existing interactive component pattern
- Claude Agent SDK `Options.canUseTool` — SDK callback interface
- Claude Agent SDK `AskUserQuestionInput` — Input type for the AskUserQuestion tool
