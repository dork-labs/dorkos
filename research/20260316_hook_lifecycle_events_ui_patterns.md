---
title: 'Hook Lifecycle Events UI Patterns — Surfacing hook_started / hook_progress / hook_response in Chat'
date: 2026-03-16
type: external-best-practices
status: active
tags:
  [
    hook-lifecycle,
    chat-ui,
    tool-call-card,
    system-status,
    agent-sdk,
    subprocess-visibility,
    ux-patterns,
  ]
feature_slug: hook-lifecycle-events
searches_performed: 0
sources_count: 8
---

# Hook Lifecycle Events UI Patterns

## Research Summary

The Claude Agent SDK emits three `system` message subtypes around user-configured hook execution: `hook_started`, `hook_progress`, and `hook_response`. All three are currently silently dropped in `sdk-event-mapper.ts`. The SDK types are fully documented in the local `sdk.d.ts`. Hooks fire around tool execution (pre/post tool use) and session lifecycle events. The right UI treatment depends on the hook event type: hooks that fire around tool calls (the common case) should render as sub-items inside the existing `ToolCallCard`; hooks that fire around session/agent lifecycle events belong in the `SystemStatusZone` already built for `system/status` messages. Auto-hiding follows the tool call pattern on success, stays visible on failure.

---

## Key Findings

### 1. SDK Hook Message Shapes (Authoritative — from `sdk.d.ts`)

The three hook message types from `@anthropic-ai/claude-agent-sdk`:

```typescript
// Fires when a hook process starts executing
type SDKHookStartedMessage = {
  type: 'system';
  subtype: 'hook_started';
  hook_id: string; // Unique ID for this hook execution instance
  hook_name: string; // Name of the hook (e.g., "pre-commit", "my-validator")
  hook_event: string; // Which lifecycle event triggered it (e.g., "PreToolUse", "PostToolUse")
  uuid: string;
  session_id: string;
};

// Fires during execution — streams stdout/stderr from the hook process
type SDKHookProgressMessage = {
  type: 'system';
  subtype: 'hook_progress';
  hook_id: string;
  hook_name: string;
  hook_event: string;
  stdout: string; // Stdout output accumulated so far
  stderr: string; // Stderr output accumulated so far
  output: string; // Combined output
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
  exit_code?: number; // 0 = success, non-zero = failure
  outcome: 'success' | 'error' | 'cancelled';
  uuid: string;
  session_id: string;
};
```

