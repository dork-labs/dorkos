---
slug: client-direct-sse
number: 125
created: 2026-03-12
status: specification
---

# Client Direct SSE — Remove Relay Message Path from Web Client

**Status:** Specification
**Authors:** Claude Code, 2026-03-12
**Spec Number:** 125
**Ideation:** `specs/client-direct-sse/01-ideation.md`
**Research:** `research/20260312_client_direct_sse_relay_removal.md`

---

## Overview

Make the DorkOS web client always use direct SSE for sending messages and receiving streaming responses. Remove all relay message code paths from the web client and the server-side relay fan-in that served only the web client. SSE is no longer a "legacy" feature — it is the primary and only client transport.

Relay infrastructure stays intact for external adapters (Telegram, webhooks) and agent-to-agent communication. The `sendMessageRelay()` method stays on the Transport interface (backward compat) but is no longer called from the chat hook.

## Background / Problem Statement

The web client currently has two code paths for sending messages:

1. **Direct SSE** — `transport.sendMessage()` → POST streams SSE on response body → client receives events inline. One hop, simple, proven stable.

2. **Relay** — `transport.sendMessageRelay()` → POST returns 202 → relay bus → CCA adapter → runtime → response chunks → `relay.human.console.{clientId}` → SessionBroadcaster relay fan-in → persistent EventSource. Three hops, requires correlationId, `stream_ready` handshake, staleness detection, pending buffer.

Every streaming bug in the codebase was relay-specific: `fix-relay-sse-delivery-pipeline`, `fix-relay-ghost-messages`, `fix-relay-streaming-bugs`, `fix-relay-sse-backpressure`, `fix-relay-history-sse-gaps`. The direct SSE path has been stable throughout.

The relay message path was added for external adapters (Telegram, webhooks) but was incorrectly generalized to the web client. The web client has a direct HTTP connection — it gains nothing from routing messages through the relay bus. External adapter messages already work without the web client being on the relay bus: they route through CCA → runtime → JSONL → file watcher → `sync_update` SSE event.

## Goals

- Remove all relay message code from the client chat hook (`use-chat-session.ts`)
- Remove server-side relay-specific code that only served the web client (`publishViaRelay()`, relay 202 path, SessionBroadcaster relay fan-in, `stream_ready` event)
- Remove relay-only test files
- Rename "legacy" SSE labels — SSE is now primary, not legacy
- Simplify the codebase by eliminating dead code paths

## Non-Goals

- Removing the relay infrastructure itself (RelayCore, CCA adapter, external adapters)
- Removing relay UI features (Relay panel, adapter management, ConnectionsView, observed chats)
- Removing `sendMessageRelay()` from the Transport interface
- Removing `useRelayEnabled()` hook (still used by relay UI panels)
- Changes to agent-to-agent communication patterns
- Removing relay initialization from `index.ts` (needed for external adapters)
- Removing `relay-state.ts` (needed for config route and relay UI)

## Technical Dependencies

- No external library changes
- No new dependencies
- `@dorkos/relay` package stays intact (used by external adapters)

## Detailed Design

### Phase 1: Client-Side Removal (`use-chat-session.ts`)

Remove the following from `apps/client/src/layers/features/chat/model/use-chat-session.ts`:

#### 1.1 Remove import

```typescript
// DELETE:
import { useRelayEnabled } from '@/layers/entities/relay';
```

#### 1.2 Remove `waitForStreamReady()` function (lines 18-35)

```typescript
// DELETE entire function:
function waitForStreamReady(
  ref: React.MutableRefObject<boolean>,
  timeoutMs: number
): Promise<void> { ... }
```

#### 1.3 Remove relay refs and state (scattered)

```typescript
// DELETE these declarations:
const relayEnabled = useRelayEnabled();           // line ~86
const correlationIdRef = useRef<string>('');       // line ~99
const stalenessTimerRef = useRef<...>(null);       // line ~110
const streamReadyRef = useRef<boolean>(false);     // line ~135
const statusRef = useRef(status);                  // line ~137
// DELETE statusRef sync effect (lines ~138-140)
```

#### 1.4 Remove `resetStalenessTimer` callback (lines ~238-257)

Delete the entire `useCallback` that implements staleness detection.

#### 1.5 Remove relay EventSource effect (lines ~259-324)

Delete the entire `useEffect` that:
- Opens persistent EventSource when `relayEnabled`
- Listens for `stream_ready`, `relay_message`, `sync_update`
- Handles correlationId filtering
- Calls `resetStalenessTimer()`

