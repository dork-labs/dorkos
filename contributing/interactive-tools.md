# Interactive Tools

## Overview

Interactive tools are tools that pause the Claude Agent SDK mid-execution to collect input from the user through the DorkOS UI, then resume the SDK with the user's response. They bridge the gap between the SDK's synchronous `canUseTool` callback and the asynchronous nature of a web-based UI where users need time to read, decide, and respond.

Two interactive tools exist today:

1. **AskUserQuestion** -- Claude asks the user structured questions with selectable options. The user picks answers, which are injected back into the tool's input before the SDK continues.
2. **Tool Approval** -- When `permissionMode` is `'default'`, every tool call pauses for the user to approve or deny execution.

The pattern is designed to be extensible. Any new tool that requires user interaction mid-stream can follow the same architecture.

## Architecture

The interactive tools pattern connects three layers: the SDK callback, the streaming generator, and the client UI. The key challenge is that `canUseTool` is a synchronous callback that must return a `Promise<PermissionResult>`, while the user response arrives later over HTTP or in-process transport.

### Data Flow

```
SDK calls canUseTool(toolName, input, context)
  |
  |  1. Handler pushes StreamEvent to session.eventQueue
  |  2. Handler calls session.eventQueueNotify() to wake the generator
  |  3. Handler creates a deferred Promise, stores it in session.pendingInteractions
  |  4. Handler returns the Promise (SDK blocks here)
  |
  v
sendMessage() generator loop (Promise.race)
  |
  |  Races between:
  |    - sdkIterator.next()     (next SDK message)
  |    - eventQueueNotify       (canUseTool pushed an event)
  |
  |  When queue wins, drains events and yields them
  |
  v
StreamEvent yielded to client
  |
  |  HttpTransport: SSE event -> onEvent callback
  |  DirectTransport: AsyncGenerator iteration -> onEvent callback
  |
  v
useChatSession processes event
  |
  |  Adds ToolCallState with interactiveType to message
  |
  v
MessageItem renders interactive component
  |
  |  QuestionPrompt or ToolApproval
  |
  v
User responds (clicks button / selects option)
  |
  v
Transport method called (submitAnswers / approveTool / denyTool)
  |
  |  HttpTransport: POST to /api/sessions/:id/submit-answers (or /approve, /deny)
  |  DirectTransport: calls runtime method directly
  |
  v
Runtime resolves the deferred Promise
  |
  |  Clears timeout, removes from pendingInteractions
  |  Returns PermissionResult to SDK
  |
  v
SDK resumes execution
```

### Key Mechanism: Promise.race

The `sendMessage()` generator must yield events from two sources: the SDK iterator and the `canUseTool` callback. Since `canUseTool` runs on a separate async path (called by the SDK internally), it cannot directly yield events. Instead, it pushes events to `session.eventQueue` and calls `session.eventQueueNotify()`.

The generator races between the SDK's next message and the queue notification:

```typescript
// From claude-code-runtime.ts sendMessage()
const queuePromise = new Promise<'queue'>((resolve) => {
  session.eventQueueNotify = () => resolve('queue');
});

const sdkPromise = sdkIterator.next().then((result) => ({ sdk: true, result }));

const winner = await Promise.race([queuePromise, sdkPromise]);
```

When the queue wins, the generator drains all queued events before checking the SDK again. When the SDK wins, it processes the SDK message normally. This allows interactive events to be yielded to the client even while the SDK is blocked waiting for the deferred promise.

## Existing Interactive Tools

### AskUserQuestion

Full walkthrough from SDK to UI and back.

**1. SDK triggers `canUseTool`**

The SDK calls `canUseTool('AskUserQuestion', input, context)` where `input` contains a `questions` array of `QuestionItem` objects.

**2. `handleAskUserQuestion` creates the event and deferred promise**

```typescript
// services/runtimes/claude-code/interactive-handlers.ts
function handleAskUserQuestion(session, toolUseId, input) {
  // Push event to queue for the generator to yield
  session.eventQueue.push({
    type: 'question_prompt',
    data: {
      toolCallId: toolUseId,
      questions: input.questions,
    },
  });
  session.eventQueueNotify?.();

  // Return a promise that blocks the SDK until the user responds
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      session.pendingInteractions.delete(toolUseId);
      resolve({ behavior: 'deny', message: 'User did not respond within 10 minutes' });
    }, SESSIONS.INTERACTION_TIMEOUT_MS);

    session.pendingInteractions.set(toolUseId, {
      type: 'question',
      toolCallId: toolUseId,
      resolve: (answers) => {
        clearTimeout(timeout);
        session.pendingInteractions.delete(toolUseId);
        resolve({ behavior: 'allow', updatedInput: { ...input, answers } });
      },
      reject: () => {
        clearTimeout(timeout);
        session.pendingInteractions.delete(toolUseId);
        resolve({ behavior: 'deny', message: 'Interaction cancelled' });
      },
      timeout,
    });
  });
}
```

