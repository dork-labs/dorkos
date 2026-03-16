---
slug: multi-client-session-indicator
number: 142
created: 2026-03-16
status: specification
---

# Multi-Client Session Indicator — Specification

## Overview

Add a real-time presence indicator to the session status bar showing how many clients are connected to the current session. Hidden when solo (the common case), it animate-appears when a second client connects — a browser tab, Obsidian plugin, or external MCP client. On hover, a popover lists connected client types. When another client holds the write lock, the badge shifts to amber with a lock icon. The badge subtly pulses when a `sync_update` arrives from another client's message.

**Motivation:** P2 punch list item #18 from the Agent SDK audit. Users currently have no way to know another client is connected, causing confusion when messages appear "from nowhere" or when `SESSION_LOCKED` errors occur unexpectedly.

**Ideation:** `specs/multi-client-session-indicator/01-ideation.md`

## Technical Design

### Architecture

The feature builds on existing infrastructure with minimal new surface:

1. **Server:** `SessionBroadcaster` already tracks connected clients per session in `Map<sessionId, Set<Response>>` and has an unused `getClientCount()` method. We extend the broadcaster to track client metadata (type, connection time) and broadcast `presence_update` SSE events on connect/disconnect.

2. **Shared:** Add a `presence_update` SSE event type to the `StreamEvent` discriminated union, plus a `PresenceUpdateEvent` Zod schema carrying client count, client types, and lock state.

3. **Client:** A new `ClientsItem` `StatusLine.Item` component consumes presence data from the existing EventSource in `use-chat-session.ts`. Hidden when `clientCount <= 1`, with a Popover for client type details on hover.

### Data Flow

```
Client A connects → GET /api/sessions/:id/stream?clientId=web-xxx
  → SessionBroadcaster.registerClient(sessionId, res, "web-xxx")
  → Broadcaster updates internal client metadata map
  → Broadcaster broadcasts presence_update to ALL clients for this session:
      { clientCount: 2, clients: [{ type: "web" }, { type: "obsidian" }], lockInfo: null }
  → Client B receives presence_update via EventSource
  → Client B updates local state → ClientsItem shows "2 clients"

Client A disconnects → response 'close' event
  → SessionBroadcaster.deregisterClient removes client
  → Broadcasts updated presence_update: { clientCount: 1, clients: [...], lockInfo: null }
  → Client B receives → ClientsItem hides (count ≤ 1)
```

### Server Changes

#### `session-broadcaster.ts`

**New internal data structure** — replace `Map<sessionId, Set<Response>>` with a richer structure:

```typescript
interface ConnectedClient {
  res: Response;
  clientId: string;
  clientType: 'web' | 'obsidian' | 'mcp' | 'unknown';
  connectedAt: string; // ISO timestamp
}

// Replace: private clients = new Map<string, Set<Response>>();
// With:    private clients = new Map<string, Map<string, ConnectedClient>>();
```

**Client type inference** from `clientId` prefix convention:

```typescript
function inferClientType(clientId: string): ConnectedClient['clientType'] {
  if (clientId.startsWith('web-')) return 'web';
  if (clientId.startsWith('obsidian-')) return 'obsidian';
  if (clientId.startsWith('mcp-')) return 'mcp';
  return 'unknown';
}
```

**Extend `registerClient()`:**
- Accept `clientId` as required (no longer `_clientId` — activate the unused parameter)
- Store `ConnectedClient` in the per-session map keyed by `clientId`
- After registration, call `broadcastPresence(sessionId)` to notify all connected clients

**Extend `deregisterClient()`:**
- After removal, call `broadcastPresence(sessionId)` to notify remaining clients

**New method `broadcastPresence(sessionId)`:**
- Collects current client count, client types, and lock info (from `SessionLockManager`)
- Broadcasts `presence_update` SSE event to all connected clients for this session
- Called on every connect and disconnect

**New method `getPresenceInfo(sessionId)`:**
- Returns `{ clientCount, clients: Array<{ type, connectedAt }>, lockInfo }` for the session
- Used by `broadcastPresence()` internally

**Lock integration:** The broadcaster needs access to `SessionLockManager` to include lock state in presence updates. Inject via constructor parameter or import.

#### `routes/sessions.ts`

**Extend GET `/api/sessions/:id/stream`:**
- Pass `clientId` query parameter to `runtime.watchSession()` (already partially supported)
- Ensure `clientId` is forwarded to `SessionBroadcaster.registerClient()`

The `clientId` query parameter is already parsed at line 278. It just needs to be forwarded through the runtime.

#### `session-lock.ts`

**New method `getLockInfo(sessionId)`:**
- Returns `{ clientId, acquiredAt } | null` for the current lock on a session
- Used by the broadcaster to include lock state in presence updates