**Key design insight**: The `hook_event` field tells us which lifecycle event triggered the hook — this is the critical routing field. Hooks that fire around tool calls (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`) are contextually linked to a specific tool call. Hooks for session lifecycle events (`SessionStart`, `SessionEnd`, `UserPromptSubmit`, `Stop`, `SubagentStart`, `SubagentStop`, `PreCompact`, `Notification`) are session-level events with no tool context.

**Also notable**: `hook_started` does NOT carry a `tool_use_id` — there is no direct `tool_use_id` link from the hook messages to the tool call. However, the existing `SDKHookCallbackMessage` does carry `tool_use_id`. The ordering in the stream is the practical link: `hook_started` arrives in temporal proximity to the `tool_call_start`/`tool_call_end` events for the tool it wraps.

**Correlating hooks to tool calls**: The mapper needs to track the "current tool" at the time the hook fires. Since hooks fire before or after a tool, the most recently-started (or just-completed) tool call in the stream is the associated tool. This is already tracked via `toolState.currentToolId` in the mapper.

### 2. What Events Trigger Hooks

From the SDK's `HookEvent` type:

```typescript
type HookEvent =
  | 'PreToolUse' // Before tool execution — the most common case for DorkOS users
  | 'PostToolUse' // After tool execution — also very common
  | 'PostToolUseFailure' // After failed tool execution
  | 'Notification' // Notification events
  | 'UserPromptSubmit' // When user prompt is submitted
  | 'SessionStart' // Session beginning
  | 'SessionEnd' // Session ending
  | 'Stop' // Agent stop
  | 'SubagentStart' // Subagent starting
  | 'SubagentStop' // Subagent stopping
  | 'PreCompact' // Before context compaction
  | 'PermissionRequest'; // Permission requests
```

**Tool-contextual hooks** (associated with a specific tool call): `PreToolUse`, `PostToolUse`, `PostToolUseFailure`
**Session-level hooks** (no tool context): `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `Stop`, `SubagentStart`, `SubagentStop`, `PreCompact`, `Notification`, `PermissionRequest`

### 3. Current Infrastructure Already in Place

The codebase already has:

- `sdk-event-mapper.ts`: handles `system/status` and `system/compact_boundary` — the exact same structure needed for `hook_started`/`hook_progress`/`hook_response`
- `toolState.currentToolId` and `toolState.currentToolName`: tracked mutable state passed into the mapper — available to correlate hooks to tool calls
- `ToolCallCard.tsx`: already has `progressOutput` and auto-expand on progress, rendering for `tool_progress` events
- `SystemStatusZone`: already built and live for ephemeral system status messages — immediately usable for session-level hooks
- `StreamEventTypeSchema`: can accept new enum members `hook_started`, `hook_progress`, `hook_response`

### 4. Visual Precedents for Subprocess/Hook Visibility

#### GitHub Actions — Log Groups

GitHub Actions shows nested subprocess execution as collapsible log groups inside the parent step. Each step has a header line showing status (running/pass/fail) and elapsed time. Subprocess output is shown inside a scrollable log area, collapsed by default when passed, expanded on failure or by user click.

Key UX rules from GA:

- Failures are never auto-hidden — they remain visible until dismissed
- Passing steps collapse automatically after a brief hold
- Stderr output gets orange/red background treatment inside the log area
- Exit codes are shown numerically alongside the outcome

#### VS Code Tasks Panel — Terminal Sub-processes

The VS Code Tasks panel shows sub-task execution inline with the parent task's terminal output. Each spawned process gets a collapsible panel inside the terminal showing its exit code, stderr, and stdout. Failed sub-processes display a red badge with the exit code.

#### Terminal Tools (git hooks, pre-commit)

CLI tools like `pre-commit` display hook execution as:

```
pre-commit.............................(no files to check)Skipped
check yaml.....................................Passed
check for added large files..................Failed
  - exit code: 1
  - stdout:
    filename.yaml
```

This is the "hook as a step in a list" pattern — immediately familiar to developers.

---

## Potential Solutions

### Solution 1: Hook Events as Sub-Items Inside ToolCallCard (Recommended for Tool-Contextual Hooks)

**Description**: When a hook fires around `PreToolUse` or `PostToolUse`, render the hook as an expandable sub-section inside the relevant `ToolCallCard`. The card already has a structure for progress output — hooks extend this naturally.

**Visual design**:

```
┌────────────────────────────────────────────────┐
│  ✓  Edit  src/auth/session.ts           [done] │  ← ToolCallCard header
│     └─ 🔧 pre-commit  ···  passed  0.3s        │  ← hook inline row (success: compact)
└────────────────────────────────────────────────┘

┌────────────────────────────────────────────────┐
│  ✓  Edit  src/auth/session.ts           [done] │
│     └─ 🔧 pre-commit  ▼  failed  0.3s          │  ← hook inline row (failure: expanded)
│        stdout: (none)                           │
│        stderr: trailing-whitespace              │
│                Found 1 offending file           │
│                src/auth/session.ts              │
│        exit code: 1                             │
└────────────────────────────────────────────────┘
```

**State machine**:

- `hook_started` arrives → add a hook row to the tool card, show spinner + hook name + event type
- `hook_progress` arrives → update the stdout/stderr in the hook row (live-streaming)
- `hook_response` arrives → mark success/failure, show exit code, auto-collapse if `outcome === 'success'`, stay expanded if `outcome === 'error'`

**How to correlate**: The mapper tracks `toolState.currentToolId`. When `hook_started` arrives, capture `currentToolId` as the associated tool. Emit a new `hook_started` stream event with `toolCallId` attached. Same for `hook_progress` and `hook_response`.

**Pros**:

- Hooks are contextually anchored to the tool they wrap — causality is clear
- No new top-level component required — extends existing `ToolCallCard`
- Tool card already auto-expands on activity (`hasProgress` logic)
- Familiar pattern (GitHub Actions step → sub-step)
- Failure visibility is guaranteed since tool cards stay expanded on error

**Cons**:

- Requires `ToolCallCard` to accept and render a new `hooks` state array
- Correlating `hook_id` to `tool_use_id` requires temporal proximity heuristic in mapper (no direct link in `hook_started`/`hook_progress`/`hook_response`)
- Session-level hooks (not tied to a tool) need a separate path

**Complexity**: Medium. Server: 3 new yield cases in `mapSdkMessage` + `toolCallId` tracking. Client: extend `ToolCallState` with `hooks?: HookState[]`, update `ToolCallCard` to render hook rows.

---

### Solution 2: Standalone Hook Component at Same Level as ToolCallCard

**Description**: Render hook events as standalone `HookCard` components in the message stream, at the same visual level as `ToolCallCard` components. Each hook is an independent card.

**Visual design**:

```
[ToolCallCard: Edit src/auth/session.ts]
[HookCard: pre-commit · PostToolUse · passed · 0.3s]
```

**Pros**:

- Simple data model — no correlation problem (no need to link to tool call)
- Hook cards can be independently expanded/collapsed
- Works for both tool-contextual and session-level hooks

**Cons**:

- Loses the contextual relationship between hook and triggering tool — the user has to mentally connect them
- Adds visual noise at the top level when there are many small hooks
- Pre-tool hooks appear before the tool card, post-tool hooks after — the ordering creates a confusing "sandwich" pattern
- Creates a new component type that duplicates much of `ToolCallCard`'s structure

**Complexity**: Medium. Simpler server-side (no correlation), more complex client-side (new component + type).

---

### Solution 3: Route All Hook Events Through SystemStatusZone (Inline Status)

**Description**: Treat all hook events as system status messages — they flow through the existing `system_status` path and appear in the ephemeral status zone between the message list and chat input.

**Pros**:

- Zero new components
- Zero new stream event types (reuse `system_status`)
- Immediately implementable

**Cons**:

- Status zone is ephemeral — failures auto-fade after 4 seconds, making debugging impossible
- No persistent record of hook failures in the chat history
- Completely loses correlation to tool calls
- A pre-commit failure that blocks agent progress would disappear before the user reads it
- No way to show stdout/stderr from the hook process

**Complexity**: Very low. But produces severely inadequate UX for hook failures.

---

### Solution 4: Hybrid — Tool-Contextual Hooks in ToolCallCard, Session-Level Hooks in SystemStatusZone

**Description**: Route based on `hook_event` field. `PreToolUse`/`PostToolUse`/`PostToolUseFailure` hooks → sub-items in `ToolCallCard` (Solution 1). All other hook events (`SessionStart`, `UserPromptSubmit`, etc.) → route through `system_status` path to `SystemStatusZone`.

**Pros**:

- Correct semantic routing — tool hooks live near tools, session hooks live in the status area
- Session-level hooks are truly ephemeral (they happen at session start/end — not something users need to audit in history)
- Reuses both existing surfaces without new top-level components
- Failure handling: tool hook failures are persistent (inside ToolCallCard), session hook failures... could be made persistent via a separate treatment

**Cons**:

- Two code paths needed in the mapper
- Session-level hook failures (e.g., `SessionStart` hook that fails) would auto-fade from the status zone — this is a problem if the failure is actionable

**Complexity**: Medium. Best DX tradeoff — extends both existing surfaces correctly.

**Refinement for session-level hook failures**: If `hook_response.outcome === 'error'` for a session-level hook, escalate to a persistent error banner rather than the ephemeral status zone. This can reuse the existing `error` stream event type.

---

## Recommendation

**Implement Solution 4 (Hybrid)** with the failure escalation refinement.

### Routing Logic in `mapSdkMessage`

```typescript
const TOOL_CONTEXTUAL_HOOK_EVENTS = new Set([
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure'
]);

// In mapSdkMessage, in the system message dispatch block:
if (message.subtype === 'hook_started') {
  const isToolContextual = TOOL_CONTEXTUAL_HOOK_EVENTS.has(message.hook_event);
  if (isToolContextual) {
    yield {
      type: 'hook_started',
      data: {
        hookId: message.hook_id,
        hookName: message.hook_name,
        hookEvent: message.hook_event,
        toolCallId: toolState.currentToolId || null,  // temporal correlation
      },
    };
  } else {
    // Session-level: surface as system status
    yield {
      type: 'system_status',
      data: { message: `Running ${message.hook_name}...` },
    };
  }
  return;
}

if (message.subtype === 'hook_progress') {
  const isToolContextual = TOOL_CONTEXTUAL_HOOK_EVENTS.has(message.hook_event);
  if (isToolContextual) {
    yield {
      type: 'hook_progress',
      data: {
        hookId: message.hook_id,
        stdout: message.stdout,
        stderr: message.stderr,
      },
    };
  }
  // Session-level progress: silent (no output needed mid-execution)
  return;
}

if (message.subtype === 'hook_response') {
  const isToolContextual = TOOL_CONTEXTUAL_HOOK_EVENTS.has(message.hook_event);
  if (isToolContextual) {
    yield {
      type: 'hook_response',
      data: {
        hookId: message.hook_id,
        hookName: message.hook_name,
        exitCode: message.exit_code,
        outcome: message.outcome,
        stdout: message.stdout,
        stderr: message.stderr,
      },
    };
  } else if (message.outcome === 'error') {
    // Session-level failure: escalate to persistent error
    yield {
      type: 'error',
      data: {
        message: `Hook "${message.hook_name}" failed (${message.hook_event})`,
        code: 'hook_failure',
        category: 'execution_error',
        details: message.stderr || message.stdout,
      },
    };
  }
  // Session-level success: silent
  return;
}
```

### New Stream Event Types

Add to `StreamEventTypeSchema` in `packages/shared/src/schemas.ts`:

```
'hook_started', 'hook_progress', 'hook_response'
```

Add corresponding Zod schemas:

```typescript
export const HookStartedEventSchema = z.object({
  type: z.literal('hook_started'),
  data: z.object({
    hookId: z.string(),
    hookName: z.string(),
    hookEvent: z.string(),
    toolCallId: z.string().nullable(),
  }),
});

export const HookProgressEventSchema = z.object({
  type: z.literal('hook_progress'),
  data: z.object({
    hookId: z.string(),
    stdout: z.string(),
    stderr: z.string(),
  }),
});

export const HookResponseEventSchema = z.object({
  type: z.literal('hook_response'),
  data: z.object({
    hookId: z.string(),
    hookName: z.string(),
    exitCode: z.number().optional(),
    outcome: z.enum(['success', 'error', 'cancelled']),
    stdout: z.string(),
    stderr: z.string(),
  }),
});
```

### ToolCallCard Changes

Extend `ToolCallState` in `use-chat-session.ts`:

```typescript
interface HookState {
  hookId: string;
  hookName: string;
  hookEvent: string;
  status: 'running' | 'success' | 'error' | 'cancelled';
  stdout: string;
  stderr: string;
  exitCode?: number;
}

interface ToolCallState {
  // ... existing fields ...
  hooks?: HookState[]; // hooks associated with this tool call
}
```

In `ToolCallCard.tsx`, render hook rows below the tool header:

```tsx
{
  toolCall.hooks && toolCall.hooks.length > 0 && (
    <div className="space-y-0.5 border-t px-3 py-1">
      {toolCall.hooks.map((hook) => (
        <HookRow key={hook.hookId} hook={hook} />
      ))}
    </div>
  );
}
```

`HookRow` component (inline in `ToolCallCard.tsx` or extracted):

- Running: `🔧 {hookName}  ···  running` — spinner + hook name + event type label
- Success: `🔧 {hookName}  ✓  passed  {elapsed}s` — success icon, auto-collapses
- Error (collapsed): `🔧 {hookName}  ✗  failed  {elapsed}s` — clickable to expand output
- Error (expanded): shows `stdout`, `stderr`, `exit code: N`

### Auto-Hide Behavior

| Hook outcome | Auto-hide? | Timing                                                 |
| ------------ | ---------- | ------------------------------------------------------ |
| `success`    | Yes        | Immediately (same as tool card auto-collapse behavior) |
| `error`      | No         | Stays expanded until user collapses                    |
| `cancelled`  | Yes        | After 2 seconds                                        |

This matches GitHub Actions convention: passing steps collapse, failing steps stay visible.

### Visual Spec for HookRow

```
Running:
  ⟳ pre-commit  PreToolUse                     (spinner, muted text)

Success (compact):
  ✓ pre-commit  passed  0.3s                   (green check, muted text)

Error (compact, clickable):
  ✗ pre-commit  failed  0.3s          [expand] (red X, red text for hook name)

Error (expanded):
  ✗ pre-commit  failed  0.3s          [collapse]
  ┌─────────────────────────────────┐
  │ stderr: trailing-whitespace     │
  │         Found 1 offending file  │
  │         src/auth/session.ts     │
  │ exit code: 1                    │
  └─────────────────────────────────┘
```

Tailwind classes:

- Row wrapper: `flex items-center gap-2 py-0.5 text-xs`
- Running state: `text-muted-foreground`
- Success state: `text-muted-foreground` (de-emphasized)
- Error state: hook name in `text-destructive`, row gets subtle `bg-destructive/5 rounded`
- Output block: `font-mono text-xs bg-muted rounded p-2 mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap`

---

## Stream Event Handler Changes (Client)

In `stream-event-handler.ts` (or wherever the client processes stream events), add:

```typescript
case 'hook_started': {
  const { hookId, hookName, hookEvent, toolCallId } = event.data;
  if (toolCallId) {
    // Add to the associated tool call's hooks array
    addHookToToolCall(toolCallId, {
      hookId, hookName, hookEvent,
      status: 'running', stdout: '', stderr: ''
    });
  }
  break;
}
case 'hook_progress': {
  const { hookId, stdout, stderr } = event.data;
  updateHook(hookId, { stdout, stderr });
  break;
}
case 'hook_response': {
  const { hookId, outcome, exitCode, stdout, stderr } = event.data;
  updateHook(hookId, {
    status: outcome === 'success' ? 'success' : outcome === 'cancelled' ? 'cancelled' : 'error',
    exitCode, stdout, stderr
  });
  break;
}
```

The `hookId` is the correlation key across all three events.

---

## Implementation Sequence

1. **Server — `sdk-event-mapper.ts`**: Add `hook_started`, `hook_progress`, `hook_response` branches with the routing logic above. No new dependencies, pure mapper extension.

2. **Shared — `schemas.ts`**: Add three new event types + Zod schemas to `StreamEventTypeSchema`. Add to `types.ts` exports.

3. **Client — `use-chat-session.ts`**: Extend `ToolCallState` with `hooks?: HookState[]`. Add three new stream event handler cases.

4. **Client — `ToolCallCard.tsx`**: Add `HookRow` subcomponent. Render `toolCall.hooks` below the tool header. Auto-expand the tool card when a hook fails (`outcome === 'error'`).

5. **Tests**: Add test cases to `ToolCallCard.test.tsx` for hook rows in success and error states. Add mapper test cases for the three new subtypes.

---

## Research Gaps

- **`hook_id` persistence**: The `hook_id` field is the correlation key across `hook_started` → `hook_progress` → `hook_response`. It should be stable within a single hook execution. This is assumed from the type shapes but not explicitly documented in public SDK docs.
- **`hook_event` exact strings**: The `hook_event` field contains the hook event name (e.g., `"PreToolUse"`). The exact string values should be verified against a live SDK session before hardcoding the `TOOL_CONTEXTUAL_HOOK_EVENTS` set.
- **Timing gap — `hook_started` before `tool_call_start`**: For `PreToolUse` hooks, `hook_started` may fire before the associated `tool_call_start` event. If `toolState.currentToolId` is empty when `hook_started` arrives, the correlation will fail. This edge case needs to be tested. A fallback: buffer `hook_started` events with no `toolCallId` and attach them retrospectively when the next `tool_call_start` arrives.
- **Multiple hooks per tool call**: A single tool call can have multiple hooks registered. The `hooks` array on `ToolCallState` handles this correctly since each hook has its own `hookId`, but the UI rendering order (multiple HookRows) needs to be verified visually.

---

## Sources & Evidence

- `sdk.d.ts` at `/Users/doriancollier/Keep/dork-os/core/apps/server/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` lines 1511–1547 — authoritative type definitions for `SDKHookStartedMessage`, `SDKHookProgressMessage`, `SDKHookResponseMessage`
- `sdk-event-mapper.ts` — existing mapper structure; `system/status` and `system/compact_boundary` handling at lines 96–115 directly parallels the hook message handling needed
- `ToolCallCard.tsx` — existing `progressOutput` + `hasProgress` auto-expand pattern (lines 50–56) confirms the hook row extension approach
- `research/20260316_system_status_compact_boundary_ui_patterns.md` — SystemStatusZone design for session-level hook escalation
- `research/20260316_subagent_activity_streaming_ui_patterns.md` — collapsible streaming block patterns, scroll-lock behavior for auto-collapse
- `specs/system-status-compact-boundary/02-specification.md` line 343 — confirms hooks are explicitly out of scope for that spec, intended as a separate feature
- `claude-code-sdk-agent-capabilities.md` — `HookEvent` type enumeration, hook return values, permission evaluation order
- GitHub Actions log group UX — nested subprocess visibility pattern (collapsible per step, failures stay expanded)