**3. Client receives `question_prompt` event**

In `useChatSession`, the `handleStreamEvent` function adds a tool call entry with `interactiveType: 'question'`:

```typescript
case 'question_prompt': {
  const question = data as QuestionPromptEvent;
  currentToolCallsRef.current.push({
    toolCallId: question.toolCallId,
    toolName: 'AskUserQuestion',
    input: '',
    status: 'pending',
    interactiveType: 'question',
    questions: question.questions,
  });
  updateAssistantMessage(assistantId);
  break;
}
```

**4. `MessageItem` renders `QuestionPrompt`**

```typescript
// MessageItem.tsx
if (tc.interactiveType === 'question' && tc.questions) {
  return <QuestionPrompt sessionId={sessionId} toolCallId={tc.toolCallId} questions={tc.questions} />;
}
```

**5. User selects options and submits**

`QuestionPrompt` renders radio buttons (single-select) or checkboxes (multi-select) for each question's options, plus an "Other" free-text option. On submit, it builds an answers record and calls the transport:

```typescript
await transport.submitAnswers(sessionId, toolCallId, answers);
```

**6. Transport resolves the deferred promise**

The transport calls `runtime.submitAnswers(sessionId, toolCallId, answers)`, which finds the pending interaction and calls its `resolve(answers)` function. This resolves the original promise with `{ behavior: 'allow', updatedInput: { ...input, answers } }`, and the SDK continues with the user's answers injected into the tool input.

### Tool Approval

Full walkthrough for `permissionMode: 'default'`.

**1. SDK triggers `canUseTool`**

For any tool that is not `AskUserQuestion`, and is not in the auto-approved sets (read-only Claude Code tools and DorkOS agent tools), when the session's `permissionMode` is `'default'`, the `createCanUseTool` callback calls `handleToolApproval`. Read-only tools (`Read`, `Grep`, `Glob`, `LS`, `NotebookRead`, `WebSearch`, `WebFetch`) and DorkOS agent tools (`mcp__dorkos__*`) are always auto-approved regardless of permission mode.

**2. `handleToolApproval` creates the event and deferred promise**

```typescript
// services/runtimes/claude-code/interactive-handlers.ts
function handleToolApproval(session, toolUseId, toolName, input) {
  session.eventQueue.push({
    type: 'approval_required',
    data: {
      toolCallId: toolUseId,
      toolName,
      input: JSON.stringify(input),
    },
  });
  session.eventQueueNotify?.();

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      session.pendingInteractions.delete(toolUseId);
      resolve({ behavior: 'deny', message: 'Tool approval timed out after 10 minutes' });
    }, SESSIONS.INTERACTION_TIMEOUT_MS);

    session.pendingInteractions.set(toolUseId, {
      type: 'approval',
      toolCallId: toolUseId,
      resolve: (approved) => {
        clearTimeout(timeout);
        session.pendingInteractions.delete(toolUseId);
        resolve(
          approved
            ? { behavior: 'allow', updatedInput: input }
            : { behavior: 'deny', message: 'User denied tool execution' }
        );
      },
      reject: () => {
        clearTimeout(timeout);
        session.pendingInteractions.delete(toolUseId);
        resolve({ behavior: 'deny', message: 'Interaction cancelled' });
      },
      timeout,
    });
  });
}
```

**3. Client receives `approval_required` event**

In `useChatSession`, the handler adds a tool call entry with `interactiveType: 'approval'`:

```typescript
case 'approval_required': {
  const approval = data as ApprovalEvent;
  currentToolCallsRef.current.push({
    toolCallId: approval.toolCallId,
    toolName: approval.toolName,
    input: approval.input,
    status: 'pending',
    interactiveType: 'approval',
  });
  updateAssistantMessage(assistantId);
  break;
}
```

**4. `MessageItem` renders `ToolApproval`**

```typescript
// MessageItem.tsx
if (tc.interactiveType === 'approval') {
  return <ToolApproval sessionId={sessionId} toolCallId={tc.toolCallId} toolName={tc.toolName} input={tc.input} />;
}
```

