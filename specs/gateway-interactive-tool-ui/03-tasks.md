# Gateway Interactive Tool UI - Task Breakdown

**Last Decompose: 2026-02-08**
**Spec**: `specs/gateway-interactive-tool-ui/02-specification.md`
**Feature Slug**: `gateway-interactive-tool-ui`

---

## Phase 1: Core Infrastructure

### Task 1.1: Add shared types for interactive tools

**File**: `src/shared/types.ts`
**Blocked by**: None
**Active form**: Adding shared type definitions for interactive tools

Add the following to `src/shared/types.ts`:

1. Add `'question_prompt'` to the `StreamEventType` union:

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
```

2. Add new interfaces:

```typescript
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
```

3. Update the `StreamEvent.data` union to include `QuestionPromptEvent`:

```typescript
export interface StreamEvent {
  type: StreamEventType;
  data: TextDelta | ToolCallEvent | ApprovalEvent | QuestionPromptEvent | ErrorEvent | DoneEvent | SessionStatusEvent;
}
```

**Acceptance criteria**:
- `question_prompt` is in the StreamEventType union
- `QuestionOption`, `QuestionItem`, `QuestionPromptEvent` interfaces are exported
- `StreamEvent.data` union includes `QuestionPromptEvent`
- Existing types unchanged
- TypeScript compiles with no errors

---

### Task 1.2: Refactor AgentSession and implement canUseTool callback

**File**: `src/server/services/agent-manager.ts`
**Blocked by**: Task 1.1
**Active form**: Implementing canUseTool callback and event queue in agent-manager

This is the largest task. It modifies `agent-manager.ts` to:

#### 1.2a: Define PendingInteraction and update AgentSession interface

Replace the existing `pendingApproval` field with:

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

Update `ensureSession()` to initialize `pendingInteractions: new Map()` and `eventQueue: []`.

#### 1.2b: Implement handleAskUserQuestion

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

#### 1.2c: Implement handleToolApproval

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

#### 1.2d: Register canUseTool in sendMessage()

Add to the `sdkOptions` setup in `sendMessage()`:

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

#### 1.2e: Implement event queue draining with Promise.race in sendMessage()

Replace the existing `for await` loop in `sendMessage()` with a merged iterator that races between SDK messages and queued events:

```typescript
async *sendMessage(sessionId, content, opts?) {
  const session = this.sessions.get(sessionId)!;
  session.eventQueue = [];

  // ... setup sdkOptions with canUseTool ...

  const agentQuery = query({ prompt: content, options: sdkOptions });

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

Keep the existing error handling try/catch and done event logic around this new loop structure.

#### 1.2f: Add submitAnswers method

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

#### 1.2g: Refactor approveTool to use pendingInteractions

```typescript
approveTool(sessionId: string, toolCallId: string, approved: boolean): boolean {
  const session = this.sessions.get(sessionId);
  const pending = session?.pendingInteractions.get(toolCallId);
  if (!pending || pending.type !== 'approval') return false;
  pending.resolve(approved);
  return true;
}
```

Remove the old `_toolCallId` parameter naming and `pendingApproval` field.

**Acceptance criteria**:
- `pendingApproval` field removed from AgentSession, replaced with `pendingInteractions` Map
- `eventQueue` and `eventQueueNotify` fields added to AgentSession
- `canUseTool` callback registered in `sendMessage()`
- `handleAskUserQuestion` emits `question_prompt` event and creates deferred promise
- `handleToolApproval` emits `approval_required` event and creates deferred promise (only when `permissionMode === 'default'`)
- Event queue drained via Promise.race between SDK iterator and queue notify
- `submitAnswers()` method resolves question interactions
- `approveTool()` refactored to use `pendingInteractions`
- 10-minute timeout on both question and approval interactions
- Non-interactive tools return `{ behavior: 'allow' }` immediately
- TypeScript compiles with no errors

---

## Phase 2: Transport + Routes

### Task 2.1: Add submitAnswers to Transport interface and all implementations

**Files**: `src/shared/transport.ts`, `src/server/routes/sessions.ts`, `src/client/lib/http-transport.ts`, `src/client/lib/direct-transport.ts`
**Blocked by**: Task 1.2
**Active form**: Adding submitAnswers to Transport interface and implementations

#### 2.1a: Transport interface (`src/shared/transport.ts`)

Add `submitAnswers` method:

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

#### 2.1b: Express route (`src/server/routes/sessions.ts`)

Add after the existing `/deny` route:

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

#### 2.1c: HttpTransport (`src/client/lib/http-transport.ts`)

Add method:

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

#### 2.1d: DirectTransport (`src/client/lib/direct-transport.ts`)

Add method and update the `DirectTransportServices.agentManager` interface to include `submitAnswers`:

```typescript
// In DirectTransportServices.agentManager:
submitAnswers(
  sessionId: string,
  toolCallId: string,
  answers: Record<string, string>,
): boolean;

// In DirectTransport class:
async submitAnswers(sessionId: string, toolCallId: string, answers: Record<string, string>) {
  const ok = this.services.agentManager.submitAnswers(sessionId, toolCallId, answers);
  return { ok };
}
```

**Acceptance criteria**:
- `submitAnswers` exists on Transport interface
- Express route validates `toolCallId` and `answers`, returns 400/404/200 correctly
- HttpTransport makes POST to `/api/sessions/:id/submit-answers`
- DirectTransport delegates to `agentManager.submitAnswers()`
- DirectTransportServices interface updated with `submitAnswers`
- TypeScript compiles with no errors

---

## Phase 3: Client Integration

### Task 3.1: Handle interactive events in useChatSession and update MessageItem

**Files**: `src/client/hooks/use-chat-session.ts`, `src/client/components/chat/MessageItem.tsx`
**Blocked by**: Task 2.1
**Active form**: Integrating interactive event handling in chat session hook and message rendering

#### 3.1a: Extend ToolCallState in `use-chat-session.ts`

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

Import `QuestionItem` from `@shared/types`.

#### 3.1b: Add event handlers in handleStreamEvent()

Add two new cases to `handleStreamEvent()`:

```typescript
case 'question_prompt': {
  const qp = data as QuestionPromptEvent;
  currentToolCallsRef.current.push({
    toolCallId: qp.toolCallId,
    toolName: 'AskUserQuestion',
    input: JSON.stringify(qp.questions),
    status: 'pending',
    interactiveType: 'question',
    questions: qp.questions,
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
    interactiveType: 'approval',
  });
  updateAssistantMessage(assistantId);
  break;
}
```

Import `QuestionPromptEvent` and `ApprovalEvent` from `@shared/types`.

#### 3.1c: Update MessageItem to accept sessionId and render interactive components

Add `sessionId` to `MessageItemProps`:

```typescript
interface MessageItemProps {
  message: ChatMessage;
  grouping: MessageGrouping;
  isNew?: boolean;
  isStreaming?: boolean;
  sessionId: string;  // NEW
}
```

Update the tool calls rendering block:

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

Import `QuestionPrompt` and `ToolApproval` components.

Also update the parent component that renders `MessageItem` to pass `sessionId` as a prop. Check `MessageList.tsx` or `ChatPanel.tsx` for where `MessageItem` is used and thread `sessionId` through.

**Acceptance criteria**:
- `ToolCallState` has optional `interactiveType` and `questions` fields
- `question_prompt` event creates a tool call entry with `interactiveType: 'question'` and `questions` populated
- `approval_required` event creates a tool call entry with `interactiveType: 'approval'`
- `MessageItem` accepts `sessionId` prop
- `MessageItem` conditionally renders `QuestionPrompt` for question type, `ToolApproval` for approval type, `ToolCallCard` for everything else
- Parent component passes `sessionId` to `MessageItem`
- TypeScript compiles with no errors

---

## Phase 4: QuestionPrompt Component

### Task 4.1: Build QuestionPrompt component

**File**: `src/client/components/chat/QuestionPrompt.tsx` (NEW)
**Blocked by**: Task 3.1
**Active form**: Building QuestionPrompt component with radio/checkbox options and submission flow

Create `src/client/components/chat/QuestionPrompt.tsx` with the following implementation:

**Props:**
```typescript
interface QuestionPromptProps {
  sessionId: string;
  toolCallId: string;
  questions: QuestionItem[];
}
```

**Component states:**
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
+-------------------------------------------------+
| checkmark  [header chip] Selected: "Option Label"    |
|    [header chip] Selected: "Option A", ...   |
+-------------------------------------------------+
```

**Styling:**
- Pending: amber border/bg (`border-amber-500/20 bg-amber-500/10`) matching ToolApproval pending state
- Submitted: emerald border/bg (`border-emerald-500/20 bg-emerald-500/10`) matching ToolApproval approved state
- Uses `useTransport()` hook for `submitAnswers` call
- `motion` animations for enter/collapse transitions (following established pattern in ToolApproval)

**Submit behavior:**
- Collect answers as `Record<string, string>` mapping question indices (as string keys "0", "1", etc.) to selected option labels
- For multi-select questions, the value is a JSON-serialized array of selected labels
- For "Other" selections, the value is the user's free text
- Call `transport.submitAnswers(sessionId, toolCallId, answers)` on submit
- Disable submit button when no selection is made for any question
- Handle submission errors gracefully (show error text, re-enable form)

**Icons from lucide-react:** `Check`, `CircleDot` (or similar for radio state), `MessageSquare` (for the question header)

**Acceptance criteria**:
- Component renders questions with headers as chips
- Radio buttons for single-select, checkboxes for multi-select
- "Other" free-text option always present for each question
- Submit button disabled when no selection made
- Calls `transport.submitAnswers()` with correctly formatted answers
- Collapses to compact summary after submission
- Amber styling when pending, emerald when submitted
- Motion animations for state transitions
- Handles submission errors without crashing

---

## Phase 5: Developer Guide + Tests

### Task 5.1: Write unit tests for agent-manager interactive functionality

**File**: `src/server/services/__tests__/agent-manager-interactive.test.ts` (NEW)
**Blocked by**: Task 1.2
**Active form**: Writing agent-manager interactive tool unit tests

Create comprehensive unit tests covering:

1. **canUseTool callback registration** - Verify it's set on sdkOptions
2. **handleAskUserQuestion** - Creates pending interaction, emits `question_prompt` event to queue
3. **handleToolApproval** - Creates pending interaction for `default` permission mode
4. **submitAnswers** - Resolves the correct pending interaction, returns true; returns false for non-existent
5. **approveTool** - Resolves approval interactions correctly; approve=true yields `{ behavior: 'allow' }`, approve=false yields `{ behavior: 'deny' }`
6. **Timeout** - Uses `vi.useFakeTimers()` to test 10-minute timeout fires and denies
7. **Event queue draining** - Events pushed to queue are yielded by the generator
8. **canUseTool returns allow for non-interactive tools** - When tool is not AskUserQuestion and permissionMode is not 'default'
9. **canUseTool skips approval when permissionMode is not 'default'** - e.g., `bypassPermissions`

**Mocking strategy:**
- Mock `@anthropic-ai/claude-agent-sdk` `query()` function to yield controlled messages
- Test handler functions directly by accessing them on the class or extracting them
- Use `vi.useFakeTimers()` for timeout tests

---

### Task 5.2: Write QuestionPrompt component tests

**File**: `src/client/components/chat/__tests__/QuestionPrompt.test.tsx` (NEW)
**Blocked by**: Task 4.1
**Active form**: Writing QuestionPrompt component tests

Create component tests covering:

1. **Renders single question with radio buttons** - Single-select question shows radio inputs
2. **Renders multiple questions with checkboxes** - Multi-select question shows checkbox inputs
3. **"Other" free-text input is always present** - Each question has an "Other" option with text input
4. **Submit button calls `transport.submitAnswers()`** - Verifies correct sessionId, toolCallId, and answers object
5. **Submit button disabled when no selection** - Cannot submit without selecting at least one answer per question
6. **Collapses to compact summary after submission** - Shows selected answers in collapsed state
7. **Displays correct selected answers in collapsed state** - Labels match what was selected
8. **Handles submission error gracefully** - Error state shows error message, form re-enabled

**Testing patterns (follow established conventions):**
- Mock `motion/react` to render plain elements (established pattern)
- Inject mock `Transport` via `TransportProvider` wrapper (established pattern)
- Use React Testing Library with jsdom
- Use `@testing-library/user-event` for interactions

---

### Task 5.3: Write route integration tests and hook event handling tests

**Files**: `src/server/routes/__tests__/sessions-interactive.test.ts` (NEW), optionally `src/client/hooks/__tests__/use-chat-session-interactive.test.ts` (NEW)
**Blocked by**: Task 2.1, Task 3.1
**Active form**: Writing route integration tests and hook event handling tests

**Route tests** (`sessions-interactive.test.ts`):
1. **POST `/submit-answers` returns 200** with valid pending question
2. **POST `/submit-answers` returns 404** when no pending question exists
3. **POST `/submit-answers` returns 400** when missing `toolCallId` or `answers` in body

**Hook tests** (`use-chat-session-interactive.test.ts`, optional - can combine with route tests):
1. **`question_prompt` event** adds tool call with `interactiveType: 'question'` and populated `questions`
2. **`approval_required` event** adds tool call with `interactiveType: 'approval'`

---

### Task 5.4: Write interactive tools developer guide and update docs

**Files**: `guides/interactive-tools.md` (NEW), `CLAUDE.md` (update)
**Blocked by**: Task 4.1
**Active form**: Writing interactive tools developer guide

Create `guides/interactive-tools.md` covering:

1. **The `canUseTool` pattern** - How it pauses/resumes the SDK via deferred promises
2. **Event queue mechanism** - How events flow from canUseTool callback to the async generator
3. **AskUserQuestion end-to-end** - Full flow from SDK invocation through UI rendering to answer submission
4. **Tool approval end-to-end** - Full flow from SDK tool use through UI approval to SDK resume
5. **Step-by-step guide for adding a new interactive tool** - What to modify in agent-manager, types, transport, routes, client hook, and component
6. **Both HttpTransport and DirectTransport patterns** - How each transport implements submitAnswers
7. **Testing interactive tools** - Mocking strategies, fake timers, transport injection

Update `CLAUDE.md` guides table to include the new guide:
```
| [`guides/interactive-tools.md`](guides/interactive-tools.md) | canUseTool pattern, event queue, AskUserQuestion/tool approval flows, adding new interactive tools |
```

**Acceptance criteria**:
- Guide is comprehensive and follows existing guide style
- Includes code examples for adding a hypothetical new interactive tool
- CLAUDE.md updated with new guide entry
