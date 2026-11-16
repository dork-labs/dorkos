---
slug: system-status-compact-boundary
number: 136
created: 2026-03-16
status: specification
---

# Surface SDK System Status Messages & Compact Boundary Events

## Overview

Surface two silently-dropped SDK system messages in the DorkOS chat UI:

1. **`system/status`** — Ephemeral operational messages ("Compacting context...", permission mode changes). Displayed in a transient status zone between MessageList and ChatInput that auto-fades after 4 seconds.
2. **`system/compact_boundary`** — Context compaction marker. Injected as a standalone `ChatMessage` with `messageType: 'compaction'`, reusing the existing hairline divider UI in `UserMessageContent.tsx`.

Both event types flow through the established pipeline: SDK mapper → shared schemas → SSE transport → client stream handler → UI.

## Technical Design

### Architecture

```
SDK stream
  ↓
sdk-event-mapper.ts (new branches in system message dispatch)
  ├─ system/status → yield { type: 'system_status', data: { message } }
  └─ system/compact_boundary → yield { type: 'compact_boundary', data: {} }
  ↓
SSE transport (existing)
  ↓
stream-event-handler.ts (new switch cases)
  ├─ system_status → update systemStatus ephemeral state
  └─ compact_boundary → inject ChatMessage with messageType: 'compaction'
  ↓
ChatPanel.tsx
  ├─ SystemStatusZone (new component, renders ephemeral status)
  └─ MessageList renders compaction messages via existing UserMessageContent
```

### Phase 1: Shared Schemas

**File: `packages/shared/src/schemas.ts`**

Add two new event types to `StreamEventTypeSchema`:

```typescript
export const StreamEventTypeSchema = z
  .enum([
    // ... existing 21 types ...
    'system_status',
    'compact_boundary',
  ])
  .openapi('StreamEventType');
```

Add two new event schemas (after `SubagentDoneEventSchema`, before `StreamEventSchema`):

```typescript
export const SystemStatusEventSchema = z
  .object({
    message: z.string(),
  })
  .openapi('SystemStatusEvent');

export type SystemStatusEvent = z.infer<typeof SystemStatusEventSchema>;

export const CompactBoundaryEventSchema = z.object({}).openapi('CompactBoundaryEvent');

export type CompactBoundaryEvent = z.infer<typeof CompactBoundaryEventSchema>;
```

Add both to the `StreamEventSchema` data union:

```typescript
export const StreamEventSchema = z
  .object({
    type: StreamEventTypeSchema,
    data: z.union([
      // ... existing schemas ...
      SystemStatusEventSchema,
      CompactBoundaryEventSchema,
    ]),
  })
  .openapi('StreamEvent');
```

**File: `packages/shared/src/types.ts`**

Add type re-exports:

```typescript
export type {
  // ... existing exports ...
  SystemStatusEvent,
  CompactBoundaryEvent,
} from './schemas.js';
```

### Phase 2: Server Mapper

**File: `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts`**

Add two new branches in the system message dispatch block (after line 93, before the `stream_event` handling):

```typescript
// Handle system status messages ("Compacting context...", permission mode changes)
if (message.subtype === 'status') {
  const msg = message as Record<string, unknown>;
  const text = (msg.body as string) ?? (msg.message as string) ?? '';
  if (text) {
    yield {
      type: 'system_status',
      data: { message: text },
    };
  }
  return;
}

// Handle compact boundary (context window compaction occurred)
if (message.subtype === 'compact_boundary') {
  yield {
    type: 'compact_boundary',
    data: {},
  };
  return;
}
```

The `SystemStatusEventSchema` carries only a `message` string — we don't need `subtype` on the wire because the client treats all status messages identically (ephemeral display, 4s auto-fade). The SDK `status` subtype field (e.g., `'compacting'`, `'permission_change'`) is an implementation detail that doesn't affect rendering.

