---
slug: server-client-code-review-fixes
number: 75
created: 2026-02-28
status: specified
---

# Specification: Server & Client Code Review Fixes

**Status:** Specified
**Author:** Claude Code
**Date:** 2026-02-28
**Ideation:** [01-ideation.md](./01-ideation.md)

---

## Overview

Fix 11 verified issues from a comprehensive code review of `apps/server/` and `apps/client/`. Issues span race conditions, security hardening, React rendering bugs, accessibility, and code quality. All fixes are backward-compatible with no API changes.

## Background / Problem Statement

A thorough code review identified bugs and security gaps across both apps. The most impactful cluster is a client-side EventSource reconnection cascade that opens/closes SSE connections on every render when Relay is enabled. Server-side issues include a race condition in session lock management and a permanently poisoned promise map in the binding router.

## Goals

- Eliminate the session lock double-release race condition
- Fix the permanently poisoned `inFlight` promise map
- Restrict CORS to localhost origins by default
- Validate relay SSE subscription patterns
- Stabilize the chat EventSource connection across renders
- Fix incremental history seeding to use ID comparison
- Resolve the FSD layer violation in `use-file-autocomplete`
- Make streaming text_delta updates immutable
- Correct ARIA roles on LinkSafetyModal
- Deduplicate the sessions query in SessionSidebar
- Add error handling to relay SSE JSON parsing

## Non-Goals

- New features or refactors beyond the identified issues
- Test coverage expansion (only update tests that break)
- Performance profiling beyond the re-render cascade
- Fixing `eventQueueNotify` overwrite (low severity, works correctly under session lock)
- Fixing `skipNextReload` in BindingStore (already uses a generation counter)

## Technical Dependencies

- No new libraries required
- Existing: `cors`, `express`, `react`, `@tanstack/react-query`, `chokidar`

## Detailed Design

### S1: Double Lock Release Race Condition

**File:** `apps/server/src/routes/sessions.ts`

**Current code (lines 232-264):** The legacy SSE path registers `res.on('close')` to release the lock, AND the `finally` block also releases the lock. Both fire on normal completion. If a new client acquires the lock between the two calls, the second release deletes the wrong client's lock.

**Fix:** Create a `releaseLockOnce` closure with a boolean guard:

```typescript
// Before the relay/legacy branch
let lockReleased = false;
const releaseLockOnce = () => {
  if (!lockReleased) {
    lockReleased = true;
    agentManager.releaseLock(sessionId, clientId);
  }
};

// Relay path
if (isRelayEnabled() && relayCore) {
  try {
    const receipt = await publishViaRelay(relayCore, sessionId, clientId, content, cwd);
    return res.status(202).json(receipt);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Relay publish failed';
    return res.status(500).json({ error: message });
  } finally {
    releaseLockOnce();
  }
}

// Legacy path
res.on('close', () => {
  releaseLockOnce();
});
// ...
finally {
  releaseLockOnce();
  endSSEStream(res);
}
```

### S2: inFlight Promise Permanently Poisoned on Failure

**File:** `apps/server/src/services/relay/binding-router.ts`

**Current code (lines 168-180):** The `inFlight.delete(key)` call is inside the success path of the async IIFE. If `createNewSession()` throws, the rejected promise remains in `inFlight` permanently.

**Fix:** Move cleanup to a `finally` block:

```typescript
const promise = (async () => {
  try {
    const sessionId = await this.createNewSession(binding);
    this.sessionMap.set(key, sessionId);
    this.evictOldestSessions();
    await this.saveSessionMap();
    return sessionId;
  } finally {
    this.inFlight.delete(key);
  }
})();
```

### S3: CORS Wildcard on Local Server

**File:** `apps/server/src/app.ts` (line 27)

**Current code:** `app.use(cors())` with no options — defaults to `Access-Control-Allow-Origin: *`.

**Fix:** Add a `buildCorsOptions()` helper that reads `DORKOS_CORS_ORIGIN` env var:

```typescript
function buildCorsOrigin(): cors.CorsOptions['origin'] {
  const envOrigin = process.env.DORKOS_CORS_ORIGIN;

  // Explicit wildcard opt-in
  if (envOrigin === '*') return '*';

  // User-specified origins (comma-separated)
  if (envOrigin) {
    return envOrigin.split(',').map((o) => o.trim());
  }

  // Default: localhost on common DorkOS ports
  const port = process.env.DORKOS_PORT || '4242';
  const vitePort = process.env.VITE_PORT || '4241';
  return [
    `http://localhost:${port}`,
    `http://localhost:${vitePort}`,
    `http://127.0.0.1:${port}`,
    `http://127.0.0.1:${vitePort}`,
  ];
}