**5. User clicks Approve or Deny**

`ToolApproval` shows the tool name, pretty-printed input JSON, and two buttons. On click:

```typescript
// Approve
await transport.approveTool(sessionId, toolCallId);
onDecided?.(); // Optimistically update indicator (see below)

// Deny
await transport.denyTool(sessionId, toolCallId);
onDecided?.();
```

**6. Optimistic indicator update via `markToolCallResponded`**

After the user clicks Approve or Deny, the transport call resolves the server-side promise — but the server's `tool_result` event can take seconds for slow tools (e.g., Bash). Without an optimistic update, the `InferenceIndicator` would stay stuck on "Waiting for your approval" during that gap.

The fix: `ToolApproval` receives an `onDecided` callback (threaded from `useChatSession` → `ChatPanel` → `MessageList` → `MessageItem` → `ToolApproval`). This calls `markToolCallResponded(toolCallId)`, which immediately sets the tool call part's status from `'pending'` to `'running'` in the message state:

```typescript
// useChatSession.ts — markToolCallResponded
const part = currentPartsRef.current.find(
  (p) => p.type === 'tool_call' && p.toolCallId === toolCallId
);
if (part && part.type === 'tool_call') {
  part.status = 'running';
  // Trigger re-render with updated parts
  const parts = currentPartsRef.current.map((p) => ({ ...p }));
  const derived = deriveFromParts(parts);
  setMessages((prev) => prev.map((m) => /* update matching message */));
}
```

This clears `isWaitingForUser` (which checks for `status === 'pending'`), so the indicator immediately switches back to rotating verbs. The server's `tool_result` event later sets status to `'complete'`.

**7. Transport resolves the deferred promise**

Both `approveTool` and `denyTool` call `runtime.approveTool(sessionId, toolCallId, approved)` with `true` or `false`. The pending interaction's `resolve(approved)` is called, returning `{ behavior: 'allow' }` or `{ behavior: 'deny' }` to the SDK.

## Adding a New Interactive Tool

Follow these steps to add a new interactive tool (e.g., a file picker, a confirmation dialog, or a multi-step wizard).

### Step 1: Add event type to `types.ts`

Define the event data interface and add the event type to `StreamEventType`:

```typescript
// packages/shared/src/types.ts

export type StreamEventType =
  | 'text_delta'
  // ... existing types ...
  | 'my_new_interactive'; // Add here

export interface MyNewInteractiveEvent {
  toolCallId: string;
  // ... your event-specific fields
}

export interface StreamEvent {
  type: StreamEventType;
  data:
    | TextDelta
    | ToolCallEvent
    | ApprovalEvent
    | QuestionPromptEvent
    | MyNewInteractiveEvent // Add here
    | ErrorEvent
    | DoneEvent
    | SessionStatusEvent;
}
```

### Step 2: Add handler in `interactive-handlers.ts`

Create a handler function following the deferred promise pattern, and wire it into `canUseTool`:

```typescript
// apps/server/src/services/runtimes/claude-code/interactive-handlers.ts

function handleMyNewInteractive(
  session: InteractiveSession,
  toolUseId: string,
  input: Record<string, unknown>
): Promise<PermissionResult> {
  session.eventQueue.push({
    type: 'my_new_interactive',
    data: {
      toolCallId: toolUseId,
      // ... extract fields from input
    },
  });
  session.eventQueueNotify?.();

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      session.pendingInteractions.delete(toolUseId);
      resolve({ behavior: 'deny', message: 'Timed out' });
    }, SESSIONS.INTERACTION_TIMEOUT_MS);

    session.pendingInteractions.set(toolUseId, {
      type: 'my_new_type', // Add to PendingInteraction type union
      toolCallId: toolUseId,
      resolve: (result) => {
        clearTimeout(timeout);
        session.pendingInteractions.delete(toolUseId);
        resolve({ behavior: 'allow', updatedInput: { ...input, result } });
      },
      reject: () => {
        clearTimeout(timeout);
        session.pendingInteractions.delete(toolUseId);
        resolve({ behavior: 'deny', message: 'Cancelled' });
      },
      timeout,
    });
  });
}
```

Then wire into `createCanUseTool` in `interactive-handlers.ts`:

```typescript
// In the canUseTool callback returned by createCanUseTool:
if (toolName === 'AskUserQuestion') {
  return handleAskUserQuestion(session, context.toolUseID, input);
}
if (toolName === 'MyNewTool') {
  return handleMyNewInteractive(session, context.toolUseID, input);
}
// ... read-only / DorkOS auto-allow ...
if (session.permissionMode === 'default') {
  return handleToolApproval(session, context.toolUseID, toolName, input);
}
return { behavior: 'allow', updatedInput: input };
```