The `CompactBoundaryEventSchema` is an empty object — the event's existence IS the data. No token counts needed (context % is already shown in the status bar via `session_status` events).

### Phase 3: Client Stream Handler

**File: `apps/client/src/layers/features/chat/model/stream-event-handler.ts`**

Add to `StreamEventDeps` interface:

```typescript
interface StreamEventDeps {
  // ... existing deps ...
  setSystemStatus: (message: string | null) => void;
}
```

Add two new cases in the switch statement (after the `subagent_done` case, before `done`):

```typescript
case 'system_status': {
  const { message } = data as SystemStatusEvent;
  deps.setSystemStatus(message);
  break;
}
case 'compact_boundary': {
  // Inject a standalone compaction message into the chat
  setMessages((prev) => [
    ...prev,
    {
      id: `compaction-${Date.now()}`,
      role: 'user' as const,
      content: '',
      parts: [],
      timestamp: new Date().toISOString(),
      messageType: 'compaction' as const,
    },
  ]);
  break;
}
```

The compact boundary injects a `ChatMessage` with `role: 'user'` and `messageType: 'compaction'` — this reuses the existing `UserMessageContent` renderer which already has the hairline divider, "Context compacted" text, and expandable chevron. No new component needed.

**File: `apps/client/src/layers/features/chat/model/use-chat-session.ts`**

Add `systemStatus` state and auto-clear timer:

```typescript
const [systemStatus, setSystemStatus] = useState<string | null>(null);
const systemStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

// Wrap setSystemStatus to auto-clear after 4s
const setSystemStatusWithClear = useCallback((message: string | null) => {
  if (systemStatusTimerRef.current) {
    clearTimeout(systemStatusTimerRef.current);
    systemStatusTimerRef.current = null;
  }
  setSystemStatus(message);
  if (message) {
    systemStatusTimerRef.current = setTimeout(() => {
      setSystemStatus(null);
      systemStatusTimerRef.current = null;
    }, TIMING.SYSTEM_STATUS_DISMISS_MS);
  }
}, []);
```

Pass `setSystemStatus: setSystemStatusWithClear` into `createStreamEventHandler` deps. Return `systemStatus` from the hook.

Also clear `systemStatus` on `done` event cleanup (alongside existing cleanup of streaming state).

**File: `apps/client/src/layers/shared/lib/constants.ts`** (or wherever `TIMING` is defined)

Add:

```typescript
/** Auto-dismiss duration for ephemeral system status messages. */
SYSTEM_STATUS_DISMISS_MS: 4_000,
```

### Phase 4: UI — System Status Zone

**File: `apps/client/src/layers/features/chat/ui/SystemStatusZone.tsx`** (new)

A single-line ephemeral indicator between MessageList and ChatInput:

```typescript
import { AnimatePresence, motion } from 'motion/react';
import { Info } from 'lucide-react';

interface SystemStatusZoneProps {
  message: string | null;
}

/**
 * Ephemeral system status zone — displays transient SDK status messages
 * (e.g., "Compacting context...", permission mode changes) with auto-fade.
 */
export function SystemStatusZone({ message }: SystemStatusZoneProps) {
  return (
    <AnimatePresence>
      {message && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.2 }}
          className="flex items-center justify-center gap-1.5 px-4 py-1"
        >
          <Info className="text-muted-foreground/60 size-3 shrink-0" />
          <span className="text-muted-foreground/60 text-xs">{message}</span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
```

**File: `apps/client/src/layers/features/chat/ui/ChatPanel.tsx`**

Wire the system status into ChatPanel. Add `systemStatus` to the destructured return from `useChatSession`, then render `SystemStatusZone` between the message area and `TaskListPanel`:

```typescript
// In the destructured return from useChatSession:
const { messages, systemStatus, /* ... existing */ } = useChatSession(sessionId, { ... });

// In JSX, after the </div> that wraps MessageList (line ~333) and before TaskListPanel:
<SystemStatusZone message={systemStatus} />
```