#### 1.6 Simplify the "legacy" SSE EventSource effect (lines ~326-343)

**Before:**
```typescript
// Legacy-path EventSource: closes during streaming since SSE is embedded in POST.
// No-op when relay is enabled — the relay effect above handles sync updates.
useEffect(() => {
  if (!sessionId || relayEnabled) return;
  if (isStreaming) return;
  // ...
}, [sessionId, isStreaming, queryClient, relayEnabled]);
```

**After:**
```typescript
// Persistent SSE connection for session sync updates.
// Closes during streaming since SSE events arrive inline on the POST response.
useEffect(() => {
  if (!sessionId) return;
  if (isStreaming) return;

  const url = `/api/sessions/${sessionId}/stream`;
  const eventSource = new EventSource(url);

  eventSource.addEventListener('sync_update', () => {
    queryClient.invalidateQueries({ queryKey: ['messages', sessionId, selectedCwdRef.current] });
    queryClient.invalidateQueries({ queryKey: ['tasks', sessionId, selectedCwdRef.current] });
  });

  return () => {
    eventSource.close();
  };
}, [sessionId, isStreaming, queryClient]);
```

Changes: remove `relayEnabled` guard, remove from dependency array, rename comment.

#### 1.7 Remove relay branch from `executeSubmission` (lines ~406-427)

**Before (relay branch + else):**
```typescript
if (relayEnabled) {
  const correlationId = crypto.randomUUID();
  correlationIdRef.current = correlationId;
  streamReadyRef.current = false;
  await waitForStreamReady(streamReadyRef, 5000);
  await transport.sendMessageRelay(targetSessionId, finalContent, {
    clientId: clientIdRef.current,
    correlationId,
    cwd: selectedCwdRef.current ?? undefined,
  });
  resetStalenessTimer();
} else {
  await transport.sendMessage(
    targetSessionId, finalContent,
    (event) => streamEventHandler(event.type, event.data, assistantIdRef.current),
    abortController.signal,
    selectedCwd ?? undefined
  );
  setPendingUserContent(null);
  setStatus('idle');
}
```

**After (direct SSE only):**
```typescript
await transport.sendMessage(
  targetSessionId,
  finalContent,
  (event) => streamEventHandler(event.type, event.data, assistantIdRef.current),
  abortController.signal,
  selectedCwd ?? undefined,
);
setPendingUserContent(null);
setStatus('idle');
```

#### 1.8 Remove `relayEnabled` from refetch logic (line ~190)

**Before:**
```typescript
refetchInterval: () => {
  if (isStreaming || relayEnabled) return false;
  return isTabVisible ? QUERY_TIMING.ACTIVE_TAB_REFETCH_MS : QUERY_TIMING.BACKGROUND_TAB_REFETCH_MS;
},
```

**After:**
```typescript
refetchInterval: () => {
  if (isStreaming) return false;
  return isTabVisible ? QUERY_TIMING.ACTIVE_TAB_REFETCH_MS : QUERY_TIMING.BACKGROUND_TAB_REFETCH_MS;
},
```

#### 1.9 Remove `relayEnabled` from dependency arrays

Remove `relayEnabled` from all `useCallback`/`useEffect` dependency arrays in this file (e.g., `executeSubmission`, the sync EventSource effect).

### Phase 2: Server-Side Removal (`sessions.ts`)

Remove the following from `apps/server/src/routes/sessions.ts`:

#### 2.1 Remove imports

```typescript
// DELETE:
import { isRelayEnabled } from '../services/relay/relay-state.js';
import type { RelayCore } from '@dorkos/relay';
```

#### 2.2 Remove `publishViaRelay()` function (lines ~159-198)

Delete the entire function (~40 lines) that registers a console endpoint and publishes to the relay bus.

#### 2.3 Remove relay dispatch in POST `/messages` (lines ~232-255)

Delete the entire `if (isRelayEnabled() && relayCore)` block that:
- Calls `publishViaRelay()`
- Returns `202` receipt
- Logs relay dispatch timing

After removal, the POST handler always streams SSE inline (the current "else" branch becomes the only path).

#### 2.4 Remove `stream_ready` event in GET `/stream` (lines ~383-388)

```typescript
// DELETE:
if (req.app.locals.relayCore && clientId) {
  res.write(`event: stream_ready\ndata: ${JSON.stringify({ clientId })}\n\n`);
}
```

#### 2.5 Rename "legacy" comments

Update any comments in sessions.ts that reference "legacy SSE" to simply describe the SSE behavior without the "legacy" qualifier.

