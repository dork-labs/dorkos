# Interactive Tools

## Overview

Interactive tools are tools that pause the Claude Agent SDK mid-execution to collect input from the user through the DorkOS UI, then resume the SDK with the user's response. They bridge the gap between the SDK's synchronous `canUseTool` callback and the asynchronous nature of a web-based UI where users need time to read, decide, and respond.

Two interactive tools exist today:

1. **AskUserQuestion** -- Claude asks the user structured questions with selectable options. The user picks answers, which are injected back into the tool's input before the SDK continues.
2. **Tool Approval** -- For every permission mode except `bypassPermissions` (which IS consent), a tool call not covered by a safe list pauses for the user to approve, always-allow, or deny execution. `resolveModeDecision` (`interactive-handlers.ts`) is the exhaustive mode → decision table.

The pattern is designed to be extensible. Any new tool that requires user interaction mid-stream can follow the same architecture.

Two more systems are separate but related, each with its own section below:

- **Agent UI Control** lets agents control the client UI without blocking the SDK. See [Agent UI Control](#agent-ui-control).
- **Capability Approval Holds** pause one of DorkOS's own destructive MCP tools in-session, independent of the SDK's `canUseTool` callback entirely. See [Capability Approval Holds](#capability-approval-holds).

## Architecture

The interactive tools pattern connects three layers: the SDK callback, the streaming generator, and the client UI. The key challenge is that `canUseTool` is a synchronous callback that must return a `Promise<PermissionResult>`, while the user response arrives later over HTTP or in-process transport.

**A prompt waits in two stages** (spec `ask-parks-on-timeout`). It counts down for `SESSIONS.INTERACTION_TIMEOUT_MS`, and past that it PARKS: the promise stays unresolved, the tool call stays held, and the person is told the agent is waiting. Only at `SESSIONS.INTERACTION_PARK_CEILING_MS` is the model handed a refusal. The whole wait — the entry shapes, both timers, the sentences and the log lines — lives in `messaging/interaction-wait.ts`; the handlers below just arm it. An unattended session (a scheduled task run) is the one exception and refuses at the countdown, because nobody is coming back to it.

Two rules follow, and both have teeth. Never arm a bare `setTimeout` for a prompt: use `armInteractionWait`. And never `clearTimeout` a captured local: use `clearInteractionTimer`, which reads the timer off the pending ENTRY, because parking replaces it.

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
AssistantMessageContent renders interactive component
  |
  |  QuestionPrompt or ApprovalPrompt
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
// services/runtimes/claude-code/messaging/interactive-handlers.ts
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
    // Two stages, not one: `armInteractionWait` parks the prompt at
    // SESSIONS.INTERACTION_TIMEOUT_MS (a notice, a log line, and a second timer)
    // and refuses only at SESSIONS.INTERACTION_PARK_CEILING_MS. See
    // `messaging/interaction-wait.ts`.
    const waitedMs = refusalDeadlineMs(session);
    const timeout = armInteractionWait(
      session,
      toolUseId,
      {
        parked: questionParkedNotice(questions),
        expired: questionTimeoutNotice(describeWaited(waitedMs)),
      },
      { kind: 'question' },
      () => resolve({ behavior: 'deny', message: questionTimeoutDenial(waitedMs) })
    );

    session.pendingInteractions.set(toolUseId, {
      type: 'question',
      toolCallId: toolUseId,
      resolve: (answers) => {
        // Reads the timer off the ENTRY: parking replaces it, so a closure over
        // the first timer would leave the ceiling armed on an answered prompt.
        clearInteractionTimer(session, toolUseId);
        session.pendingInteractions.delete(toolUseId);
        // `answers` arrive in DorkOS's canonical (index-keyed) format. The SDK's
        // AskUserQuestion executor matches answers to questions BY QUESTION TEXT,
        // so we translate before injecting — otherwise the model is told the user
        // did not answer. See sessions/question-answers.ts.
        resolve({
          behavior: 'allow',
          updatedInput: { ...input, answers: toSdkQuestionAnswers(answers, questions) },
        });
      },
      reject: () => {
        clearInteractionTimer(session, toolUseId);
        session.pendingInteractions.delete(toolUseId);
        resolve({ behavior: 'deny', message: 'Interaction cancelled' });
      },
      timeout,
    });
  });
}
```

**3. Client receives `question_prompt` event**

In `model/stream/stream-tool-handlers.ts`, `handleQuestionPrompt` pushes a tool-call part with `interactiveType: 'question'` onto `currentPartsRef` (reusing the part if one already exists for the `toolCallId`):

```typescript
// model/stream/stream-tool-handlers.ts
export function handleQuestionPrompt(helpers, data, assistantId) {
  const question = data as QuestionPromptEvent;
  const existing = helpers.findToolCallPart(question.toolCallId);
  if (existing) {
    existing.interactiveType = 'question';
    existing.questions = question.questions;
    existing.status = 'pending';
  } else {
    helpers.currentPartsRef.current.push({
      type: 'tool_call',
      toolCallId: question.toolCallId,
      toolName: 'AskUserQuestion',
      input: '',
      status: 'pending',
      interactiveType: 'question',
      questions: question.questions,
    });
  }
  helpers.updateAssistantMessage(assistantId);
}
```

**4. The message UI renders `QuestionPrompt`**

`QuestionPrompt` is rendered from `ui/message/AssistantMessageContent.tsx` (inline, when a tool-call part has `interactiveType === 'question'` and `questions`) and from `widgets/session/ui/SessionAsks.tsx` (the prompt that takes the composer). There is no row-level switch — `interactiveType` is matched at the part level:

```typescript
// ui/message/AssistantMessageContent.tsx
if (toolPart.interactiveType === 'question' && toolPart.questions) {
  return (
    <QuestionPrompt
      sessionId={sessionId}
      toolCallId={toolPart.toolCallId}
      questions={toolPart.questions}
      answers={toolPart.answers ?? (toolPart.status !== 'pending' ? {} : undefined)}
      onDecided={
        onToolDecided ? (answers) => onToolDecided(toolPart.toolCallId, answers) : undefined
      }
    />
  );
}
```

**5. User selects options and submits**

`QuestionPrompt` renders radio buttons (single-select) or checkboxes (multi-select) for each question's options, plus an "Other" free-text option. On submit, it builds an answers record in the **canonical format** and calls the transport:

```typescript
await transport.submitAnswers(sessionId, toolCallId, answers);
onDecided?.(answers); // Optimistically clear waiting state, with the canonical answers
```

`onDecided` receives the canonical (index-keyed) answers so the chat model can persist them onto the tool-call part (`part.answers = answers`, see `markToolCallResponded` in `model/use-session-submit.ts`) — this keeps the answered row specific even if the message remounts before history reloads.

Both `QuestionPrompt` and `ApprovalPrompt` treat HTTP 409 (`INTERACTION_ALREADY_RESOLVED`) as success — this handles the race condition where the SDK resolves the interaction before the client's HTTP request arrives.

**Single vs. multi-question UX.** A single-question prompt renders the one question directly with a Submit button. A multi-question prompt instead renders a step indicator (the question's `header`, falling back to `Question N of M`) plus Back/Next navigation, showing one question at a time. `submit()` advances to the next question on each Enter and only calls the transport once the final question is reached, so the user answers the questions sequentially before anything is submitted.

**Collapsed answer summary.** After submission, `QuestionAnswerSummary` (`ui/tools/QuestionAnswerSummary.tsx`) renders the collapsed row: a single answer becomes one compact line (`Header: Value`), multiple answers become a stacked `<dl>` header/value grid, and an observing client with no recovered answers gets a generic `N questions answered` fallback. It prefers the persisted index-keyed `answers` and falls back to the submitting client's local `selections`, tolerating legacy JSON-array encodings of multi-select answers (decoded for multi-select questions only).

**6. Transport resolves the deferred promise**

The transport calls `runtime.submitAnswers(sessionId, toolCallId, answers)`, which finds the pending interaction and calls its `resolve(answers)` function. The Claude adapter translates the canonical answers into the SDK's format (see below) and resolves the original promise with `{ behavior: 'allow', updatedInput }`, and the SDK continues with the user's answers injected into the tool input.

### Answer format & runtime portability

Structured questions are a **runtime-neutral** primitive, so the format that crosses the
DorkOS boundary (the `question_prompt` event, `submitAnswers`, and persisted history) is
intentionally backend-agnostic — a future runtime reuses the same client UI and transport:

- **Question** — a `QuestionItem` (`@dorkos/shared`): `{ header, question, options[], multiSelect }`.
- **Canonical answers** — `Record<string, string>` keyed by question **index** (`"0"`, `"1"`, …,
  matching the event's `questions` order). Each value is the answer as a display string;
  multi-select selections are joined with `", "`. This is what `QuestionPrompt` submits, what
  `submitAnswers` receives, and what history replays.

The **only** place that knows the Claude SDK's quirks is
`runtimes/claude-code/sessions/question-answers.ts`:

- `toSdkQuestionAnswers(canonical, questions)` re-keys answers by **question text** (the SDK
  matches answers to questions by text, not index) for injection into `updatedInput`.
- `mapSdkAnswersToIndices(recorded, questions)` converts persisted SDK answers back to the
  canonical index-keyed form for history display (tolerating legacy index-keyed recordings).

A new runtime implements `submitAnswers` and translates the canonical answers however its
backend expects — nothing in `shared/`, the transport, or the client changes.

### Tool Approval

Full walkthrough for a mode that asks (every mode but `bypassPermissions`).

**1. SDK triggers `canUseTool`**

For any tool that is not `AskUserQuestion`, and is not in the auto-approved sets (read-only Claude Code tools and DorkOS agent tools), the `createCanUseTool` callback consults `resolveModeDecision(session.permissionMode)`; when it returns `'ask'`, the callback calls `handleToolApproval`. Only `bypassPermissions` returns `'allow'` — every other mode (`default`, `acceptEdits`, `auto`, `plan`, `dontAsk`) asks, each for its own reason (see the TSDoc on `resolveModeDecision`). The auto-approved tool sets are defined as module-level `Set` constants (`READ_ONLY_TOOLS` and `DORKOS_AGENT_TOOLS`) to avoid per-call reconstruction. Read-only tools (`Read`, `Grep`, `Glob`, `LS`, `NotebookRead`, `WebSearch`, `WebFetch`) are always auto-approved regardless of permission mode.

`DORKOS_AGENT_TOOLS` is **not** `mcp__dorkos__*`. It is a hand-written set of exactly **21** prefixed names, listed in `interactive-handlers.ts`: the six room verbs (`post_to_room`, `react_to_room_entry`, `read_room_history`, `search_room_history`, `list_member_rooms`, `search_member_rooms`), five Relay tools (`relay_notify_user`, `relay_send`, `relay_inbox`, `relay_list_endpoints`, `relay_register_endpoint`), six Mesh tools (`mesh_list`, `mesh_inspect`, `mesh_discover`, `mesh_register`, `mesh_status`, `mesh_query_topology`), `get_agent`, `memory_write`, and the two UI-control tools (`control_ui`, `get_ui_state`). Every other DorkOS tool prompts like any other MCP tool. The exclusions are deliberate: all three destructive actions are absent (`tasks_delete`, `mesh_unregister`, and `marketplace.uninstall` via its `marketplace_uninstall` tool), and so are `config_patch` and the other seven `marketplace_*` tools. `core/__tests__/mcp-tool-gate.test.ts` asserts every name in the set is a real tool and that none is `destructive`, so promoting a tool in `mcp-tool-tiers.ts` without removing it here fails. Do not widen the set to a prefix, and do not derive it from `act` + `observe`: either change would auto-approve tools nobody chose, which is fail-open on the one axis that costs something. The `interactive-handlers.ts` TSDoc has the full argument.

Membership is **necessary but not sufficient** (DOR-625). `isAutoAllowedCall(toolName, input)` has the last word, and one member needs it: `control_ui` is a multiplexer — one tool name carrying 22 different effects chosen by its `action` argument. Twenty-one only move pixels; `apply_layout` drives the cockpit to `POST /api/shapes/:name/apply`, which creates that Shape's schedules **enabled**, carrying the permission mode the Shape's manifest chose (`bypassPermissions` included). It was auto-allowed under a comment claiming the UI tools have "no system access", which was false for that one action, in every permission mode including `default`.

The verdict per action lives in `UI_COMMAND_REACH` (`@dorkos/shared/schemas`, right beside `UiCommandSchema`), a total `Record` over the command union, so adding a UI command without classifying it is a `tsc` error in the file you are already editing. **`reaches-the-machine` is the default answer; pick `client-only` only when the client's handler touches nothing but local UI state.** A call the union cannot parse is not auto-allowed either — no rule is never consent. Two tests hold the halves that neither package can see alone: `core/__tests__/mcp-tool-gate.test.ts` pins that the classification is total, and `apps/client/.../__tests__/ui-action-dispatcher.test.ts` drives the real dispatcher and fails if a `client-only` command reaches a server mutation.

If you add another multiplexer tool to the auto-allow set, classify its branches the same way rather than reasoning about the tool name.

**2. `handleToolApproval` creates the event and deferred promise**

`handleToolApproval` now receives a `ToolApprovalContext` parameter (exported from `interactive-handlers.ts`) containing SDK-provided context fields and an `AbortSignal`:

```typescript
// services/runtimes/claude-code/messaging/interactive-handlers.ts
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
      clearInteractionTimer(session, toolUseId);
      session.pendingInteractions.delete(toolUseId);
      deny('Tool approval aborted');
    };
    context.signal.addEventListener('abort', onAbort, { once: true });

    // Parks at SESSIONS.INTERACTION_TIMEOUT_MS, refuses at
    // SESSIONS.INTERACTION_PARK_CEILING_MS (`messaging/interaction-wait.ts`).
    const waitedMs = refusalDeadlineMs(session);
    const timeout = armInteractionWait(
      session,
      toolUseId,
      {
        parked: approvalParkedNotice(toolLabel),
        expired: approvalTimeoutNotice(toolLabel, describeWaited(waitedMs)),
      },
      { kind: 'approval', toolName },
      () => {
        context.signal.removeEventListener('abort', onAbort);
        deny(approvalTimeoutDenial(waitedMs));
      }
    );

    session.pendingInteractions.set(toolUseId, {
      type: 'approval',
      toolCallId: toolUseId,
      suggestions: context.suggestions,
      resolve: (result) => {
        clearInteractionTimer(session, toolUseId);
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
        clearInteractionTimer(session, toolUseId);
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

**4. `AssistantMessageContent` renders `ApprovalPrompt`**

```typescript
// ui/message/AssistantMessageContent.tsx
if (tc.interactiveType === 'approval') {
  return <ApprovalPrompt sessionId={sessionId} toolCallId={tc.toolCallId} toolName={tc.toolName} input={tc.input} />;
}
```

**5. User clicks Approve, Always Allow, or Deny**

`ApprovalPrompt` shows the tool name, pretty-printed input JSON, SDK context fields (title, description, blocked path, decision reason), risk-level visual differentiation (high/medium/low Shield icon colors), and up to three buttons. On click:

```typescript
// Approve
await transport.approveTool(sessionId, toolCallId);
onDecided?.(); // Optimistically update indicator (see below)

// Always Allow (Shift+Enter keyboard shortcut)
// Only shown when hasSuggestions is true (SDK provided permission suggestions)
await transport.approveTool(sessionId, toolCallId, { alwaysAllow: true });
onDecided?.();

// Deny — "Add a reason" reveals an optional one-line field on the card, and
// whatever is in it rides along (Enter in the field denies; the card's bare
// Enter shortcut stands down while a field has focus, so it cannot approve).
await transport.denyTool(sessionId, toolCallId, reason);
onDecided?.();
```

When several tool approvals are pending at once, they collapse into one **burst card** (`AskStack`, `features/ask`) whose Allow all / Deny all answer the lot in a single call. It replaced `BatchApprovalBar` in DOR-1330; the two transport calls are unchanged:

```typescript
// Batch approve all pending
await transport.batchApproveTool(sessionId, toolCallIds);

// Batch deny all pending
await transport.batchDenyTool(sessionId, toolCallIds);
```

**6. Optimistic indicator update via `markToolCallResponded`**

After the user clicks Approve or Deny, the transport call resolves the server-side promise — but the server's `tool_result` event can take seconds for slow tools (e.g., Bash). Without an optimistic update, the `InferenceIndicator` would stay stuck on "Waiting for your approval" during that gap.

The fix: `ApprovalPrompt` receives an `onDecided` callback (threaded from `useChatSession` → `ChatPanel` → `SessionTranscript` → `SessionMessage` → `MessageContext` → `AssistantMessageContent` → `ApprovalPrompt`). This calls `markToolCallResponded(toolCallId)`, which immediately sets the tool call part's status from `'pending'` to `'running'` in the message state:

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

Both `approveTool` and `denyTool` call `runtime.approveTool(sessionId, toolCallId, approved, options)` with `true` or `false`; `options` carries `alwaysAllow` on an approval and `denyReason` on a refusal. The pending interaction's `resolve(approved, denyReason)` is called, returning `{ behavior: 'allow' }` or `{ behavior: 'deny', message }` to the SDK — where `message` names the reason when one was given, which is what lets the agent adjust rather than retry.

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
    const waitedMs = refusalDeadlineMs(session);
    const timeout = armInteractionWait(
      session,
      elicitationId,
      {
        parked: elicitationParkedNotice(serverName),
        expired: elicitationTimeoutNotice(serverName, describeWaited(waitedMs)),
      },
      { kind: 'elicitation' },
      () => resolve({ action: 'decline' })
    );

    session.pendingInteractions.set(elicitationId, {
      type: 'elicitation',
      toolCallId: elicitationId,
      resolve: (result) => {
        clearInteractionTimer(session, elicitationId);
        session.pendingInteractions.delete(elicitationId);
        resolve(result);
      },
      reject: () => {
        clearInteractionTimer(session, elicitationId);
        session.pendingInteractions.delete(elicitationId);
        resolve({ action: 'decline' });
      },
      timeout,
    });
  });
}
```

**3. Client receives `elicitation_prompt` event**

The stream event handler adds a tool call entry with `interactiveType: 'elicitation'` and stores the schema.

**4. `AssistantMessageContent` renders `ElicitationPrompt`**

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

| File                                                              | Purpose                                                                     |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `services/runtimes/claude-code/messaging/interactive-handlers.ts` | `handleElicitation()` — deferred promise, event queue push                  |
| `services/runtimes/claude-code/messaging/interaction-wait.ts`     | The pending-entry shapes, the park/refusal timers, the notices and the logs |
| `apps/server/src/routes/sessions.ts`                              | `POST /:id/submit-elicitation` route                                        |
| `apps/client/src/layers/features/chat/ui/ElicitationPrompt.tsx`   | Dynamic form renderer from JSON Schema                                      |
| `packages/shared/src/schemas.ts`                                  | `ElicitationPromptEventSchema`, `ElicitationResultSchema`                   |

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
// apps/server/src/services/runtimes/claude-code/messaging/interactive-handlers.ts

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
    // Every new kind gets the two-stage wait for free: park at the countdown,
    // refuse at the ceiling. Never arm a bare `setTimeout` here.
    const timeout = armInteractionWait(
      session,
      toolUseId,
      {
        parked: 'I asked for something and nobody has answered yet, so I am waiting here.',
        expired: 'Nobody answered, so I moved on.',
      },
      { kind: 'my_new_type' }, // Add to the log's kind union too
      () => resolve({ behavior: 'deny', message: 'Timed out' })
    );

    session.pendingInteractions.set(toolUseId, {
      type: 'my_new_type', // Add to PendingInteraction type union
      toolCallId: toolUseId,
      resolve: (result) => {
        clearInteractionTimer(session, toolUseId);
        session.pendingInteractions.delete(toolUseId);
        resolve({ behavior: 'allow', updatedInput: { ...input, result } });
      },
      reject: () => {
        clearInteractionTimer(session, toolUseId);
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
if (resolveModeDecision(session.permissionMode) === 'ask') {
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

Follow the patterns in `QuestionPrompt.tsx` and `ApprovalPrompt.tsx`.

### Step 7: Wire into `AssistantMessageContent`

A session row is `widgets/session/ui/SessionMessage.tsx`, and it draws no tool cards itself: the row is the shared `Message.*` chrome (`features/conversation`), and everything inside it comes from the session's body renderer, `widgets/session/ui/render-session-body.tsx`. That renderer splits by role only — `UserMessageContent` for what the reader typed, `AssistantMessageContent` for everything else — so an interactive tool is wired into `AssistantMessageContent`, one part at a time:

```typescript
// apps/client/src/layers/features/chat/ui/message/AssistantMessageContent.tsx
if (toolPart.interactiveType === 'my_new_type') {
  return <MyNewInteractive key={toolPart.toolCallId} sessionId={sessionId} toolCallId={toolPart.toolCallId} /* ... */ />;
}
```

The keyboard props your component may need — `activeToolCallId`, `onToolRef`, `focusedOptionIndex` — are not passed down as props. `SessionMessage` puts them on `MessageContext`, and `AssistantMessageContent` reads them with `useMessageContext()`.

## Agent UI Control

Unlike interactive tools (which pause the SDK to wait for user input), agent UI control is a **fire-and-forget** system. The agent calls an MCP tool, the server emits an SSE event, and the client mutates its UI state immediately. The SDK is never blocked.

### `control_ui` MCP Tool

The `control_ui` tool is exposed on the external MCP server (`/mcp`) and available to any connected agent. It accepts a `UiCommand` -- a discriminated union on `action` with 22 variants:

| Action                 | Parameters                                                       | Effect                                                                                                                                                                                                                                 |
| ---------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open_panel`           | `panel`: `settings` / `tasks` / `relay` / `picker`               | Open a named panel                                                                                                                                                                                                                     |
| `close_panel`          | `panel`: (same as above)                                         | Close a named panel                                                                                                                                                                                                                    |
| `toggle_panel`         | `panel`: (same as above)                                         | Toggle a named panel                                                                                                                                                                                                                   |
| `open_sidebar`         | (none)                                                           | Open the sidebar                                                                                                                                                                                                                       |
| `close_sidebar`        | (none)                                                           | Close the sidebar                                                                                                                                                                                                                      |
| `switch_sidebar_tab`   | `tab`: `overview` / `sessions` / `schedules` / `connections`     | Switch the sidebar tab — embedded (Obsidian) app only; a no-op on the web cockpit                                                                                                                                                      |
| `open_canvas`          | `content?`: `UiCanvasContent`, `preferredWidth?`: 20--80         | Open canvas panel with content                                                                                                                                                                                                         |
| `update_canvas`        | `content`: `UiCanvasContent`                                     | Update canvas content without reopening                                                                                                                                                                                                |
| `close_canvas`         | (none)                                                           | Close the canvas panel                                                                                                                                                                                                                 |
| `open_pip`             | `title?`: label for the panel                                    | Pop the session's newest inline `dorkos-ui` widget into the floating picture-in-picture panel (bottom sheet on phones); the panel follows the live fence                                                                               |
| `close_pip`            | (none)                                                           | Close the picture-in-picture panel                                                                                                                                                                                                     |
| `open_file`            | `sourcePath`: cwd-confined file path                             | Open a file as a new canvas document (viewer picked by mime type)                                                                                                                                                                      |
| `open_diff`            | `sourcePath`: cwd-confined file path                             | Open a `diff` canvas doc of the agent's edits, with per-hunk accept/reject                                                                                                                                                             |
| `open_terminal`        | `cwd?`: advisory working-directory hint                          | Open or focus the session's Terminal tab                                                                                                                                                                                               |
| `browser_navigate`     | `url`: external, `localhost`, or cwd-confined file path          | Open the page as a new embedded-browser canvas document                                                                                                                                                                                |
| `show_toast`           | `message`, `level?`: success/error/info/warning, `description?`  | Show a toast notification                                                                                                                                                                                                              |
| `set_theme`            | `theme`: `light` / `dark`                                        | Switch the UI theme                                                                                                                                                                                                                    |
| `scroll_to_message`    | `messageId?` (omit for bottom)                                   | Scroll to a specific message                                                                                                                                                                                                           |
| `switch_agent`         | `cwd`: working directory path                                    | Switch to a different agent                                                                                                                                                                                                            |
| `apply_layout`         | `shape`: installed Shape name                                    | Apply a Shape's layout via the server-side apply-shape flow (manifest resolution, connection prompts, per-piece degradation) — **reaches the machine**: can enable that Shape's schedules under the permission mode its manifest chose |
| `open_command_palette` | (none)                                                           | Open the command palette                                                                                                                                                                                                               |
| `celebrate`            | `kind?`: celebration style, `emoji?`: glyph for the `emoji` kind | Throw a confetti/celebration effect                                                                                                                                                                                                    |