### Phase 5: Compact Boundary — No New Component Needed

The existing `UserMessageContent.tsx` already handles `messageType: 'compaction'` with a polished UI:

- Hairline divider rules (`bg-border/40 h-px flex-1`)
- Centered "Context compacted" text in `text-msg-compaction-fg`
- Expandable chevron to reveal compacted content
- Proper spacing and typography

The `compact_boundary` handler in `stream-event-handler.ts` injects a `ChatMessage` with `messageType: 'compaction'` and empty `content`. This renders as the hairline divider with no expandable content (since `content` is empty, the expanded state shows nothing — which is correct for live streaming where we don't have the compacted summary text).

## File Changes Summary

| File                                      | Change                                                | Lines    |
| ----------------------------------------- | ----------------------------------------------------- | -------- |
| `packages/shared/src/schemas.ts`          | Add 2 event types to enum, 2 schemas, 2 union members | ~20      |
| `packages/shared/src/types.ts`            | Add 2 type re-exports                                 | ~2       |
| `apps/server/.../sdk-event-mapper.ts`     | Add 2 system message branches                         | ~20      |
| `apps/client/.../stream-event-handler.ts` | Add 2 switch cases, 1 dep                             | ~20      |
| `apps/client/.../use-chat-session.ts`     | Add systemStatus state + auto-clear                   | ~20      |
| `apps/client/.../constants.ts`            | Add SYSTEM_STATUS_DISMISS_MS                          | ~2       |
| `apps/client/.../SystemStatusZone.tsx`    | **New** — ephemeral status component                  | ~30      |
| `apps/client/.../ChatPanel.tsx`           | Wire systemStatus, render zone                        | ~5       |
| **Total**                                 |                                                       | **~120** |

## Testing

### Unit Tests

**`apps/server/src/services/runtimes/claude-code/__tests__/sdk-event-mapper.test.ts`**

```
describe('system/status messages')
  it('yields system_status event with message text')
  it('yields nothing for status messages with no text')

describe('system/compact_boundary messages')
  it('yields compact_boundary event')
```

**`apps/client/src/layers/features/chat/model/__tests__/stream-event-handler-*.test.ts`** (new file or append)

```
describe('system_status event')
  it('calls setSystemStatus with the message text')

describe('compact_boundary event')
  it('injects a compaction ChatMessage into messages')
  it('compaction message has messageType "compaction"')
```

**`apps/client/src/layers/features/chat/ui/__tests__/SystemStatusZone.test.tsx`** (new)

```
describe('SystemStatusZone')
  it('renders nothing when message is null')
  it('renders message text when present')
  it('renders info icon')
```

### Manual Testing

1. Trigger a long session that causes context compaction — verify "Context compacted" divider appears
2. Verify the ephemeral status zone appears and fades after 4 seconds
3. Verify dark mode styling for both components
4. Verify mobile viewport layout
5. Verify existing tests still pass (`pnpm test -- --run`)

## Acceptance Criteria

1. SDK `system/status` messages display as ephemeral text in the status zone, auto-dismiss after 4s
2. SDK `system/compact_boundary` messages render as the existing hairline "Context compacted" divider
3. No changes to existing event handlers — all modifications are additive
4. All existing tests pass unchanged
5. New unit tests cover mapper, handler, and component
6. No message history pollution — status messages are ephemeral state, compact boundaries are transient chat messages (not persisted to JSONL)

## Out of Scope

- Persisting compact boundaries in JSONL history replay (P3 — future work)
- Hook events (`hook_started`/`hook_progress`/`hook_response`) — separate audit items #11-13
- Prompt suggestions (`prompt_suggestion`) — separate audit item #17
- InferenceIndicator integration for status messages (decided against — dedicated zone is cleaner)
- Compact boundary token count metadata (context % already shown in status bar)
