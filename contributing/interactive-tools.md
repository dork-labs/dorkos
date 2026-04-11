# Interactive Tools

## Overview

Interactive tools are tools that pause the Claude Agent SDK mid-execution to collect input from the user through the DorkOS UI, then resume the SDK with the user's response. They bridge the gap between the SDK's synchronous `canUseTool` callback and the asynchronous nature of a web-based UI where users need time to read, decide, and respond.

Two interactive tools exist today:

1. **AskUserQuestion** -- Claude asks the user structured questions with selectable options. The user picks answers, which are injected back into the tool's input before the SDK continues.
2. **Tool Approval** -- When `permissionMode` is `'default'`, every tool call pauses for the user to approve, always-allow, or deny execution.

The pattern is designed to be extensible. Any new tool that requires user interaction mid-stream can follow the same architecture.

A separate but related system -- **Agent UI Control** -- lets agents control the client UI without blocking the SDK. See the [Agent UI Control](#agent-ui-control) section below.

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
onDecided?.(); // Optimistically clear waiting state (same pattern as ToolApproval)
```

Both `QuestionPrompt` and `ToolApproval` treat HTTP 409 (`INTERACTION_ALREADY_RESOLVED`) as success — this handles the race condition where the SDK resolves the interaction before the client's HTTP request arrives.

**6. Transport resolves the deferred promise**

The transport calls `runtime.submitAnswers(sessionId, toolCallId, answers)`, which finds the pending interaction and calls its `resolve(answers)` function. This resolves the original promise with `{ behavior: 'allow', updatedInput: { ...input, answers } }`, and the SDK continues with the user's answers injected into the tool input.

### Tool Approval

Full walkthrough for `permissionMode: 'default'`.

**1. SDK triggers `canUseTool`**

For any tool that is not `AskUserQuestion`, and is not in the auto-approved sets (read-only Claude Code tools and DorkOS agent tools), when the session's `permissionMode` is `'default'`, the `createCanUseTool` callback calls `handleToolApproval`. The auto-approved tool sets are defined as module-level `Set` constants (`READ_ONLY_TOOLS` and `DORKOS_AGENT_TOOLS`) to avoid per-call reconstruction. Read-only tools (`Read`, `Grep`, `Glob`, `LS`, `NotebookRead`, `WebSearch`, `WebFetch`) and DorkOS agent tools (`mcp__dorkos__*`) are always auto-approved regardless of permission mode.

**2. `handleToolApproval` creates the event and deferred promise**

`handleToolApproval` now receives a `ToolApprovalContext` parameter (exported from `interactive-handlers.ts`) containing SDK-provided context fields and an `AbortSignal`:

```typescript
// services/runtimes/claude-code/interactive-handlers.ts
export interface ToolApprovalContext {
  signal: AbortSignal;
  toolUseID: string;
  title?: string; // Full permission prompt sentence from SDK
  displayName?: string; // Short noun phrase for the tool action
  description?: string; // Human-readable subtitle from SDK
  blockedPath?: string; // File path that triggered the permission request
  decisionReason?: string; // Why this permission request was triggered
  suggestions?: PermissionUpdate[]; // SDK permission suggestions for "Always Allow"
}

function handleToolApproval(session, toolUseId, toolName, input, context: ToolApprovalContext) {
  const startedAt = Date.now();

  session.eventQueue.push({
    type: 'approval_required',
    data: {
      toolCallId: toolUseId,
      toolName,
      input: JSON.stringify(input),
      timeoutMs: SESSIONS.INTERACTION_TIMEOUT_MS,
      startedAt,
      // SDK-provided rich context for the approval UI
      title: context.title,
      displayName: context.displayName,
      description: context.description,
      blockedPath: context.blockedPath,
      decisionReason: context.decisionReason,
      hasSuggestions: (context.suggestions?.length ?? 0) > 0,
    },
  });
  session.eventQueueNotify?.();

  return new Promise((resolve) => {
    const deny = (message: string) => resolve({ behavior: 'deny', message });

    // Auto-deny if the SDK query is aborted (e.g. user interrupts the stream)
    const onAbort = () => {
      clearTimeout(timeout);
      session.pendingInteractions.delete(toolUseId);
      deny('Tool approval aborted');
    };
    context.signal.addEventListener('abort', onAbort, { once: true });

    const timeout = setTimeout(() => {
      context.signal.removeEventListener('abort', onAbort);
      session.pendingInteractions.delete(toolUseId);
      deny(
        `Tool approval timed out after ${Math.ceil(SESSIONS.INTERACTION_TIMEOUT_MS / 60_000)} minutes`
      );
    }, SESSIONS.INTERACTION_TIMEOUT_MS);

    session.pendingInteractions.set(toolUseId, {
      type: 'approval',
      toolCallId: toolUseId,
      suggestions: context.suggestions,
      resolve: (result) => {
        clearTimeout(timeout);
        context.signal.removeEventListener('abort', onAbort);
        session.pendingInteractions.delete(toolUseId);

        if (Array.isArray(result)) {
          // "Always Allow" — forward SDK permission suggestions
          resolve({ behavior: 'allow', updatedInput: input, updatedPermissions: result });
        } else if (result) {
          resolve({ behavior: 'allow', updatedInput: input });
        } else {
          deny('User denied tool execution');
        }
      },
      reject: () => {
        clearTimeout(timeout);
        context.signal.removeEventListener('abort', onAbort);
        session.pendingInteractions.delete(toolUseId);
        deny('Interaction cancelled');
      },
      timeout,
    });
  });
}
```

Key changes from the original pattern:

- **AbortSignal handling**: The `context.signal` is listened to so that if the user interrupts the stream, the pending approval is auto-denied and the abort listener is cleaned up (preventing resource leaks).
- **SDK context fields**: Rich context (`title`, `displayName`, `description`, `blockedPath`, `decisionReason`) is forwarded through the SSE event so the client can render a more informative approval UI.
- **`startedAt` timestamp**: The server includes the exact timestamp when the approval timer started, allowing the client to compute a drift-free countdown rather than relying on client-side timing.
- **Always Allow**: When `result` is a `PermissionUpdate[]` array (rather than a boolean), the handler resolves with `updatedPermissions` — the SDK uses these to permanently allow the tool pattern without future prompts.

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

**5. User clicks Approve, Always Allow, or Deny**

`ToolApproval` shows the tool name, pretty-printed input JSON, SDK context fields (title, description, blocked path, decision reason), risk-level visual differentiation (high/medium/low Shield icon colors), and up to three buttons. On click:

```typescript
// Approve
await transport.approveTool(sessionId, toolCallId);
onDecided?.(); // Optimistically update indicator (see below)

// Always Allow (Shift+Enter keyboard shortcut)
// Only shown when hasSuggestions is true (SDK provided permission suggestions)
await transport.approveTool(sessionId, toolCallId, { alwaysAllow: true });
onDecided?.();

// Deny
await transport.denyTool(sessionId, toolCallId);
onDecided?.();
```

When multiple tool approvals are pending concurrently, a `BatchApprovalBar` appears allowing the user to approve or deny all queued approvals in a single action:

```typescript
// Batch approve all pending
await transport.batchApproveTool(sessionId, toolCallIds);

// Batch deny all pending
await transport.batchDenyTool(sessionId, toolCallIds);
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

### MCP Elicitation

MCP elicitation allows agents to request structured form input mid-session — typically used to collect credentials (API keys, OAuth tokens) needed by an MCP server before it can proceed. Unlike `AskUserQuestion` (which presents preset options), elicitation renders a dynamic form derived from a JSON Schema.

**1. SDK triggers the elicitation hook**

When an MCP server invokes the elicitation protocol, the SDK calls the registered elicitation handler with a `requestedSchema` JSON Schema object and a descriptive `message`.

**2. `handleElicitation` creates the event and deferred promise**

The handler in `interactive-handlers.ts` follows the same deferred promise pattern:

```typescript
function handleElicitation(session, elicitationId, message, requestedSchema) {
  session.eventQueue.push({
    type: 'elicitation_prompt',
    data: {
      elicitationId,
      message,
      requestedSchema,
      timeoutMs: SESSIONS.INTERACTION_TIMEOUT_MS,
    },
  });
  session.eventQueueNotify?.();

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      session.pendingInteractions.delete(elicitationId);
      resolve({ action: 'cancel' });
    }, SESSIONS.INTERACTION_TIMEOUT_MS);

    session.pendingInteractions.set(elicitationId, {
      type: 'elicitation',
      toolCallId: elicitationId,
      resolve: (result) => {
        clearTimeout(timeout);
        session.pendingInteractions.delete(elicitationId);
        resolve(result);
      },
      reject: () => {
        clearTimeout(timeout);
        session.pendingInteractions.delete(elicitationId);
        resolve({ action: 'cancel' });
      },
      timeout,
    });
  });
}
```

**3. Client receives `elicitation_prompt` event**

The stream event handler adds a tool call entry with `interactiveType: 'elicitation'` and stores the schema.

**4. `MessageItem` renders `ElicitationPrompt`**

`ElicitationPrompt.tsx` generates form fields dynamically from the `requestedSchema` (string inputs, number inputs, checkboxes, selects). On submit, it calls:

```typescript
await transport.submitElicitation(sessionId, elicitationId, {
  action: 'submit',
  content: formValues,
});
```

To cancel:

```typescript
await transport.submitElicitation(sessionId, elicitationId, { action: 'cancel' });
```

**5. Transport resolves the deferred promise**

`POST /api/sessions/:id/submit-elicitation` calls `runtime.submitElicitation(sessionId, elicitationId, result)`, resolving the pending interaction. The MCP SDK receives the submitted values and the MCP server can proceed.

### Implementation Files

| File                                                            | Purpose                                                    |
| --------------------------------------------------------------- | ---------------------------------------------------------- |
| `services/runtimes/claude-code/interactive-handlers.ts`         | `handleElicitation()` — deferred promise, event queue push |
| `apps/server/src/routes/sessions.ts`                            | `POST /:id/submit-elicitation` route                       |
| `apps/client/src/layers/features/chat/ui/ElicitationPrompt.tsx` | Dynamic form renderer from JSON Schema                     |
| `packages/shared/src/schemas.ts`                                | `ElicitationPromptEventSchema`, `ElicitationResultSchema`  |

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
// ... READ_ONLY_TOOLS / DORKOS_AGENT_TOOLS auto-allow (module-level Sets) ...
if (session.permissionMode === 'default') {
  return handleToolApproval(session, context.toolUseID, toolName, input, context);
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

**Important:** Handle 409 responses in your transport method. The server returns 409 with `{ code: 'INTERACTION_ALREADY_RESOLVED' }` when the SDK resolves the interaction before the HTTP request arrives. Treat this as success in the client.

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

## Agent UI Control

Unlike interactive tools (which pause the SDK to wait for user input), agent UI control is a **fire-and-forget** system. The agent calls an MCP tool, the server emits an SSE event, and the client mutates its UI state immediately. The SDK is never blocked.

### `control_ui` MCP Tool

The `control_ui` tool is exposed on the external MCP server (`/mcp`) and available to any connected agent. It accepts a `UiCommand` -- a discriminated union on `action` with 14 variants:

| Action                 | Parameters                                                      | Effect                                  |
| ---------------------- | --------------------------------------------------------------- | --------------------------------------- |
| `open_panel`           | `panel`: `settings` / `tasks` / `relay` / `picker`              | Open a named panel                      |
| `close_panel`          | `panel`: (same as above)                                        | Close a named panel                     |
| `toggle_panel`         | `panel`: (same as above)                                        | Toggle a named panel                    |
| `open_sidebar`         | (none)                                                          | Open the sidebar                        |
| `close_sidebar`        | (none)                                                          | Close the sidebar                       |
| `switch_sidebar_tab`   | `tab`: `sessions` / `agents`                                    | Switch sidebar tab (also opens sidebar) |
| `open_canvas`          | `content`: `UiCanvasContent`, `preferredWidth?`: 20--80         | Open canvas panel with content          |
| `update_canvas`        | `content`: `UiCanvasContent`                                    | Update canvas content without reopening |
| `close_canvas`         | (none)                                                          | Close the canvas panel                  |
| `show_toast`           | `message`, `level?`: success/error/info/warning, `description?` | Show a toast notification               |
| `set_theme`            | `theme`: `light` / `dark`                                       | Switch the UI theme                     |
| `scroll_to_message`    | `messageId?` (omit for bottom)                                  | Scroll to a specific message            |
| `switch_agent`         | `cwd`: working directory path                                   | Switch to a different agent             |
| `open_command_palette` | (none)                                                          | Open the command palette                |

Canvas content (`UiCanvasContent`) is discriminated on `type`:

- `url` -- renders an iframe (`url`, optional `title`)
- `markdown` -- renders markdown (`markdown`, optional `title`)
- `json` -- renders formatted JSON (`data`, optional `title`)

The `UiCommand` schema is defined in `packages/shared/src/schemas.ts` and validated with Zod on both server and client.

### `get_ui_state` MCP Tool

The companion `get_ui_state` tool returns the current client UI state -- which panels are open, sidebar tab, canvas state, and active agent. Agents can call this after `control_ui` to verify the result, or to make UI-aware decisions.

### Data Flow

```
Agent calls control_ui MCP tool
  |
  |  1. Server validates command against UiCommandSchema
  |  2. Pushes StreamEvent { type: 'ui_command', data: { command } } to session.eventQueue
  |  3. Calls session.eventQueueNotify() to wake the generator
  |  4. Returns { success: true, action } to the agent immediately (no blocking)
  |
  v
sendMessage() generator drains queue, yields ui_command event
  |
  v
Client stream-event-handler.ts receives 'ui_command' event
  |
  |  Extracts the UiCommand from event data
  |  Gets the current Zustand store state
  |  Calls executeUiCommand(ctx, command)
  |
  v
UiActionDispatcher (shared/lib/ui-action-dispatcher.ts)
  |
  |  Pure side-effect dispatcher — switches on command.action
  |  Calls the appropriate store setter, toast, or handler
  |
  v
UI updates reactively via Zustand subscription
```

The `UiActionDispatcher` is a pure function with no React dependencies. It is callable from stream event handlers, keyboard shortcuts, and command palette actions with equal safety.

### UI State Awareness

The client can send a `uiState` snapshot with each `sendMessage()` request. This is an optional `uiState` field on `SendMessageRequest` (validated against `UiStateSchema`), which the server injects into the agent's system prompt as context. This gives agents situational awareness of what the user is currently viewing:

```typescript
// UiState shape (packages/shared/src/schemas.ts)
{
  canvas: { open: boolean, contentType: string | null },
  panels: { settings: boolean, tasks: boolean, relay: boolean },
  sidebar: { open: boolean, activeTab: 'sessions' | 'agents' | null },
  agent: { id: string | null, cwd: string | null },
}
```

This two-way channel -- `uiState` in (client tells agent what is visible) and `ui_command` out (agent tells client what to change) -- enables agents to make contextual UI decisions rather than issuing commands blindly.

### Key Differences from Interactive Tools

| Aspect          | Interactive Tools (AskUserQuestion, Tool Approval) | Agent UI Control (`control_ui`)            |
| --------------- | -------------------------------------------------- | ------------------------------------------ |
| Direction       | Agent asks user, waits for response                | Agent commands UI, no response expected    |
| SDK blocking    | Blocks via deferred promise until user responds    | Non-blocking, returns immediately          |
| Event queue     | Uses same `session.eventQueue` mechanism           | Uses same `session.eventQueue` mechanism   |
| Promise.race    | Yields event while SDK is blocked                  | Yields event alongside normal SDK messages |
| Transport layer | Requires resolve endpoint (POST)                   | No resolve endpoint needed                 |
| Timeout         | 10-minute timeout per interaction                  | No timeout (fire-and-forget)               |

### Implementation Files

| File                                                                  | Purpose                                                                  |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `packages/shared/src/schemas.ts`                                      | `UiCommandSchema`, `UiStateSchema`, `UiCanvasContentSchema` definitions  |
| `apps/server/src/services/runtimes/claude-code/mcp-tools/ui-tools.ts` | `control_ui` and `get_ui_state` MCP tool handlers                        |
| `apps/client/src/layers/shared/lib/ui-action-dispatcher.ts`           | `executeUiCommand()` -- pure dispatcher, no React dependencies           |
| `apps/client/src/layers/features/chat/model/stream-event-handler.ts`  | Processes `ui_command` SSE events and dispatches to `executeUiCommand()` |

## Key Patterns

### Deferred Promise Pattern

The core mechanism that bridges `canUseTool` (sync callback) with user interaction (async, delayed). Each handler creates a `Promise` and stores its `resolve`/`reject` functions in the `pendingInteractions` Map, keyed by `toolUseId`. When the user responds, the corresponding resolve function is called, which completes the original promise and unblocks the SDK.

The `PendingInteraction` type is a discriminated union on `type`, with each variant having a typed `resolve` function:

```typescript
interface PendingApproval {
  type: 'approval';
  toolCallId: string;
  resolve: (result: boolean | PermissionUpdate[]) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
  suggestions?: PermissionUpdate[]; // SDK permission suggestions for "Always Allow"
}

interface PendingQuestion {
  type: 'question';
  toolCallId: string;
  resolve: (answers: Record<string, string>) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface PendingElicitation {
  type: 'elicitation';
  toolCallId: string;
  resolve: (result: ElicitationResult) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
}

type PendingInteraction = PendingApproval | PendingQuestion | PendingElicitation;
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

### Force-Complete Safety Net

The stream `done` handler sweeps any remaining pending interactive tool calls to `'complete'` status. This ensures the UI never gets stuck in an interactive waiting state after the stream ends, even if a `tool_result` event was missed or arrived out of order.

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

## Hook Lifecycle Events

When users configure hooks in Claude Code, DorkOS surfaces their execution:

- **Tool-contextual hooks** (PreToolUse, PostToolUse, PostToolUseFailure) appear as sub-rows in ToolCallCard
- **Session-level hooks** (SessionStart, UserPromptSubmit, etc.) show in SystemStatusZone
- **Hook failures** are always visible — tool card stays expanded, session failures escalate to error banner

Hook events flow through the standard pipeline: `sdk-event-mapper.ts` → SSE → `stream-event-handler.ts` → `ToolCallCard`.

### Routing Logic

The `hook_event` field on each SDK message determines the rendering surface:

| `hook_event`                                          | Route           | Surface                         |
| ----------------------------------------------------- | --------------- | ------------------------------- |
| `PreToolUse`, `PostToolUse`, `PostToolUseFailure`     | Tool-contextual | Sub-row in ToolCallCard         |
| All others (`SessionStart`, `UserPromptSubmit`, etc.) | Session-level   | SystemStatusZone / error banner |

### Orphan Hook Handling

`PreToolUse` hooks may arrive before the associated `tool_call_start` event. These "orphan" hooks are buffered in `orphanHooksRef` (a `Map<string, HookPart[]>` keyed by `toolCallId`) and attached to the tool call when `tool_call_start` arrives.

### HookRow Visual States

| Status      | Icon              | Styling                                 |
| ----------- | ----------------- | --------------------------------------- |
| `running`   | Spinner (Loader2) | Muted                                   |
| `success`   | Check             | Muted                                   |
| `error`     | X                 | Destructive, auto-expands, shows stderr |
| `cancelled` | X                 | Muted                                   |

### Auto-Hide Suppression

When a tool call has any hook with `status === 'error'`, the tool card's auto-hide behavior is suppressed so users can inspect the failure. Tool cards with only successful hooks auto-hide normally.