### Step 3: Add transport method

Add a method to the `Transport` interface and implement it in both transports:

```typescript
// packages/shared/src/transport.ts
export interface Transport {
  // ... existing methods ...
  submitMyNewResult(
    sessionId: string,
    toolCallId: string,
    result: MyResult
  ): Promise<{ ok: boolean }>;
}
```

Add a resolver method to `ClaudeCodeRuntime`:

```typescript
// services/runtimes/claude-code/claude-code-runtime.ts
submitMyNewResult(sessionId: string, toolCallId: string, result: MyResult): boolean {
  const session = this.activeSessions.get(sessionId);
  const pending = session?.pendingInteractions.get(toolCallId);
  if (!pending || pending.type !== 'my_new_type') return false;
  pending.resolve(result);
  return true;
}
```

Implement in `HttpTransport` (POST to a new route) and `DirectTransport` (call the runtime directly).

### Step 4: Add route (HttpTransport only)

```typescript
// apps/server/src/routes/sessions.ts
router.post('/:id/my-new-result', async (req, res) => {
  const { toolCallId, result } = req.body;
  const ok = runtime.submitMyNewResult(req.params.id, toolCallId, result);
  if (!ok) return res.status(404).json({ error: 'No pending interaction' });
  res.json({ ok: true });
});
```

### Step 5: Handle event in `useChatSession`

Add a case to `handleStreamEvent`:

```typescript
// apps/client/src/layers/features/chat/model/use-chat-session.ts
case 'my_new_interactive': {
  const event = data as MyNewInteractiveEvent;
  currentToolCallsRef.current.push({
    toolCallId: event.toolCallId,
    toolName: 'MyNewTool',
    input: '',
    status: 'pending',
    interactiveType: 'my_new_type',
    // Store additional data on ToolCallState (extend the interface if needed)
  });
  updateAssistantMessage(assistantId);
  break;
}
```

You may need to extend `ToolCallState` to hold your tool's specific data fields, similar to how `questions` is stored for the question prompt.

### Step 6: Build UI component

Create a component in `apps/client/src/layers/features/chat/ui/` that:

- Accepts `sessionId`, `toolCallId`, and your event-specific data as props
- Renders the interactive UI (form, buttons, picker, etc.)
- Calls the transport method on user action
- Shows a collapsed "completed" state after submission

Follow the patterns in `QuestionPrompt.tsx` and `ToolApproval.tsx`.

### Step 7: Wire into `MessageItem`

Add a condition in `MessageItem.tsx` to render your component:

```typescript
// apps/client/src/layers/features/chat/ui/MessageItem.tsx
if (tc.interactiveType === 'my_new_type') {
  return <MyNewInteractive key={tc.toolCallId} sessionId={sessionId} toolCallId={tc.toolCallId} /* ... */ />;
}
```

## Key Patterns

### Deferred Promise Pattern

The core mechanism that bridges `canUseTool` (sync callback) with user interaction (async, delayed). Each handler creates a `Promise` and stores its `resolve`/`reject` functions in the `pendingInteractions` Map, keyed by `toolUseId`. When the user responds, the corresponding resolve function is called, which completes the original promise and unblocks the SDK.

```typescript
interface PendingInteraction {
  type: 'question' | 'approval';
  toolCallId: string;
  resolve: (result: unknown) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
}
```

The `pendingInteractions` Map on each session holds all currently blocked interactions. Multiple can be pending simultaneously if the SDK calls `canUseTool` concurrently.

### Event Queue + Promise.race

The event queue (`session.eventQueue`) and notification function (`session.eventQueueNotify`) solve a concurrency problem: the `canUseTool` callback runs on a different async path from the generator loop, so it cannot directly yield events.

The `Promise.race` in the generator loop ensures that queued events are yielded promptly, even if the SDK iterator is blocked (which it will be, since it is waiting for `canUseTool` to return):

```
Generator loop iteration:
  1. Drain any existing queue items (yield them)
  2. Race: SDK next message vs. queue notification
  3. If queue wins -> continue (drains on next iteration)
  4. If SDK wins -> process SDK message
```

### Timeout Handling