### Phase 3: Server-Side Removal (`session-broadcaster.ts`)

Remove relay fan-in from `apps/server/src/services/runtimes/claude-code/session-broadcaster.ts`:

#### 3.1 Remove relay imports and state

```typescript
// DELETE:
import type { RelayCore } from '@dorkos/relay';

// DELETE these properties:
private relaySubscriptions = new Map<Response, Unsubscribe>();
private callbackRelayUnsubs = new Map<string, Unsubscribe>();
private relay: RelayCore | null = null;
```

#### 3.2 Remove `setRelay()` method (lines ~74-76)

Delete the entire method that injects RelayCore for relay subscription fan-in.

#### 3.3 Remove relay subscription in `registerClient()` (lines ~119-131)

Delete:
- `if (this.relay && clientId) { this.subscribeToRelay(res, clientId); }`
- `if (this.relay && clientId) { res.write(\`event: stream_ready\n...\`); }`

Keep `sync_connected` event emission (that stays).

#### 3.4 Remove relay subscription in `registerCallback()` (lines ~165-190)

Delete the `if (this.relay && clientId)` block that subscribes callbacks to relay messages, and the relay cleanup in the unsubscribe function.

#### 3.5 Remove relay cleanup in `deregisterClient()` (line ~226-227)

Delete the `this.unsubscribeFromRelay(res)` call.

#### 3.6 Remove `subscribeToRelay()` and `unsubscribeFromRelay()` private methods (lines ~267-344)

Delete both methods entirely (~78 lines). These implement the relay fan-in with backpressure handling and queue flushing.

#### 3.7 Remove relay cleanup in `shutdown()` (lines ~532-542)

Delete the loops that unsubscribe all relay subscriptions and clear the maps.

### Phase 4: Remove `setRelay()` call from `index.ts`

In `apps/server/src/index.ts`, remove the line that calls `broadcaster.setRelay(relayCore)`. The relay initialization itself stays (needed for external adapters), but the broadcaster no longer needs a relay reference.

**Keep:** RelayCore initialization, adapter registration, `runtime.setRelay?.(relayCore)` (used for relay-aware context building).

**Remove:** `broadcaster.setRelay(relayCore)` call only.

### Phase 5: Test Cleanup

#### 5.1 Delete relay-only test files

- `apps/client/src/layers/features/chat/model/__tests__/use-chat-session-relay.test.ts` — entire file
- `apps/server/src/routes/__tests__/sessions-relay.test.ts` — entire file
- `apps/server/src/routes/__tests__/sessions-relay-correlation.test.ts` — entire file (if exists)

#### 5.2 Update session-broadcaster tests

In `apps/server/src/services/runtimes/claude-code/__tests__/session-broadcaster.test.ts` (or similar path):
- Remove tests for `stream_ready` event emission
- Remove tests for `relay_message` event forwarding
- Remove tests for `subscribeToRelay()` / `unsubscribeFromRelay()`
- Remove tests for relay subscription cleanup in shutdown
- Keep tests for `sync_update`, `sync_connected`, file watcher, and general broadcast behavior

#### 5.3 Update remaining test files

Any test file that mocks `relayEnabled` or references the relay message path in the context of chat:
- Remove `relayEnabled` mock setups
- Remove assertions about relay-specific behavior
- Keep relay mocks that test relay UI features (adapter management, ConnectionsView)

### Phase 6: Naming Cleanup

Search and update all "legacy" labels that reference SSE:

1. Comments like `// Legacy SSE path` → `// SSE streaming path` or remove
2. Comments like `// legacy-path EventSource` → `// Session sync EventSource`
3. Variable names if any contain "legacy" in SSE context
4. Test describe blocks referencing "legacy path"

## User Experience

No visible change to the user. Messages send and stream identically — the direct SSE path is what users have been using when relay is disabled. The only difference is that when relay IS enabled, the web client now uses direct SSE instead of routing through the relay bus. External adapter messages (Telegram responses appearing in chat) continue to work via the file watcher → `sync_update` path.

## Testing Strategy

### Unit Tests

- Verify `use-chat-session.ts` submits via `transport.sendMessage()` regardless of relay config
- Verify the sync EventSource effect opens without checking `relayEnabled`
- Verify `executeSubmission` no longer calls `sendMessageRelay()`

### Integration Tests

- Verify `POST /api/sessions/:id/messages` always streams SSE (never returns 202)
- Verify `GET /api/sessions/:id/stream` does not emit `stream_ready`
- Verify session-broadcaster registers clients without relay subscription

### Regression Tests