### Shared Package Changes

#### `packages/shared/src/schemas.ts`

**Add `PresenceUpdateEvent` schema:**

```typescript
export const PresenceClientSchema = z.object({
  type: z.enum(['web', 'obsidian', 'mcp', 'unknown']),
  connectedAt: z.string(),
});

export type PresenceClient = z.infer<typeof PresenceClientSchema>;

export const PresenceUpdateEventSchema = z.object({
  sessionId: z.string(),
  clientCount: z.number().int(),
  clients: z.array(PresenceClientSchema),
  lockInfo: z.object({
    clientId: z.string(),
    acquiredAt: z.string(),
  }).nullable(),
}).openapi('PresenceUpdateEvent');

export type PresenceUpdateEvent = z.infer<typeof PresenceUpdateEventSchema>;
```

**Add `'presence_update'` to `StreamEventTypeSchema` enum** and `PresenceUpdateEventSchema` to the `StreamEventSchema` data union.

### Client Changes

#### `use-chat-session.ts`

**Add `presence_update` listener** to the existing EventSource setup (around line 290):

```typescript
const [presenceInfo, setPresenceInfo] = useState<PresenceUpdateEvent | null>(null);

// Inside EventSource setup:
eventSource.addEventListener('presence_update', (e) => {
  const data = JSON.parse(e.data) as PresenceUpdateEvent;
  setPresenceInfo(data);
});
```

**Pulse detection:** Track when a `sync_update` arrives while `presenceInfo.clientCount > 1` to trigger a badge pulse animation. Use a ref to set a brief boolean flag:

```typescript
const [presencePulse, setPresencePulse] = useState(false);

eventSource.addEventListener('sync_update', () => {
  // Existing query invalidation...
  if (presenceInfoRef.current && presenceInfoRef.current.clientCount > 1) {
    setPresencePulse(true);
    setTimeout(() => setPresencePulse(false), 1000);
  }
});
```

**Return `presenceInfo` and `presencePulse`** from the hook for ChatStatusSection to consume.

#### New component: `ClientsItem.tsx`

Location: `apps/client/src/layers/features/status/ui/ClientsItem.tsx`

A `StatusLine.Item`-compatible component following the CostItem pattern:

```typescript
interface ClientsItemProps {
  clientCount: number;
  clients: PresenceClient[];
  lockInfo: PresenceUpdateEvent['lockInfo'];
  pulse: boolean;
}
```

**Visual states:**

1. **Hidden** (`clientCount <= 1`): Not rendered — handled by `StatusLine.Item visible` prop.
2. **Normal** (`clientCount > 1`, no lock): `Users` icon + "{N} clients" in default muted foreground.
3. **Locked** (`lockInfo !== null`): `Lock` icon + amber text + "Locked" tooltip.
4. **Pulse**: Brief scale-up animation on the badge when `pulse` is true (using `motion`).

**Popover on hover/click:** Lists connected client types using friendly names:
- `web` → "Web browser"
- `obsidian` → "Obsidian plugin"
- `mcp` → "External client"
- `unknown` → "Unknown client"

Uses the existing Shadcn `Popover` component. Minimal: just a list of client types with connection duration (relative time like "2m ago").

#### `ChatStatusSection.tsx`

**Wire `ClientsItem` into the StatusLine** (after the `version` item):

```tsx
<StatusLine.Item
  itemKey="clients"
  visible={!!presenceInfo && presenceInfo.clientCount > 1}
>
  {presenceInfo && (
    <ClientsItem
      clientCount={presenceInfo.clientCount}
      clients={presenceInfo.clients}
      lockInfo={presenceInfo.lockInfo}
      pulse={presencePulse}
    />
  )}
</StatusLine.Item>
```

**No new app-store toggle** — always visible when multi-client. The `visible={clientCount > 1}` prop already hides it in the common solo case, so there's no noise to toggle off.

#### `app-store.ts`

No changes needed. This item is always-on when relevant (multi-client). Unlike cost or git status which are always-available data, client count is an exceptional condition that warrants unconditional display.

### Client ID Convention

Clients must send a typed prefix in their `clientId`:

| Client | Prefix | Example |
|--------|--------|---------|
| Web browser | `web-` | `web-a1b2c3d4` |
| Obsidian plugin | `obsidian-` | `obsidian-x9y8z7` |
| MCP server | `mcp-` | `mcp-external-1` |
| Unknown/legacy | (none) | `cb-1710000000-abc123` |

The web client already generates a `clientId` (currently a UUID). Prefix it with `web-`.

The Obsidian plugin should prefix with `obsidian-` when it connects.

The MCP server should prefix with `mcp-` when it establishes SSE connections on behalf of external agents.

## Implementation Phases