Canvas content (`UiCanvasContent`) is discriminated on `type`:

- `url` -- renders an iframe (`url`, optional `title`)
- `markdown` -- renders markdown (`markdown`, optional `title`)
- `json` -- renders formatted JSON (`data`, optional `title`)

The `markdown` canvas is **user-editable**. It renders through one [Blintz](https://www.npmjs.com/package/blintz) editor (our React port of Milkdown's Crepe), read-only in view and editable behind a pencil toggle, with edits autosaved per session. Because the editor and the agent are two writers of the same canvas entry, agent content pushes are **suppressed while the user is editing**: `open_canvas` / `update_canvas` skip the `markdown` content write when the store's `canvasEditing` flag is set (the panel still reveals; only the content replacement is held). `blintz` is consumed from npm; for an in-flight Blintz change, `yalc` overlays a local build (`.yalc/` and `yalc.lock` are gitignored, the dep stays on the published version). See ADR-0290 / 0291 / 0292.

The `UiCommand` schema is defined in `packages/shared/src/schemas.ts` and validated with Zod on both server and client.

### `get_ui_state` MCP Tool

The companion `get_ui_state` tool returns the current client UI state -- which panels are open, sidebar tab, canvas state, and active agent. Agents can call this after `control_ui` to verify the result, or to make UI-aware decisions.

### DevTools Bridge Tools

Three more in-process MCP tools (DOR-213) give the agent read access to what the embedded browser preview captured, so it can check its own work without a human relaying an error message. They live alongside `control_ui`/`get_ui_state` in `apps/server/src/services/runtimes/claude-code/mcp-tools/devtools-tools.ts`.

| Tool                   | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser_read_console` | Reads the session's captured `console.*` output plus uncaught errors and unhandled promise rejections, with stack traces. Optional `level` filter (`all` / `error` / `warn` / `info` / `log` / `debug`, default `all`) and `limit` (default 50, capped at the 500-entry server ring).                                                                                                                                           |
| `browser_read_network` | Reads captured `fetch`/XHR calls: method, URL, status, timing, response size. Optional `status` filter (`all` / `failed` / `2xx` / `3xx` / `4xx` / `5xx`, default `all`; `failed` = network error (status 0) or 4xx/5xx — redirects don't count) and `limit` (default 50, capped at the 200-entry server ring).                                                                                                                 |
| `browser_screenshot`   | Captures a screenshot of the live preview as currently rendered, scaled to at most 1568px on its long edge. On-demand round trip: pushes a `devtools_capture_request` StreamEvent to the client over the same seam `control_ui` uses, the in-page shim rasterizes its own document, and the PNG returns through the normal ingest path tagged with a request id. Times out after 8s with a structured note rather than hanging. |

All three resolve their session id at call time (not registration time) and require an attached interactive session with a preview already open (`browser_navigate` opens one); without either, they return a structured error/note instead of fabricating a result. Results are bounded three ways so a chatty preview can't blow up the agent's context window: the per-call `limit`, a ~2KB per-field elision cap on oversized `text`/`stack`/`args`, and a ~64KB total serialized budget per result (newest entries win) — truncation is always reported via a `truncated` flag and an explanatory `note`.

The capture buffer is fed by an injected in-page shim that posts the preview's `console.*` and `fetch`/XHR activity to `window.parent`, which the client relays to `POST /api/sessions/:id/devtools/ingest`; the per-session `DevtoolsCaptureStore` rings retain it. These three tools only **read** that store — they never touch the page or the injection path.

**Claude Code only.** Codex reaches DorkOS through an external, session-less MCP server, so a tool there can't resolve which session's buffer to read — unlike the fire-and-forget `control_ui` write, a read tool must return the captured data in its result, which a session-less stub can't produce. These tools are registered only on the in-process claude-code tool server and are structurally absent from the Codex `dorkos_ui` server.

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

## Capability Approval Holds

A third, separate system covers DorkOS's own destructive MCP tools -- the ones the [action approvals](../docs/guides/action-approvals.mdx) guide describes for end users, such as `tasks_delete`, `mesh_unregister`, `config_patch`, and `marketplace.uninstall`, gated by `services/core/capabilities/tier-enforcement.ts`. It shares nothing with the SDK's `canUseTool` pattern above: there is no `pendingInteractions` entry and no deferred promise on the session.

Before DOR-939, a held capability call returned `approval_required` immediately and ended the turn -- the operator approved on the dashboard, then had to tell the agent to retry. Now the call can HOLD instead (`capability-approval-hold.ts`, spec `approvals-resume-inline`): it pushes the same `PendingApproval` the dashboard renders as a `capability_approval_required` event onto the session, waits up to ten minutes for the operator's decision, and on a grant resumes the held call and returns the real result in the SAME turn -- no retry needed.

The client folds `capability_approval_required`/`capability_approval_resolved` into an inline `capability_approval` message part (`capability-approval-fold.ts`), so approving the request from the chat transcript, the top bar, or Home all resolve the SAME `approvalId`. A `timeout` outcome (the hold's ten minutes ran out before the operator answered) is the one case the card does NOT retire on resolution -- it stays as a terminal note, because the request is still sitting in the approvals list and retiring the card would delete the only thing on screen pointing at a decision still owed (`CapabilityApprovalTimedOut.tsx`).

### Implementation Files

| File                                                                             | Purpose                                                                                                |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `apps/server/src/services/core/capabilities/capability-approval-hold.ts`         | In-session hold-and-await: pushes the inline card, awaits the decision, resumes the held call on grant |
| `apps/server/src/services/core/capabilities/tier-enforcement.ts`                 | Which capabilities are gated at which tier                                                             |
| `packages/shared/src/approval-schemas.ts`                                        | `PendingApproval` schema shared by the dashboard card and the inline card                              |
| `apps/client/src/layers/features/chat/model/stream/capability-approval-fold.ts`  | Folds the hold's events into the inline `capability_approval` message part                             |
| `apps/client/src/layers/features/chat/ui/message/CapabilityApprovalTimedOut.tsx` | Terminal note rendered when the hold's ten minutes run out unanswered                                  |

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

The `turn_end` reconcile reloads canonical history and clears the in-progress turn, and `interaction_resolved` settles any part still rendered as pending. This ensures the UI never gets stuck in an interactive waiting state after the turn ends, even if a `tool_result` event was missed or arrived out of order.

### Timeout Visibility

The `ApprovalPrompt` component makes the server-side timeout visible to users via a countdown timer. The `approval_required` event on the session stream carries server-authoritative `startedAt`/`remainingMs` fields, which flow through the stream event handler to the component.

**Visual indicators:**

- A thin progress bar (4px) drains over the timeout duration via CSS `@keyframes drain` animation (GPU-composited, zero JS cost)
- Bar color transitions: neutral → amber at 2 minutes remaining → red at 1 minute remaining
- Text countdown (`M:SS remaining`) appears only in the final 2 minutes
- On timeout: card transitions to denied state with explanation message

**Accessibility:**

- Progress bar has `role="progressbar"` with `aria-valuemin`, `aria-valuemax`, `aria-valuenow`, and `aria-valuetext`
- Screen reader announcements via `aria-live="assertive"` fire only at threshold crossings (2 min, 1 min, timeout)
- `prefers-reduced-motion` respected via `motion-safe:` Tailwind prefix — animation disabled, color transitions remain

**Data flow:** Server `handleToolApproval()` → `approval_required` event on the session stream (server-authoritative `startedAt`/`remainingMs`, seeded from `SESSIONS.INTERACTION_TIMEOUT_MS`) → stream-event-handler passes to tool call part → `ApprovalPrompt` renders the countdown, resuming at the true offset on recovery.

### Recovering Pending Interactions

Pending interactions are **transient server state**. Each lives only in the per-session `pendingInteractions` map alongside a live deferred `canUseTool` promise (see [Deferred Promise Pattern](#deferred-promise-pattern)). They are never written to JSONL, so without recovery the original prompt event — a one-shot `approval_required` / `question_prompt` / `elicitation_prompt` — would be gone the moment a client switches sessions, hard-refreshes, or never had the tab in the foreground. Recovery makes the prompt **re-presentable on (re)entry** without re-running the tool. See ADR-0264.

**Recovery is snapshot-based.** The durable `GET /api/sessions/:id/events` stream's `snapshot` frame carries `pendingInteractions: PendingInteractionDTO[]` — a cold connect (session switch, refresh, second surface, post-restart reconnect) rebuilds the card from it with no separate pull endpoint or re-emit pass. A resume connect (`Last-Event-ID`) skips the snapshot because the original interaction event is replayed from the gap instead. Live resolution emits `interaction_resolved` so every other subscribed client removes the card immediately.

The snapshot reads the selector `listPendingInteractions(entries, Date.now())` (`services/session/pending-interactions.ts`), shared by the Claude adapter's live interaction tracker and the projector's recovery records. Each entry carries a server-authoritative `startedAt` plus a freshly-computed `remainingMs`, so the countdown (see [Timeout Visibility](#timeout-visibility)) **resumes** rather than resetting on recovery.

**Idempotency.** The client renderer upserts each card by interaction id, so a snapshot followed by a replayed interaction event yields exactly **one** card and never re-executes the tool. The single-resolve guard in the approve/deny/respond pipeline makes a stale or duplicate response a benign no-op.

**Expiry exclusion.** `listPendingInteractions` drops any interaction whose `remainingMs <= 0` (the 10-minute timeout has already fired and resolved the promise with `{ behavior: 'deny' }`). The snapshot therefore never resurrects a card the server has already let lapse.

**Cross-restart boundary (no durability).** Recovery survives session switch, hard refresh, SSE reconnect, and background→foreground, but **not a server restart**. The `pendingInteractions` map is in-memory only and is the single source of truth; the deferred `canUseTool` promise is a live, non-serializable object that cannot be persisted or recreated. After a restart the query and its blocked tool call are gone, and the fresh snapshot simply carries no pending interactions — the operator must re-send. This accepted loss is the boundary set in ADR-0262 (superseded by ADR-0264); sessions themselves still derive from JSONL.

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
  questions: [/* ... */],
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