export function createApp() {
  const app = express();
  app.use(cors({ origin: buildCorsOrigin() }));
  // ...
}
```

When tunnel is enabled, the tunnel URL is dynamically added. The `tunnelManager.status.url` is available after tunnel starts. Add a middleware that dynamically allows the tunnel origin:

```typescript
// In createApp(), after cors middleware:
app.use((req, res, next) => {
  const tunnelUrl = req.app.locals.tunnelUrl as string | undefined;
  if (tunnelUrl) {
    const origin = req.headers.origin;
    if (origin && tunnelUrl.startsWith(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
  }
  next();
});
```

Add `DORKOS_CORS_ORIGIN` to `turbo.json` `globalPassThroughEnv`.

### S4: Unvalidated Relay Subscription Pattern

**File:** `apps/server/src/routes/relay.ts` (lines 297-300)

**Current code:** `const pattern = (req.query.subject as string) || '>';` — no validation.

**Fix:** Add a pattern validation function and whitelist of allowed prefixes:

```typescript
const ALLOWED_PREFIXES = ['relay.human.console.', 'relay.system.', 'relay.signal.'];

function validateSubscriptionPattern(pattern: string): boolean {
  // Block the global wildcard
  if (pattern === '>') return false;

  // Allow any pattern that starts with an allowed prefix
  return ALLOWED_PREFIXES.some((prefix) => pattern.startsWith(prefix));
}

// In the GET /stream handler:
router.get('/stream', (req, res) => {
  const pattern = (req.query.subject as string) || 'relay.human.console.>';

  if (!validateSubscriptionPattern(pattern)) {
    return res.status(400).json({
      error: 'Invalid subscription pattern',
      allowedPrefixes: ALLOWED_PREFIXES,
    });
  }
  // ... rest unchanged
});
```

This fulfills the unimplemented consequence from ADR 0018: "Pattern validation must happen server-side to prevent invalid subscriptions."

### C1+C2: EventSource Reconnection Cascade

**Files:**

- `apps/client/src/layers/features/chat/ui/ChatPanel.tsx` (lines 44-81)
- `apps/client/src/layers/features/chat/model/use-chat-session.ts` (lines 105-129, 163-172)

**Root cause:** Three compounding issues create a cascade:

1. `handleTaskEventWithCelebrations` depends on `taskState` and `celebrations` objects (new every render)
2. `onStreamingDone` is an inline `useCallback` inside the options object literal
3. `options` bag is always a new reference, making `streamEventHandler` useMemo a no-op

**Fix (Part A) — Ref-stabilize in `useChatSession`:**

At the top of `useChatSession`, store option callbacks via refs and remove `options` from the `useMemo` dependency:

```typescript
// At the top of useChatSession, after destructuring options:
const onTaskEventRef = useRef(options.onTaskEvent);
const onSessionIdChangeRef = useRef(options.onSessionIdChange);
const onStreamingDoneRef = useRef(options.onStreamingDone);
const transformContentRef = useRef(options.transformContent);

// Sync refs on every render (no useEffect needed — refs are synchronous)
onTaskEventRef.current = options.onTaskEvent;
onSessionIdChangeRef.current = options.onSessionIdChange;
onStreamingDoneRef.current = options.onStreamingDone;
transformContentRef.current = options.transformContent;

// Pass refs to createStreamEventHandler instead of options
const streamEventHandler = useMemo(
  () =>
    createStreamEventHandler({
      // ...existing refs...
      sessionId,
      onTaskEventRef,
      onSessionIdChangeRef,
      onStreamingDoneRef,
      transformContentRef,
    }),
  [sessionId] // options removed — refs are stable
);
```

Update `createStreamEventHandler` to accept refs instead of an options bag. Inside the handler, call `ref.current?.()` instead of `options.callback()`.

**Fix (Part B) — Fix ChatPanel `handleTaskEventWithCelebrations`:**

Destructure stable references from `taskState`:

```typescript
const { handleTaskEvent: taskHandleEvent, tasks } = taskState;
const { handleTaskEvent: celebHandleEvent } = celebrations;

const handleTaskEventWithCelebrations = useCallback(
  (event: TaskUpdateEvent) => {
    taskHandleEvent(event);
    const projectedTasks = tasks.map((t) => (t.id === event.task.id ? { ...t, ...event.task } : t));
    celebHandleEvent(event, projectedTasks);
  },
  [taskHandleEvent, tasks, celebHandleEvent]
);
```

Note: `taskHandleEvent` is already stabilized with `useCallback([], [])` in `use-task-state.ts`. The `tasks` array will change when tasks update (which is correct — we want the latest tasks for projection). `celebHandleEvent` needs verification — if it's not stable, stabilize it in `useCelebrations`.

**Fix (Part C) — Fix incremental history seeding:**

Replace array-length comparison with ID-based deduplication:

```typescript
if (historySeededRef.current && !isStreaming) {
  const currentMessages = messagesRef.current;
  const existingIds = new Set(currentMessages.map((m) => m.id));
  const newMessages = history.filter((m) => !existingIds.has(m.id));

  if (newMessages.length > 0) {
    setMessages((prev) => [...prev, ...newMessages.map(mapHistoryMessage)]);
  }
}
```

### C3: FSD Layer Violation

**File:** `apps/client/src/layers/features/chat/model/use-file-autocomplete.ts` (line 3)

**Current code:** `import type { FileEntry } from '@/layers/features/files';`

**Fix:** The `FileEntry` type is defined in `features/files/ui/FilePalette.tsx` and re-exported from `features/files/index.ts`. Move the type to `shared/lib/types.ts` (or a new `shared/lib/file-types.ts`):

```typescript
// shared/lib/file-types.ts
export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
}
```

Update imports in both `features/files/ui/FilePalette.tsx` and `features/chat/model/use-file-autocomplete.ts` to import from `@/layers/shared/lib`. Update `features/files/index.ts` to re-export from the shared location for backward compatibility.

### C4: Mutable Ref During Streaming

**File:** `apps/client/src/layers/features/chat/model/stream-event-handler.ts` (lines 124-132)

**Current code:** `lastPart.text += text` mutates in place; `parts.push()` mutates the array.

**Fix:** Replace with immutable updates:

```typescript
case 'text_delta': {
  const { text } = data as TextDelta;
  const parts = currentPartsRef.current;
  const lastPart = parts[parts.length - 1];
  if (lastPart && lastPart.type === 'text') {
    // Create new array with replaced last element
    currentPartsRef.current = [
      ...parts.slice(0, -1),
      { ...lastPart, text: lastPart.text + text },
    ];
  } else {
    // Create new array with appended element
    currentPartsRef.current = [...parts, { type: 'text', text }];
  }
  // ... rest unchanged
}
```

### C5: Incorrect ARIA on LinkSafetyModal

**File:** `apps/client/src/layers/features/chat/ui/StreamingText.tsx` (lines 17-31)

**Fix:** Remove `role="button"` and `tabIndex={0}` from the backdrop. Add proper dialog ARIA to the content div:

```tsx
<div
  className="fixed inset-0 z-50 flex items-center justify-center"
  data-streamdown="link-safety-modal"
  onClick={onClose}
  aria-hidden="true"
>
  <div className="fixed inset-0 bg-black/50" aria-hidden="true" />
  <div
    className="bg-background relative mx-4 flex w-full max-w-md flex-col gap-4 rounded-xl border p-6 shadow-lg"
    onClick={(e) => e.stopPropagation()}
    onKeyDown={(e) => {
      if (e.key === 'Escape') onClose();
      e.stopPropagation();
    }}
    role="dialog"
    aria-modal="true"
    aria-label="External link confirmation"
    tabIndex={-1}
  >
```

Note: The outer backdrop gets `aria-hidden="true"` since it's decorative. The inner content div becomes the dialog with keyboard handling. `tabIndex={-1}` makes it programmatically focusable for focus trapping.

### C6: Duplicated Sessions Query

**File:** `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx` (lines 88-92)

**Current code:** Inline `useQuery` with `queryKey: ['sessions', selectedCwd]` — identical to `useSessions()` from `entities/session`.

**Fix:** Replace the inline query with the entity hook:

```typescript
import { useSessions } from '@/layers/entities/session';

// Replace:
// const { data: sessions = [] } = useQuery({...});

// With:
const { sessions } = useSessions();
```

Verify that `useSessions()` provides the same data shape (it returns `sessions: sessionsQuery.data ?? []` which matches `data: sessions = []`). The entity hook also adds `refetchInterval: QUERY_TIMING.SESSIONS_REFETCH_MS` which the inline version lacks — this is an improvement.

Remove the now-unused `useQuery` import if it was only used for this query.

### C7: Uncaught JSON.parse in Relay SSE Listeners

**File:** `apps/client/src/layers/entities/relay/model/use-relay-event-stream.ts` (lines 43-55)

**Fix:** Wrap both `JSON.parse` calls in try/catch:

```typescript
source.addEventListener('relay_message', (e) => {
  try {
    const envelope = JSON.parse(e.data);
    queryClient.setQueryData(
      ['relay', 'messages', undefined],
      (old: { messages: unknown[]; nextCursor?: string } | undefined) => {
        if (!old) return { messages: [envelope] };
        return { ...old, messages: [envelope, ...old.messages] };
      }
    );
  } catch {
    console.warn('[Relay] Failed to parse relay_message event:', e.data);
  }
});

source.addEventListener('relay_delivery', (e) => {
  try {
    const data = JSON.parse(e.data);
    // ... existing cache update logic
  } catch {
    console.warn('[Relay] Failed to parse relay_delivery event:', e.data);
  }
});
```

## User Experience

No user-visible changes. All fixes are internal correctness improvements. Users may notice:

- More stable SSE connections when relay is enabled (C1+C2 fix)
- Improved screen reader experience on link safety modal (C5 fix)

## Testing Strategy

### Unit Tests

- **S1:** Test that `releaseLockOnce` is idempotent — calling it twice only releases once
- **S2:** Test that `getOrCreateSession` recovers after `createNewSession` throws — subsequent calls should create a new session, not return a rejected promise
- **C1+C2:** Test that `streamEventHandler` identity is stable across renders when only `options` changes (not `sessionId`)
- **C4:** Test that `text_delta` processing creates new part objects instead of mutating existing ones

### Integration Tests

- **S3:** Test that CORS headers are set correctly with default config, custom env var, and tunnel URL
- **S4:** Test that `>` pattern is rejected with 400, and `relay.human.console.xyz` is allowed

### Existing Tests

- Run full test suite to verify no regressions
- Update any tests that depend on the current `options` parameter shape of `createStreamEventHandler`

## Performance Considerations

- **C1+C2 fix is a performance improvement:** Eliminates unnecessary EventSource reconnections on every render. This was the primary performance issue identified in the review.
- **C4 immutable updates:** Creates new arrays/objects on each `text_delta`. During rapid streaming this adds allocation pressure, but the overhead is negligible compared to the DOM updates that follow.
- **S3 CORS:** Adds an origin check per request. Negligible overhead.

## Security Considerations

- **S3:** Restricts CORS from wildcard to localhost. Major security improvement — prevents cross-origin reads of session data from arbitrary web pages.
- **S4:** Validates relay subscription patterns. Prevents clients from snooping on arbitrary relay channels. Implements the unaddressed consequence from ADR 0018.
- No new attack surface introduced by any fix.

## Documentation

- Add `DORKOS_CORS_ORIGIN` to `contributing/configuration.md` settings reference
- No other documentation changes needed

## Implementation Phases

### Phase 1: Server fixes (S1-S4)

1. S1: Double lock release — `routes/sessions.ts`
2. S2: inFlight promise cleanup — `services/relay/binding-router.ts`
3. S3: CORS configuration — `app.ts` + `turbo.json`
4. S4: Relay subscription validation — `routes/relay.ts`

### Phase 2: Client critical fixes (C1-C4)

5. C1+C2: Ref-stabilize useChatSession + fix history seeding — `use-chat-session.ts` + `stream-event-handler.ts` + `ChatPanel.tsx`
6. C3: FSD layer violation — `use-file-autocomplete.ts` + new shared type file
7. C4: Immutable streaming updates — `stream-event-handler.ts`

### Phase 3: Client quality fixes (C5-C7)

8. C5: ARIA roles — `StreamingText.tsx`
9. C6: Deduplicate sessions query — `SessionSidebar.tsx`
10. C7: JSON.parse error handling — `use-relay-event-stream.ts`

## Open Questions

No open questions — all decisions resolved during ideation.

## Related ADRs

- **ADR 0018:** Server-Side SSE Subject Filtering for Relay — S4 implements the unaddressed consequence: "Pattern validation must happen server-side to prevent invalid subscriptions"
- **ADR 0003:** SDK JSONL as Single Source of Truth — S1 affects the session streaming path that reads from JSONL files
- **ADR 0046:** Central Binding Router for Adapter-Agent Routing — S2 affects the binding router's session creation flow

## References

- [React useRef pattern for callback stabilization](https://react.dev/reference/react/useRef)
- [CORS configuration best practices](https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS)
- [WAI-ARIA dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)