### Phase 1: Server Infrastructure (S effort)

1. Add `PresenceUpdateEventSchema` and `PresenceClient` to `packages/shared/src/schemas.ts`
2. Add `'presence_update'` to `StreamEventTypeSchema` enum
3. Add `PresenceUpdateEventSchema` to `StreamEventSchema` data union
4. Add `getLockInfo(sessionId)` to `SessionLockManager`
5. Refactor `SessionBroadcaster` internal data structure to track client metadata
6. Activate `_clientId` parameter in `registerClient()`
7. Add `broadcastPresence()` method — called on register and deregister
8. Add `inferClientType()` helper

### Phase 2: Client Integration (S effort)

1. Create `ClientsItem.tsx` component with Users/Lock icon states and pulse animation
2. Add `presence_update` listener to `use-chat-session.ts` EventSource setup
3. Add pulse detection on `sync_update` when multi-client
4. Wire into `ChatStatusSection.tsx` as a new `StatusLine.Item`
5. Export from `features/status/index.ts` barrel

### Phase 3: Popover Detail (XS effort)

1. Add hover/click Popover to `ClientsItem` showing client type list with connection duration
2. Use existing Shadcn `Popover` component

### Phase 4: Client ID Prefixing (XS effort)

1. Prefix web client's existing `clientId` with `web-`
2. Document convention for Obsidian plugin and MCP server (implementation deferred to those codebases)

## Acceptance Criteria

- [ ] When only one client is connected, no indicator is visible
- [ ] When a second client connects via SSE, a "2 clients" badge animates into the status bar within 1 second
- [ ] When that client disconnects, the badge animates out
- [ ] Hovering/clicking the badge shows a popover listing client types ("Web browser", "Obsidian plugin", etc.)
- [ ] When another client holds the session write lock, the badge shows an amber Lock icon with "Locked by another client" tooltip
- [ ] When a `sync_update` arrives from another client, the badge briefly pulses
- [ ] The `presence_update` SSE event is sent to all connected clients on every connect/disconnect
- [ ] Client count updates reflect actual SSE connection state (no ghost connections persisting beyond TCP close)
- [ ] The feature works correctly with the existing session locking mechanism (`X-Client-Id`, `SESSION_LOCKED`)
- [ ] All existing tests continue to pass (SessionBroadcaster tests updated)

## Non-Regression

- Existing `sync_connected` and `sync_update` SSE events continue to work unchanged
- Session locking behavior unchanged — presence indicator is read-only visibility, not a new lock mechanism
- No performance impact on message streaming (presence events only fire on connect/disconnect)
- Backward compatible: clients that don't send `clientId` are tracked as `unknown` type

## Testing Strategy

### Unit Tests

- `SessionBroadcaster`: Test `broadcastPresence()` fires on register/deregister with correct counts and client types
- `SessionBroadcaster`: Test `inferClientType()` for each prefix and unknown fallback
- `SessionLockManager`: Test new `getLockInfo()` returns correct lock state
- `ClientsItem.tsx`: Test hidden when count <= 1, visible with count, amber lock state, pulse animation class

### Integration Tests

- SSE stream: Connect two clients, verify both receive `presence_update` with `clientCount: 2`
- SSE stream: Disconnect one, verify remaining receives `presence_update` with `clientCount: 1`
- Lock integration: One client acquires lock, verify presence update includes `lockInfo`

## File Manifest

| File | Change | Phase |
|------|--------|-------|
| `packages/shared/src/schemas.ts` | Add `PresenceClient`, `PresenceUpdateEvent` schemas, extend enum + union | 1 |
| `apps/server/src/services/runtimes/claude-code/session-broadcaster.ts` | Track client metadata, broadcast presence on connect/disconnect | 1 |
| `apps/server/src/services/runtimes/claude-code/session-lock.ts` | Add `getLockInfo()` method | 1 |
| `apps/client/src/layers/features/status/ui/ClientsItem.tsx` | **New** — StatusLine.Item with Users/Lock icons, pulse, popover | 2-3 |
| `apps/client/src/layers/features/chat/model/use-chat-session.ts` | Add `presence_update` listener, pulse detection | 2 |
| `apps/client/src/layers/features/chat/ui/ChatStatusSection.tsx` | Wire `ClientsItem` into StatusLine | 2 |
| `apps/client/src/layers/features/status/index.ts` | Export `ClientsItem` | 2 |

## Out of Scope

- Real-time collaborative editing or cursor presence
- Conflict resolution UI beyond existing `SESSION_LOCKED` error
- Multi-user session support
- Per-message client attribution in JSONL transcripts
- Heartbeat-based ghost connection detection (can be added later if stale counts become a problem)
- Settings toggle for this indicator (always-on when multi-client; no noise when solo)