Every deferred promise includes a 10-minute timeout (`SESSIONS.INTERACTION_TIMEOUT_MS = 10 * 60 * 1000`, defined in `apps/server/src/config/constants.ts`). If the user does not respond, the timeout fires, removes the interaction from `pendingInteractions`, and resolves the promise with `{ behavior: 'deny' }`. This prevents the SDK from hanging indefinitely.

The timeout is cleared whenever the interaction is resolved normally (user responds or interaction is cancelled).

### Timeout Visibility

The `ToolApproval` component makes the server-side timeout visible to users via a countdown timer. The server includes `timeoutMs` in the `approval_required` SSE event, which flows through the stream event handler to the component.

**Visual indicators:**
- A thin progress bar (4px) drains over the timeout duration via CSS `@keyframes drain` animation (GPU-composited, zero JS cost)
- Bar color transitions: neutral → amber at 2 minutes remaining → red at 1 minute remaining
- Text countdown (`M:SS remaining`) appears only in the final 2 minutes
- On timeout: card transitions to denied state with explanation message

**Accessibility:**
- Progress bar has `role="progressbar"` with `aria-valuemin`, `aria-valuemax`, `aria-valuenow`, and `aria-valuetext`
- Screen reader announcements via `aria-live="assertive"` fire only at threshold crossings (2 min, 1 min, timeout)
- `prefers-reduced-motion` respected via `motion-safe:` Tailwind prefix — animation disabled, color transitions remain

**Data flow:** Server `handleToolApproval()` → `approval_required` SSE event (includes `timeoutMs: SESSIONS.INTERACTION_TIMEOUT_MS`) → stream-event-handler passes to tool call part → `ToolApproval` renders countdown from `timeoutMs` prop.

### Transport Abstraction

Both `HttpTransport` and `DirectTransport` implement the same `Transport` interface, so interactive tool components work identically in both environments:

- **HttpTransport** (standalone web): Makes POST requests to Express routes (`/approve`, `/deny`, `/submit-answers`). The route handler calls the runtime methods.
- **DirectTransport** (Obsidian plugin): Calls runtime methods directly in-process.

Components use `useTransport()` to get the current transport and never know which adapter is active.

## Testing

### Route Tests

Route-level tests for interactive endpoints mock `runtimeRegistry` and verify HTTP status codes and request/response shapes. See `apps/server/src/routes/__tests__/sessions-interactive.test.ts` for examples:

```typescript
const mockSubmitAnswers = vi.fn();
const mockApproveTool = vi.fn();

const mockRuntime = {
  approveTool: mockApproveTool,
  submitAnswers: mockSubmitAnswers,
  // ... other AgentRuntime methods
};

vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getDefault: vi.fn(() => mockRuntime),
  },
}));

it('returns 200 when pending question exists', async () => {
  mockSubmitAnswers.mockReturnValue(true);
  const res = await request(app)
    .post('/api/sessions/test-session/submit-answers')
    .send({ toolCallId: 'tc-1', answers: { '0': 'Option A' } });
  expect(res.status).toBe(200);
});
```

### Component Tests

UI components should be tested with React Testing Library and a mock transport:

```typescript
function createMockTransport(overrides?: Partial<Transport>): Transport {
  return {
    submitAnswers: vi.fn().mockResolvedValue({ ok: true }),
    approveTool: vi.fn().mockResolvedValue({ ok: true }),
    denyTool: vi.fn().mockResolvedValue({ ok: true }),
    // ... all Transport methods
    ...overrides,
  };
}
```

Wrap the component in `TransportProvider` with the mock transport, then simulate user interaction (clicking options, pressing submit) and assert that the correct transport method was called with the right arguments.

### Testing the Deferred Promise

To test `handleAskUserQuestion` or `handleToolApproval` directly, construct a minimal `InteractiveSession` object (the handler interface, exported from `interactive-handlers.ts`) with an empty `pendingInteractions` Map and `eventQueue` array, call the handler, then resolve the pending interaction and assert the returned `PermissionResult`:

```typescript
const session: InteractiveSession = {
  pendingInteractions: new Map(),
  eventQueue: [],
};

const promise = handleAskUserQuestion(session, 'tc-1', {
  questions: [
    /* ... */
  ],
});

// Verify event was queued
expect(session.eventQueue).toHaveLength(1);
expect(session.eventQueue[0].type).toBe('question_prompt');

// Simulate user response
const pending = session.pendingInteractions.get('tc-1');
pending.resolve({ '0': 'Option A' });

const result = await promise;
expect(result.behavior).toBe('allow');
expect(result.updatedInput.answers).toEqual({ '0': 'Option A' });
```