- With `DORKOS_RELAY_ENABLED=true`: web client still sends messages and receives streaming responses via direct SSE
- With relay disabled: behavior unchanged
- External adapter messages still appear in chat via `sync_update` events

### Deleted Tests

The deleted relay test files test code paths that no longer exist. No replacement tests needed — the direct SSE path already has test coverage in:
- `use-chat-session.test.ts` (existing client tests)
- `sessions.test.ts` (existing server route tests)

## Performance Considerations

**Positive impact only.** Removing the relay message path eliminates:
- One extra network hop (relay bus round-trip)
- `stream_ready` handshake delay (up to 5 seconds polling)
- Staleness timer overhead
- Persistent EventSource for relay messages (the sync EventSource stays but is simpler)
- Server-side relay subscription bookkeeping in SessionBroadcaster

## Security Considerations

No security impact. The relay bus is an internal transport, not a security boundary. Direct SSE uses the same authentication and session locking as before.

## Documentation

### Files to Update

- `contributing/architecture.md` — Update the Transport interface section to note that SSE is the only client transport. Remove references to dual code paths.
- Any inline code comments that reference the relay message path for the web client.

### No New Documentation Needed

The direct SSE path is simpler and self-documenting. The relay architecture documentation stays (relay is still used for external adapters).

## Implementation Phases

### Phase 1: Client-Side Removal

Remove relay branching from `use-chat-session.ts`. Delete relay test file. This is the highest-value change — eliminates the most complex code.

### Phase 2: Server-Side Removal

Remove `publishViaRelay()`, relay 202 path, and `stream_ready` from `sessions.ts`. Remove relay fan-in from `session-broadcaster.ts`. Delete server relay test files.

### Phase 3: Naming Cleanup & Documentation

Rename "legacy" labels. Update `contributing/architecture.md`.

## Open Questions

None — all decisions were resolved during ideation (see Section 6 of `01-ideation.md`).

## Related ADRs

- ADR-0002: Hexagonal Architecture with Transport Interface — SSE becomes the sole client transport adapter
- Prior relay bug-fix specs document the failure modes being eliminated

## References

- Ideation: `specs/client-direct-sse/01-ideation.md`
- Research: `research/20260312_client_direct_sse_relay_removal.md`
- Related specs: `fix-relay-sse-delivery-pipeline`, `fix-relay-ghost-messages`, `fix-relay-streaming-bugs`, `fix-relay-sse-backpressure`, `fix-relay-history-sse-gaps`

## Files Modified

| File | Change |
|------|--------|
| `apps/client/src/layers/features/chat/model/use-chat-session.ts` | Remove relay branching, refs, effects, staleness timer (~150 lines) |
| `apps/server/src/routes/sessions.ts` | Remove `publishViaRelay()`, relay 202 path, `stream_ready`, imports (~80 lines) |
| `apps/server/src/services/runtimes/claude-code/session-broadcaster.ts` | Remove `setRelay()`, `subscribeToRelay()`, relay fan-in, relay maps (~120 lines) |
| `apps/server/src/index.ts` | Remove `broadcaster.setRelay(relayCore)` call (~1 line) |

## Files Deleted

| File | Reason |
|------|--------|
| `apps/client/src/layers/features/chat/model/__tests__/use-chat-session-relay.test.ts` | Tests relay chat path that no longer exists |
| `apps/server/src/routes/__tests__/sessions-relay.test.ts` | Tests relay dispatch path that no longer exists |
| `apps/server/src/routes/__tests__/sessions-relay-correlation.test.ts` | Tests correlation ID filtering that no longer exists |

## Files Updated (Tests)

| File | Change |
|------|--------|
| `apps/server/src/services/runtimes/claude-code/__tests__/session-broadcaster.test.ts` | Remove relay subscription tests, keep sync/broadcast tests |

## Acceptance Criteria

- Web client sends messages via `transport.sendMessage()` regardless of `DORKOS_RELAY_ENABLED`
- `POST /api/sessions/:id/messages` always streams SSE (never returns 202 for relay)
- `GET /api/sessions/:id/stream` does not emit `stream_ready`
- SessionBroadcaster has no relay dependency (`setRelay()` method removed)
- No "legacy" labels remain on SSE code paths
- All existing tests pass (minus deleted relay-specific tests)
- External adapters (Telegram) continue to work — messages appear via `sync_update`
- `useRelayEnabled()` hook still works (used by relay UI panels, ConnectionsView)
- `sendMessageRelay()` stays on Transport interface (backward compat)
- TypeScript compiles cleanly
- No dead imports remain
