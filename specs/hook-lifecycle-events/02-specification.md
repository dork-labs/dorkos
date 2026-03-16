---
slug: hook-lifecycle-events
number: 141
created: 2026-03-16
status: specification
authors: [Claude Code]
---

# Surface SDK Hook Lifecycle Events in Chat UI

## Status

Specification

## Overview

Surface three silently-dropped SDK system message subtypes — `hook_started`, `hook_progress`, `hook_response` — so users can see when hooks execute, watch their output, and understand failures. This is P2 punch list item #7 from the Agent SDK Audit (matrix items #11–#13).

Hooks are user-configured scripts that fire around tool execution (pre-commit validators, linters) or session lifecycle events (session start, prompt submit). Today all three message types are silently dropped in `sdk-event-mapper.ts`, leaving users with zero visibility — if a hook takes 30 seconds or fails, the agent appears frozen.

**Approach: Hybrid routing** based on the `hook_event` field:

- **Tool-contextual hooks** (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`) render as compact sub-rows inside the `ToolCallCard` that triggered them.
- **Session-level hooks** (`SessionStart`, `UserPromptSubmit`, `PreCompact`, etc.) route through `SystemStatusZone` for success, escalate to a persistent `error` event on failure.

## Background / Problem Statement

The Claude Agent SDK emits lifecycle events when user-configured hooks execute. These hooks wrap tool calls (e.g., a pre-commit hook runs after an Edit tool call) or fire at session boundaries (e.g., a validation hook on prompt submit).

Currently:
1. `hook_started` arrives at `sdk-event-mapper.ts` as `{ type: 'system', subtype: 'hook_started' }`
2. The mapper's system message dispatch (lines 49–115) has no branch for `hook_started`, `hook_progress`, or `hook_response`
3. All three fall through silently — no log, no event, no trace

**User impact:** When a hook takes time (compiling, linting) or fails (pre-commit rejects), the agent appears frozen. Users have no way to distinguish "hook is running" from "agent is stuck." This undermines trust in long-running sessions where hooks are common.

## Goals

- Map all three hook SDK messages (`hook_started`, `hook_progress`, `hook_response`) through the server pipeline
- Render tool-contextual hooks as sub-rows inside the associated `ToolCallCard`
- Show hook failures with expandable stdout/stderr output
- Handle session-level hooks via existing `SystemStatusZone` and `error` event paths
- Follow the established schema → mapper → handler → component pipeline pattern

## Non-Goals

- Hook configuration UI (users configure hooks via Claude Code settings)
- `SDKHookCallbackMessage` handling (internal SDK callback mechanism, separate from lifecycle events)
- Specialized renderers for specific hook types (e.g., rich pre-commit output)
- Hook execution metrics, history, or JSONL persistence
- Hook-level auto-hide independent of parent tool card

## Technical Dependencies

- `@anthropic-ai/claude-agent-sdk` — SDK message types (already installed, confined to `services/runtimes/claude-code/`)
- `motion/react` — for AnimatePresence on HookRow expand/collapse
- `lucide-react` — status icons (Loader2, Check, X)

## Related ADRs

None directly applicable. The system-status-compact-boundary spec (`specs/system-status-compact-boundary/02-specification.md`) serves as the pipeline template.

## Detailed Design

### SDK Message Shapes (from `sdk.d.ts`)

```typescript
// Fires when a hook process starts
type SDKHookStartedMessage = {
  type: 'system';
  subtype: 'hook_started';
  hook_id: string;       // Correlation key across lifecycle
  hook_name: string;     // e.g., "pre-commit", "my-validator"
  hook_event: string;    // e.g., "PreToolUse", "PostToolUse", "SessionStart"
  uuid: string;
  session_id: string;
};

// Fires during execution — streams stdout/stderr
type SDKHookProgressMessage = {
  type: 'system';
  subtype: 'hook_progress';
  hook_id: string;
  hook_name: string;
  hook_event: string;
  stdout: string;
  stderr: string;
  output: string;        // Combined output
  uuid: string;
  session_id: string;
};

// Fires when the hook process exits
type SDKHookResponseMessage = {
  type: 'system';
  subtype: 'hook_response';
  hook_id: string;
  hook_name: string;
  hook_event: string;
  output: string;
  stdout: string;
  stderr: string;
  exit_code?: number;
  outcome: 'success' | 'error' | 'cancelled';
  uuid: string;
  session_id: string;
};
```

### Routing Logic

The `hook_event` field determines which rendering surface handles the event:

```typescript
const TOOL_CONTEXTUAL_HOOK_EVENTS = new Set([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
]);
```

| `hook_event` value | Route | Rendering surface |
|---|---|---|
| `PreToolUse` | Tool-contextual | Sub-row in ToolCallCard |
| `PostToolUse` | Tool-contextual | Sub-row in ToolCallCard |
| `PostToolUseFailure` | Tool-contextual | Sub-row in ToolCallCard |
| `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `Stop`, `SubagentStart`, `SubagentStop`, `PreCompact`, `Notification`, `PermissionRequest` | Session-level | SystemStatusZone (success) or error banner (failure) |

### Tool-Call Correlation

Tool-contextual hooks correlate to tool calls via `toolState.currentToolId` — the mapper already tracks the active tool call ID. When `hook_started` arrives with a tool-contextual `hook_event`, the mapper captures `toolState.currentToolId` as the associated tool.

**Edge case — PreToolUse timing:** For `PreToolUse` hooks, `hook_started` may arrive *before* the associated `tool_call_start`. If `toolState.currentToolId` is empty, emit the hook event with `toolCallId: null`. The client handler buffers orphan hooks and attaches them retrospectively when the next `tool_call_start` arrives (see Phase 3 below).

---

### Phase 1: Shared Schemas (`packages/shared/src/schemas.ts`)

Add three event types to the `StreamEventTypeSchema` enum (lines 29–55):

```typescript
// Add to the enum array, after 'compact_boundary':
'hook_started',
'hook_progress',
'hook_response',
```

Add three Zod schemas after `CompactBoundaryEventSchema` (line 387):

```typescript
export const HookStartedEventSchema = z
  .object({
    hookId: z.string(),
    hookName: z.string(),
    hookEvent: z.string(),
    toolCallId: z.string().nullable(),
  })
  .openapi('HookStartedEvent');

export type HookStartedEvent = z.infer<typeof HookStartedEventSchema>;

export const HookProgressEventSchema = z
  .object({
    hookId: z.string(),
    stdout: z.string(),
    stderr: z.string(),
  })
  .openapi('HookProgressEvent');

export type HookProgressEvent = z.infer<typeof HookProgressEventSchema>;

export const HookResponseEventSchema = z
  .object({
    hookId: z.string(),
    hookName: z.string(),
    exitCode: z.number().optional(),
    outcome: z.enum(['success', 'error', 'cancelled']),
    stdout: z.string(),
    stderr: z.string(),
  })
  .openapi('HookResponseEvent');

export type HookResponseEvent = z.infer<typeof HookResponseEventSchema>;
```

Add to the `StreamEventSchema` data union (lines 389–414):

```typescript
HookStartedEventSchema,
HookProgressEventSchema,
HookResponseEventSchema,
```

**Type re-exports** (`packages/shared/src/types.ts`): Add `HookStartedEvent`, `HookProgressEvent`, `HookResponseEvent` to the re-export block.

---

### Phase 2: Server Mapper (`apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts`)

Add three branches in the system message dispatch block (after `compact_boundary`, before line 116). These follow the exact same pattern as `status` and `compact_boundary`:

```typescript
// Handle hook lifecycle events
if (message.subtype === 'hook_started') {
  const msg = message as Record<string, unknown>;
  const hookEvent = msg.hook_event as string;
  const isToolContextual = TOOL_CONTEXTUAL_HOOK_EVENTS.has(hookEvent);

  if (isToolContextual) {
    yield {
      type: 'hook_started',
      data: {
        hookId: msg.hook_id as string,
        hookName: msg.hook_name as string,
        hookEvent,
        toolCallId: toolState.currentToolId || null,
      },
    };
  } else {
    yield {
      type: 'system_status',
      data: { message: `Running hook "${msg.hook_name as string}"...` },
    };
  }
  return;
}

if (message.subtype === 'hook_progress') {
  const msg = message as Record<string, unknown>;
  const hookEvent = msg.hook_event as string;
  const isToolContextual = TOOL_CONTEXTUAL_HOOK_EVENTS.has(hookEvent);

  if (isToolContextual) {
    yield {
      type: 'hook_progress',
      data: {
        hookId: msg.hook_id as string,
        stdout: msg.stdout as string,
        stderr: msg.stderr as string,
      },
    };
  }
  // Session-level progress: silent (no useful output to show mid-execution)
  return;
}

if (message.subtype === 'hook_response') {
  const msg = message as Record<string, unknown>;
  const hookEvent = msg.hook_event as string;
  const isToolContextual = TOOL_CONTEXTUAL_HOOK_EVENTS.has(hookEvent);

  if (isToolContextual) {
    yield {
      type: 'hook_response',
      data: {
        hookId: msg.hook_id as string,
        hookName: msg.hook_name as string,
        exitCode: msg.exit_code as number | undefined,
        outcome: msg.outcome as 'success' | 'error' | 'cancelled',
        stdout: msg.stdout as string,
        stderr: msg.stderr as string,
      },
    };
  } else if ((msg.outcome as string) === 'error') {
    // Session-level failure: escalate to persistent error
    yield {
      type: 'error',
      data: {
        message: `Hook "${msg.hook_name as string}" failed (${hookEvent})`,
        code: 'hook_failure',
        category: 'execution_error',
        details: (msg.stderr as string) || (msg.stdout as string),
      },
    };
  }
  // Session-level success: silent (already shown via system_status on start)
  return;
}
```

Add the constant at module scope:

```typescript
const TOOL_CONTEXTUAL_HOOK_EVENTS = new Set([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
]);
```

---

### Phase 3: Client Event Handler (`apps/client/src/layers/features/chat/model/stream-event-handler.ts`)

Add three switch cases to the event handler. These update tool call parts with hook state, following the same immutable-update pattern as `tool_call_delta` and `tool_progress`.

#### New HookState type (`apps/client/src/layers/features/chat/model/chat-types.ts`)

```typescript
export interface HookState {
  hookId: string;
  hookName: string;
  hookEvent: string;
  status: 'running' | 'success' | 'error' | 'cancelled';
  stdout: string;
  stderr: string;
  exitCode?: number;
}
```

Add `hooks?: HookState[]` to the `ToolCallState` interface.

#### Handler cases

```typescript
case 'hook_started': {
  const hook = data as HookStartedEvent;
  if (hook.toolCallId) {
    const existing = findToolCallPart(hook.toolCallId);
    if (existing) {
      existing.hooks = [
        ...(existing.hooks || []),
        {
          hookId: hook.hookId,
          hookName: hook.hookName,
          hookEvent: hook.hookEvent,
          status: 'running',
          stdout: '',
          stderr: '',
        },
      ];
      updateAssistantMessage(assistantId);
    }
  } else {
    // Orphan hook (PreToolUse before tool_call_start) — buffer it
    orphanHooksRef.current.push({
      hookId: hook.hookId,
      hookName: hook.hookName,
      hookEvent: hook.hookEvent,
      status: 'running',
      stdout: '',
      stderr: '',
    });
  }
  break;
}
case 'hook_progress': {
  const hp = data as HookProgressEvent;
  const hookPart = findHookById(hp.hookId);
  if (hookPart) {
    hookPart.stdout = hp.stdout;
    hookPart.stderr = hp.stderr;
    updateAssistantMessage(assistantId);
  }
  break;
}
case 'hook_response': {
  const hr = data as HookResponseEvent;
  const hookPart = findHookById(hr.hookId);
  if (hookPart) {
    hookPart.status = hr.outcome === 'success'
      ? 'success'
      : hr.outcome === 'cancelled'
        ? 'cancelled'
        : 'error';
    hookPart.exitCode = hr.exitCode;
    hookPart.stdout = hr.stdout;
    hookPart.stderr = hr.stderr;
    updateAssistantMessage(assistantId);
  }
  break;
}
```

#### Orphan hook attachment

Modify the existing `tool_call_start` case to attach any buffered orphan hooks:

```typescript
case 'tool_call_start': {
  const tc = data as ToolCallEvent;
  const orphans = orphanHooksRef.current.splice(0); // drain buffer
  currentPartsRef.current.push({
    type: 'tool_call',
    toolCallId: tc.toolCallId,
    toolName: tc.toolName,
    input: '',
    status: 'running',
    hooks: orphans.length > 0 ? orphans : undefined,
  });
  updateAssistantMessage(assistantId);
  break;
}
```

#### Helper function

Add a `findHookById` helper alongside the existing `findToolCallPart`:

```typescript
function findHookById(hookId: string): HookState | undefined {
  for (const part of currentPartsRef.current) {
    if (part.type === 'tool_call' && part.hooks) {
      const hook = part.hooks.find((h) => h.hookId === hookId);
      if (hook) return hook;
    }
  }
  return undefined;
}
```

#### New ref

Add `orphanHooksRef` to the handler's dependency injection:

```typescript
// In createStreamEventHandler deps
orphanHooksRef: React.MutableRefObject<HookState[]>,
```

Initialize in `use-chat-session.ts`:

```typescript
const orphanHooksRef = useRef<HookState[]>([]);
```

---

### Phase 4: UI Component — HookRow in ToolCallCard

Extend `ToolCallCard.tsx` to render hook sub-rows below the tool header. The `HookRow` component is small enough to live inline in `ToolCallCard.tsx` (keeps the tool card self-contained).

#### HookRow visual states

```
Running:
  ⟳ pre-commit                          (spinner icon, muted text)

Success (compact):
  ✓ pre-commit                           (green check, muted text)

Error (collapsed, clickable):
  ✗ pre-commit  failed                   (red X, destructive text)

Error (expanded):
  ✗ pre-commit  failed
  ┌─────────────────────────────────┐
  │ trailing-whitespace             │
  │ Found 1 offending file          │
  │ src/auth/session.ts             │
  │ exit code: 1                    │
  └─────────────────────────────────┘
```

#### HookRow component

```tsx
interface HookRowProps {
  hook: HookState;
}

function HookRow({ hook }: HookRowProps) {
  const [expanded, setExpanded] = useState(hook.status === 'error');
  const hasOutput = hook.stdout || hook.stderr;

  return (
    <div className="flex flex-col gap-0.5">
      <button
        className={cn(
          'flex items-center gap-1.5 py-0.5 text-3xs',
          hook.status === 'error'
            ? 'text-destructive'
            : 'text-muted-foreground',
        )}
        onClick={() => hasOutput && setExpanded(!expanded)}
        disabled={!hasOutput}
      >
        {hook.status === 'running' && <Loader2 className="size-3 animate-spin" />}
        {hook.status === 'success' && <Check className="size-3 text-muted-foreground" />}
        {hook.status === 'error' && <X className="size-3 text-destructive" />}
        {hook.status === 'cancelled' && <X className="size-3 text-muted-foreground" />}
        <span className="font-mono">{hook.hookName}</span>
        {hook.status === 'error' && <span>failed</span>}
        {hasOutput && (
          <ChevronDown
            className={cn('size-3 transition-transform', expanded && 'rotate-180')}
          />
        )}
      </button>
      <AnimatePresence>
        {expanded && hasOutput && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <pre className="rounded bg-muted p-2 font-mono text-3xs max-h-32 overflow-y-auto whitespace-pre-wrap">
              {hook.stderr || hook.stdout}
              {hook.exitCode !== undefined && `\nexit code: ${hook.exitCode}`}
            </pre>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
```

#### ToolCallCard integration

Inside `ToolCallCard`, render hook rows below the tool header (inside the card's border, before expanded content):

```tsx
{toolCall.hooks && toolCall.hooks.length > 0 && (
  <div className="border-t border-border/50 px-3 py-1 space-y-0.5">
    {toolCall.hooks.map((hook) => (
      <HookRow key={hook.hookId} hook={hook} />
    ))}
  </div>
)}
```

#### Auto-hide behavior

Hooks auto-hide with the parent `ToolCallCard` — no independent auto-hide logic needed. However, if any hook has `status === 'error'`, the tool card's auto-hide should be suppressed. This is enforced by modifying the `useToolCallVisibility` hook or adding a condition in the auto-hide logic:

```typescript
// In auto-hide decision logic
const hasFailedHook = toolCall.hooks?.some((h) => h.status === 'error');
const shouldAutoHide = !hasFailedHook && toolCall.status === 'complete';
```

---

### Phase 5: ToolCallPartSchema Extension

The shared `ToolCallPartSchema` in `packages/shared/src/schemas.ts` (lines 431–446) needs a `hooks` field so hook state survives the schema validation boundary:

```typescript
// Add to ToolCallPartSchema:
hooks: z.array(z.object({
  hookId: z.string(),
  hookName: z.string(),
  hookEvent: z.string(),
  status: z.enum(['running', 'success', 'error', 'cancelled']),
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().optional(),
})).optional(),
```

---

## User Experience

### Tool-contextual hooks (common case)

When a user has hooks configured (e.g., a `pre-commit` hook that runs after Edit tool calls):

1. Agent calls the Edit tool → ToolCallCard appears
2. Hook fires → a compact sub-row appears inside the card: `⟳ pre-commit`
3. Hook succeeds → row updates to `✓ pre-commit` (muted, compact)
4. ToolCallCard auto-hides → hook rows hide with it

If the hook fails:
1. Hook row updates to `✗ pre-commit  failed` with red styling
2. ToolCallCard stays expanded (auto-hide suppressed)
3. User clicks the hook row → expands to show stderr output and exit code
4. User understands what went wrong and can act

### Session-level hooks (less common)

When a user has a `SessionStart` or `UserPromptSubmit` hook:

1. Hook fires → ephemeral message in SystemStatusZone: `Running "my-validator"...`
2. Hook succeeds → status zone auto-dismisses after 4 seconds
3. Hook fails → persistent error banner: `Hook "my-validator" failed (UserPromptSubmit)` with stderr details

### No hooks configured

Zero visual change. No empty hook rows, no placeholder UI. The feature is invisible until hooks actually fire.

## Testing Strategy

### Unit tests: Server mapper

File: `apps/server/src/services/runtimes/claude-code/__tests__/sdk-event-mapper.test.ts`

Add a new `describe('hook lifecycle events', ...)` block following the existing test patterns:

1. **`hook_started` (tool-contextual) yields `hook_started` event** — Verify PreToolUse hook emits `hook_started` with `hookId`, `hookName`, `hookEvent`, `toolCallId` from `toolState.currentToolId`
2. **`hook_started` (session-level) yields `system_status` event** — Verify SessionStart hook emits `system_status` with human-readable message
3. **`hook_progress` (tool-contextual) yields `hook_progress` event** — Verify stdout/stderr forwarded
4. **`hook_progress` (session-level) yields nothing** — Silent
5. **`hook_response` (tool-contextual, success) yields `hook_response`** — Verify outcome, exit code
6. **`hook_response` (tool-contextual, error) yields `hook_response`** — Verify error outcome with stderr
7. **`hook_response` (session-level, error) yields `error` event** — Verify escalation to persistent error
8. **`hook_response` (session-level, success) yields nothing** — Silent
9. **`hook_started` with empty `currentToolId` yields `hook_started` with `toolCallId: null`** — Orphan hook edge case

### Unit tests: Client ToolCallCard

File: `apps/client/src/layers/features/chat/ui/__tests__/ToolCallCard.test.tsx`

Add hook-related tests following the existing `makeToolCall` pattern:

1. **Renders hook rows when hooks present** — Verify hook name text visible
2. **Running hook shows spinner icon** — Verify Loader2 icon
3. **Successful hook shows check icon** — Verify muted styling
4. **Failed hook shows X icon with destructive styling** — Verify red text
5. **Failed hook expands to show stderr** — Verify output visible after click
6. **No hook section rendered when hooks array empty** — Verify no border-t div

### Unit tests: Stream event handler

File: `apps/client/src/layers/features/chat/model/__tests__/stream-event-handler.test.ts` (new or append)

1. **`hook_started` adds hook to tool call's hooks array** — Verify HookState created with status 'running'
2. **`hook_progress` updates hook stdout/stderr** — Verify accumulation
3. **`hook_response` marks hook status** — Verify success/error/cancelled mapping
4. **Orphan hook attaches on next `tool_call_start`** — Verify buffer-then-attach

## Performance Considerations

- Hook rows are lightweight DOM elements (~50 bytes each). Even 10 hooks per tool call adds negligible overhead.
- Hook stdout/stderr uses the same `text-3xs` monospace rendering as existing progress output — no new rendering path.
- The `orphanHooksRef` buffer is drained on each `tool_call_start`, preventing unbounded growth.
- No new network requests, no new polling, no new timers.

## Security Considerations

- Hook output (stdout/stderr) is user-generated content from local hook processes. It renders in a `<pre>` tag (not HTML-interpreted), preventing XSS.
- No hook data is persisted to JSONL or sent to external services.
- Hook names and output are displayed as-is from the SDK — no sanitization needed beyond the `<pre>` rendering.

## Documentation

Update `contributing/interactive-tools.md` with a new section:

```markdown
### Hook Lifecycle Events

When users configure hooks in Claude Code, DorkOS surfaces their execution:

- **Tool-contextual hooks** (PreToolUse, PostToolUse) appear as sub-rows in ToolCallCard
- **Session-level hooks** (SessionStart, UserPromptSubmit, etc.) show in SystemStatusZone
- **Hook failures** are always visible — tool card stays expanded, session failures escalate to error banner

Hook events flow through the standard pipeline: `sdk-event-mapper.ts` → SSE → `stream-event-handler.ts` → `ToolCallCard`.
```

## Implementation Phases

### Phase 1: Schema + Mapper (Server)

- Add 3 event types to `StreamEventTypeSchema` enum
- Add 3 Zod schemas + type re-exports
- Add 3 `StreamEventSchema` union members
- Add 3 mapper branches with routing logic
- Add `TOOL_CONTEXTUAL_HOOK_EVENTS` constant
- Write 9 mapper unit tests

### Phase 2: Client Handler

- Add `HookState` interface to `chat-types.ts`
- Add `hooks?: HookState[]` to `ToolCallState`
- Add `hooks` field to `ToolCallPartSchema`
- Add `orphanHooksRef` to `use-chat-session.ts`
- Add `findHookById` helper to handler
- Add 3 switch cases (`hook_started`, `hook_progress`, `hook_response`)
- Modify `tool_call_start` case to drain orphan buffer
- Write 4 handler unit tests

### Phase 3: UI Component

- Add `HookRow` component inside `ToolCallCard.tsx`
- Render hook rows below tool header with border separator
- Add auto-hide suppression for failed hooks
- Write 6 component unit tests

### Phase 4: Documentation

- Update `contributing/interactive-tools.md`

## File Changes Summary

| File | Change | LOC (approx) |
|------|--------|------|
| `packages/shared/src/schemas.ts` | Add 3 enum values, 3 schemas, 3 union members, extend ToolCallPartSchema | +45 |
| `packages/shared/src/types.ts` | Add 3 type re-exports | +3 |
| `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts` | Add 3 system message branches + constant | +55 |
| `apps/client/src/layers/features/chat/model/chat-types.ts` | Add HookState interface, extend ToolCallState | +15 |
| `apps/client/src/layers/features/chat/model/stream-event-handler.ts` | Add 3 cases, findHookById, orphan logic | +55 |
| `apps/client/src/layers/features/chat/model/use-chat-session.ts` | Add orphanHooksRef | +3 |
| `apps/client/src/layers/features/chat/ui/ToolCallCard.tsx` | Add HookRow component, render hooks section | +65 |
| `contributing/interactive-tools.md` | Add Hook Lifecycle Events section | +15 |
| Tests (3 files) | Mapper, handler, component tests | +120 |
| **Total** | | **~376** |

## Open Questions

None — all design decisions were resolved during ideation (see `specs/hook-lifecycle-events/01-ideation.md` Section 6).

## References

- Ideation document: `specs/hook-lifecycle-events/01-ideation.md`
- Research report: `research/20260316_hook_lifecycle_events_ui_patterns.md`
- Prior art spec: `specs/system-status-compact-boundary/02-specification.md`
- Agent SDK Audit: `.temp/agent-sdk-audit.md` (matrix items #11–#13)
- SDK type definitions: `apps/server/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (lines 1511–1547)
