---
slug: cross-client-session-sync
---

# Cross-Client Session Synchronization -- Tasks

## Phase 1: Polling + Session Locking

### Task 1: [cross-client-session-sync] [P1] Add session locking to AgentManager

**File:** `apps/server/src/services/agent-manager.ts`
**Test File:** `apps/server/src/services/__tests__/agent-manager-locking.test.ts`

Add a session lock mechanism to prevent concurrent sends to the same session. The lock is acquired when a client starts streaming (POST `/messages`) and released when the SSE connection closes or the stream completes.

**New types to add:**

```typescript
interface SessionLock {
  clientId: string; // Unique identifier for the locking client
  acquiredAt: number; // Date.now() when lock was acquired
  ttl: number; // 5 * 60 * 1000 (5 minutes)
  response: Response; // Express Response for connection-tied cleanup
}
```

**New state in AgentManager:**

```typescript
export class AgentManager {
  // Existing:
  private sessions = new Map<string, AgentSession>();

  // New:
  private sessionLocks = new Map<string, SessionLock>();
  private readonly LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes
```

**New methods to implement:**

```typescript
acquireLock(sessionId: string, clientId: string, res: Response): boolean {
  const existing = this.sessionLocks.get(sessionId);
  if (existing) {
    const expired = Date.now() - existing.acquiredAt > existing.ttl;
    if (!expired && existing.clientId !== clientId) {
      return false;
    }
  }
  const lock: SessionLock = {
    clientId,
    acquiredAt: Date.now(),
    ttl: this.LOCK_TTL_MS,
    response: res,
  };
  this.sessionLocks.set(sessionId, lock);
  res.on('close', () => {
    const current = this.sessionLocks.get(sessionId);
    if (current && current.clientId === clientId) {
      this.sessionLocks.delete(sessionId);
    }
  });
  return true;
}

releaseLock(sessionId: string, clientId: string): void {
  const lock = this.sessionLocks.get(sessionId);
  if (lock && lock.clientId === clientId) {
    this.sessionLocks.delete(sessionId);
  }
}

isLocked(sessionId: string, clientId?: string): boolean {
  const lock = this.sessionLocks.get(sessionId);
  if (!lock) return false;
  if (Date.now() - lock.acquiredAt > lock.ttl) {
    this.sessionLocks.delete(sessionId);
    return false;
  }
  if (clientId && lock.clientId === clientId) return false;
  return true;
}

getLockInfo(sessionId: string): { clientId: string; acquiredAt: number } | null {
  const lock = this.sessionLocks.get(sessionId);
  if (!lock) return null;
  if (Date.now() - lock.acquiredAt > lock.ttl) {
    this.sessionLocks.delete(sessionId);
    return null;
  }
  return { clientId: lock.clientId, acquiredAt: lock.acquiredAt };
}
```

**Modify `checkSessionHealth()` to also clean up expired locks:**

```typescript
checkSessionHealth(): void {
  const now = Date.now();
  for (const [id, session] of this.sessions) {
    if (now - session.lastActivity > this.SESSION_TIMEOUT_MS) {
      for (const interaction of session.pendingInteractions.values()) {
        clearTimeout(interaction.timeout);
      }
      this.sessions.delete(id);
      this.sessionLocks.delete(id); // Clean up stale locks too
    }
  }
  for (const [id, lock] of this.sessionLocks) {
    if (now - lock.acquiredAt > lock.ttl) {
      this.sessionLocks.delete(id);
    }
  }
}
```

**Tests (agent-manager-locking.test.ts):**

```typescript
describe('Session Locking', () => {
  it('acquires lock on unlocked session');
  it('rejects lock when session is locked by another client');
  it('allows same client to re-acquire their own lock');
  it('allows lock after TTL expiry');
  it('releases lock on explicit release');
  it('releases lock when response closes (connection drop)');
  it('cleans up expired locks in checkSessionHealth');
  it('isLocked returns false for unlocked sessions');
  it('isLocked returns false for own lock with clientId');
  it('getLockInfo returns null for unlocked sessions');
  it('getLockInfo returns info for locked sessions');
});
```

Use mock Express `Response` objects with `on('close', cb)` support. Test TTL by manipulating `acquiredAt` timestamps.

**Acceptance Criteria:**

- `acquireLock()` returns true for unlocked sessions, false when locked by another client
- Same client can re-acquire their own lock
- Expired locks (> 5 min TTL) are treated as unlocked
- Lock auto-releases when Express Response 'close' event fires
- `checkSessionHealth()` cleans up expired locks
- All 11 test cases pass

---

### Task 2: [cross-client-session-sync] [P1] Add ETag support to transcript reader and GET /messages

**Files:**

- `apps/server/src/services/transcript-reader.ts`
- `apps/server/src/routes/sessions.ts`

**Test Files:**

- `apps/server/src/services/__tests__/transcript-reader.test.ts` (add to existing)
- `apps/server/src/routes/__tests__/sessions.test.ts` (add to existing or create)

Add `getTranscriptETag()` to TranscriptReader:

```typescript
async getTranscriptETag(vaultRoot: string, sessionId: string): Promise<string | null> {
  const filePath = path.join(this.getTranscriptsDir(vaultRoot), `${sessionId}.jsonl`);
  try {
    const stat = await fs.stat(filePath);
    return `"${stat.mtimeMs}-${stat.size}"`;
  } catch {
    return null;
  }
}
```

Modify `GET /:id/messages` route to support ETag/If-None-Match:

```typescript
router.get('/:id/messages', async (req, res) => {
  const cwd = (req.query.cwd as string) || vaultRoot;

  const etag = await transcriptReader.getTranscriptETag(cwd, req.params.id);
  if (etag) {
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }
  }

  const messages = await transcriptReader.readTranscript(cwd, req.params.id);
  res.json({ messages });
});
```

**Tests:**

```typescript
describe('getTranscriptETag', () => {
  it('returns ETag string based on mtime and size');
  it('returns null when file does not exist');
  it('returns different ETag after file is modified');
});

describe('GET /:id/messages with ETag', () => {
  it('returns ETag header on successful response');
  it('returns 304 when If-None-Match matches');
  it('returns 200 with new ETag when content changed');
});
```

**Acceptance Criteria:**

- Server returns ETag header on GET /messages responses
- Returns 304 Not Modified when If-None-Match matches current ETag
- ETag is based on file mtime + size (fast, no JSONL parsing)
- Returns null ETag when transcript file doesn't exist

**Dependencies:** None

---

### Task 3: [cross-client-session-sync] [P1] Add session lock check to POST /messages route and SessionLockedError schema

**Files:**

- `apps/server/src/routes/sessions.ts`
- `packages/shared/src/schemas.ts`

**Test File:** `apps/server/src/routes/__tests__/sessions.test.ts`

Add `SessionLockedErrorSchema` to shared schemas:

```typescript
export const SessionLockedErrorSchema = z
  .object({
    error: z.string(),
    code: z.literal('SESSION_LOCKED'),
    lockedSince: z.string().datetime().optional(),
  })
  .openapi('SessionLockedError');

export type SessionLockedError = z.infer<typeof SessionLockedErrorSchema>;
```

Modify `POST /:id/messages` to acquire lock and return 409:

```typescript
router.post('/:id/messages', async (req, res) => {
  const parsed = SendMessageRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.format() });
  }
  const { content, cwd } = parsed.data;
  const sessionId = req.params.id;

  const clientId = (req.headers['x-client-id'] as string) || crypto.randomUUID();

  if (agentManager.isLocked(sessionId, clientId)) {
    const lockInfo = agentManager.getLockInfo(sessionId);
    return res.status(409).json({
      error: 'Session is busy',
      code: 'SESSION_LOCKED',
      lockedSince: lockInfo?.acquiredAt ? new Date(lockInfo.acquiredAt).toISOString() : undefined,
    });
  }

  if (!agentManager.acquireLock(sessionId, clientId, res)) {
    return res.status(409).json({
      error: 'Session is busy',
      code: 'SESSION_LOCKED',
    });
  }

  initSSEStream(res);

  try {
    for await (const event of agentManager.sendMessage(sessionId, content, { cwd })) {
      sendSSEEvent(res, event);
      if (event.type === 'done') {
        const actualSdkId = agentManager.getSdkSessionId(sessionId);
        if (actualSdkId && actualSdkId !== sessionId) {
          sendSSEEvent(res, {
            type: 'done',
            data: { sessionId: actualSdkId },
          });
        }
      }
    }
  } catch (err) {
    sendSSEEvent(res, {
      type: 'error',
      data: { message: err instanceof Error ? err.message : 'Unknown error' },
    });
  } finally {
    agentManager.releaseLock(sessionId, clientId);
    endSSEStream(res);
  }
});
```

**Tests:**

```typescript
describe('POST /:id/messages with locking', () => {
  it('acquires lock and streams response');
  it('returns 409 when session is locked by another client');
  it('includes SESSION_LOCKED code in 409 response');
  it('releases lock after stream completes');
});
```

**Acceptance Criteria:**

- POST /messages returns 409 with `{ error, code: 'SESSION_LOCKED', lockedSince? }` when locked
- Lock is acquired before streaming begins
- Lock is released in finally block after stream completes
- X-Client-Id header used for lock ownership; falls back to random UUID
- `SessionLockedErrorSchema` added to shared schemas

**Dependencies:** Task 1 (session locking in AgentManager)

---

### Task 4: [cross-client-session-sync] [P1] Add adaptive polling and message merge to useChatSession

**File:** `apps/client/src/hooks/use-chat-session.ts`
**Test File:** `apps/client/src/hooks/__tests__/use-chat-session-polling.test.tsx`

Extract `mapHistoryMessage()` helper to avoid duplication:

```typescript
function mapHistoryMessage(m: HistoryMessage): ChatMessage {
  const parts: MessagePart[] = m.parts ? [...m.parts] : [];
  if (parts.length === 0) {
    if (m.content) parts.push({ type: 'text', text: m.content });
    if (m.toolCalls) {
      for (const tc of m.toolCalls) {
        parts.push({
          type: 'tool_call',
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: tc.input,
          result: tc.result,
          status: tc.status,
          ...(tc.questions
            ? {
                interactiveType: 'question' as const,
                questions: tc.questions,
                answers: tc.answers,
              }
            : {}),
        });
      }
    }
  }
  const derived = deriveFromParts(parts);
  return {
    id: m.id,
    role: m.role,
    content: derived.content,
    toolCalls: derived.toolCalls.length > 0 ? derived.toolCalls : undefined,
    parts,
    timestamp: m.timestamp || '',
    messageType: m.messageType,
    commandName: m.commandName,
    commandArgs: m.commandArgs,
  };
}
```

Modify the `useQuery` for message history to add adaptive polling:

```typescript
const historyQuery = useQuery({
  queryKey: ['messages', sessionId, selectedCwd],
  queryFn: () => transport.getMessages(sessionId, selectedCwd ?? undefined),
  staleTime: 0,
  refetchInterval: (query) => {
    if (status !== 'idle') return false;
    const lastMsg = query.state.data?.messages?.at(-1);
    if (!lastMsg?.timestamp) return 10_000;
    const ageMs = Date.now() - new Date(lastMsg.timestamp).getTime();
    const fiveMinutes = 5 * 60 * 1000;
    return ageMs < fiveMinutes ? 3_000 : 10_000;
  },
  refetchIntervalInBackground: false,
});
```

Add merge logic for polled updates:

```typescript
useEffect(() => {
  if (!historyQuery.data || status !== 'idle') return;
  const history = historyQuery.data.messages;
  if (!historySeededRef.current) {
    if (history.length > 0) {
      historySeededRef.current = true;
      setMessages(history.map((m) => mapHistoryMessage(m)));
    }
    return;
  }
  if (history.length > messages.length) {
    setMessages(history.map((m) => mapHistoryMessage(m)));
  }
}, [historyQuery.data, status]);
```

**Tests:**

```typescript
describe('useChatSession polling', () => {
  it('polls at 3s intervals for recently active sessions');
  it('polls at 10s intervals for idle sessions');
  it('stops polling while streaming');
  it('does not poll when tab is in background');
  it('merges polled messages into existing state');
});
```

**Acceptance Criteria:**

- Polling runs at 3s for sessions active within last 5 minutes, 10s otherwise
- Polling stops while client is actively streaming
- Polling stops when tab is in background (`refetchIntervalInBackground: false`)
- New messages from polls merge into existing message list
- `mapHistoryMessage()` extracted as reusable helper, used for both initial seed and poll merge
- `staleTime: 0` so ETag check happens on every poll

**Dependencies:** Task 2 (ETag support, so polls are efficient)

---

### Task 5: [cross-client-session-sync] [P1] Add ETag caching, 409 handling, and client ID to HttpTransport

**File:** `apps/client/src/lib/http-transport.ts`

Add `clientId`, `etagCache`, and `messageCache` to HttpTransport:

```typescript
export class HttpTransport implements Transport {
  private readonly clientId: string;
  private etagCache = new Map<string, string>();
  private messageCache = new Map<string, { messages: HistoryMessage[] }>();

  constructor(private baseUrl: string) {
    this.clientId = crypto.randomUUID();
  }
}
```

Update `getMessages` to use ETag:

```typescript
getMessages(sessionId: string, cwd?: string): Promise<{ messages: HistoryMessage[] }> {
  const params = new URLSearchParams();
  if (cwd) params.set('cwd', cwd);
  const qs = params.toString();

  const cacheKey = `etag:messages:${sessionId}:${cwd || ''}`;
  const cachedEtag = this.etagCache.get(cacheKey);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cachedEtag) {
    headers['If-None-Match'] = cachedEtag;
  }

  return fetch(`${this.baseUrl}/sessions/${sessionId}/messages${qs ? `?${qs}` : ''}`, {
    headers,
  }).then(async (res) => {
    if (res.status === 304) {
      return this.messageCache.get(cacheKey) || { messages: [] };
    }
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(error.error || `HTTP ${res.status}`);
    }
    const etag = res.headers.get('etag');
    if (etag) {
      this.etagCache.set(cacheKey, etag);
    }
    const data = await res.json();
    this.messageCache.set(cacheKey, data);
    return data;
  });
}
```

Handle 409 in `sendMessage`:

```typescript
async sendMessage(
  sessionId: string,
  content: string,
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal,
  cwd?: string,
): Promise<void> {
  const response = await fetch(`${this.baseUrl}/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Client-Id': this.clientId,
    },
    body: JSON.stringify({ content, ...(cwd && { cwd }) }),
    signal,
  });

  if (response.status === 409) {
    const error = await response.json().catch(() => ({}));
    const err = new Error(error.error || 'Session is busy');
    (err as Record<string, unknown>).code = 'SESSION_LOCKED';
    throw err;
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  // ... existing SSE parsing logic unchanged ...
}
```

**Acceptance Criteria:**

- HttpTransport generates a stable `clientId` (UUID) per instance
- `getMessages()` sends `If-None-Match` header with cached ETag
- Returns cached data on 304 response
- Stores ETag and message data in caches on 200 response
- `sendMessage()` sends `X-Client-Id` header
- `sendMessage()` throws error with `code: 'SESSION_LOCKED'` on 409

**Dependencies:** Task 2 (server ETag support), Task 3 (server lock check on POST)

---

### Task 6: [cross-client-session-sync] [P1] Add sessionBusy state and UI indicator

**File:** `apps/client/src/hooks/use-chat-session.ts`
**Test File:** `apps/client/src/hooks/__tests__/use-chat-session-polling.test.tsx` (add to existing from Task 4)

Add `sessionBusy` state:

```typescript
const [sessionBusy, setSessionBusy] = useState(false);

// In handleSubmit:
try {
  // ... existing send logic ...
} catch (err) {
  if ((err as Record<string, unknown>).code === 'SESSION_LOCKED') {
    setSessionBusy(true);
    setTimeout(() => setSessionBusy(false), 5000);
  } else if ((err as Error).name !== 'AbortError') {
    setError((err as Error).message);
    setStatus('error');
  }
}
```

Expose `sessionBusy` from the hook return value. The `ChatInput` component should disable the send button and show a "Session is busy" indicator when `sessionBusy` is true. The user's typed message should remain in the input on 409 (not cleared).

**Tests:**

```typescript
describe('useChatSession session busy', () => {
  it('sets sessionBusy on 409 response');
  it('clears sessionBusy after timeout');
  it('preserves input text on 409');
});
```

**Acceptance Criteria:**

- `sessionBusy` is true when a 409 SESSION_LOCKED error is received
- Auto-clears after 5 seconds
- User's typed message stays in the input field (not cleared)
- Send button disabled while `sessionBusy` is true
- "Session is busy" indicator visible in chat input area

**Dependencies:** Task 5 (HttpTransport 409 handling)

---

## Phase 2: File Watching + SSE Broadcast

### Task 7: [cross-client-session-sync] [P2] Add sync event types to shared schemas and install chokidar

**Files:**

- `packages/shared/src/schemas.ts`
- `apps/server/package.json`

Add new event types to `StreamEventTypeSchema`:

```typescript
export const StreamEventTypeSchema = z
  .enum([
    'text_delta',
    'tool_call_start',
    'tool_call_delta',
    'tool_call_end',
    'tool_result',
    'approval_required',
    'question_prompt',
    'error',
    'done',
    'session_status',
    'task_update',
    // Phase 2: sync events
    'sync_update',
    'sync_connected',
  ])
  .openapi('StreamEventType');
```

Install chokidar:

```bash
npm install chokidar@^4.0 -w apps/server
```

**Acceptance Criteria:**

- `sync_update` and `sync_connected` added to StreamEventTypeSchema enum
- `chokidar` v4+ added to `apps/server/package.json` dependencies
- `turbo typecheck` passes

**Dependencies:** None

---

### Task 8: [cross-client-session-sync] [P2] Add readFromOffset to TranscriptReader

**File:** `apps/server/src/services/transcript-reader.ts`
**Test File:** `apps/server/src/services/__tests__/transcript-reader.test.ts` (add to existing)

Add incremental reading method:

```typescript
async readFromOffset(
  vaultRoot: string,
  sessionId: string,
  fromOffset: number,
): Promise<{ content: string; newOffset: number }> {
  const filePath = path.join(this.getTranscriptsDir(vaultRoot), `${sessionId}.jsonl`);
  const stat = await fs.stat(filePath);

  if (stat.size <= fromOffset) {
    return { content: '', newOffset: fromOffset };
  }

  const fileHandle = await fs.open(filePath, 'r');
  try {
    const newBytes = stat.size - fromOffset;
    const buffer = Buffer.alloc(newBytes);
    await fileHandle.read(buffer, 0, newBytes, fromOffset);
    return {
      content: buffer.toString('utf-8'),
      newOffset: stat.size,
    };
  } finally {
    await fileHandle.close();
  }
}
```

**Tests:**

```typescript
describe('readFromOffset', () => {
  it('returns empty content when file has not grown');
  it('returns new content from offset to end of file');
  it('updates newOffset to current file size');
  it('reads only appended bytes, not full file');
});
```

**Acceptance Criteria:**

- Reads only bytes after `fromOffset`, not the full file
- Returns empty content and same offset when file hasn't grown
- Returns new content and updated offset on file growth
- Properly closes file handle in all cases (finally block)

**Dependencies:** None

---

### Task 9: [cross-client-session-sync] [P2] Create SessionBroadcaster service

**File:** `apps/server/src/services/session-broadcaster.ts` (NEW)
**Test File:** `apps/server/src/services/__tests__/session-broadcaster.test.ts` (NEW)

Create the core session broadcaster service that manages chokidar file watchers and SSE broadcast connections:

```typescript
import type { Response } from 'express';
import type { HistoryMessage } from '@dorkos/shared/types';
import chokidar from 'chokidar';
import fs from 'fs/promises';
import path from 'path';
import { sendSSEEvent, initSSEStream } from './stream-adapter.js';
import { transcriptReader } from './transcript-reader.js';

interface SessionWatch {
  watcher: chokidar.FSWatcher;
  clients: Set<Response>;
  filePath: string;
  byteOffset: number;
  vaultRoot: string;
  debounceTimer?: ReturnType<typeof setTimeout>;
}

export class SessionBroadcaster {
  private watches = new Map<string, SessionWatch>();

  async register(sessionId: string, res: Response, vaultRoot: string): Promise<void> {
    let watch = this.watches.get(sessionId);

    if (!watch) {
      const transcriptsDir = transcriptReader.getTranscriptsDir(vaultRoot);
      const filePath = path.join(transcriptsDir, `${sessionId}.jsonl`);

      let initialOffset = 0;
      try {
        const stat = await fs.stat(filePath);
        initialOffset = stat.size;
      } catch {
        /* File may not exist yet */
      }

      const watcher = chokidar.watch(filePath, {
        persistent: true,
        awaitWriteFinish: {
          stabilityThreshold: 100,
          pollInterval: 50,
        },
        ignoreInitial: true,
      });

      watch = {
        watcher,
        clients: new Set(),
        filePath,
        byteOffset: initialOffset,
        vaultRoot,
      };

      this.watches.set(sessionId, watch);

      watcher.on('change', () => {
        this.onFileChange(sessionId);
      });
    }

    watch.clients.add(res);
    initSSEStream(res);

    res.on('close', () => {
      this.deregister(sessionId, res);
    });
  }

  deregister(sessionId: string, res: Response): void {
    const watch = this.watches.get(sessionId);
    if (!watch) return;
    watch.clients.delete(res);
    if (watch.clients.size === 0) {
      watch.watcher.close();
      if (watch.debounceTimer) clearTimeout(watch.debounceTimer);
      this.watches.delete(sessionId);
    }
  }

  private onFileChange(sessionId: string): void {
    const watch = this.watches.get(sessionId);
    if (!watch) return;
    if (watch.debounceTimer) clearTimeout(watch.debounceTimer);
    watch.debounceTimer = setTimeout(() => {
      this.readAndBroadcast(sessionId).catch((err) => {
        console.error(`[SessionBroadcaster] Error reading ${sessionId}:`, err);
      });
    }, 50);
  }

  private async readAndBroadcast(sessionId: string): Promise<void> {
    const watch = this.watches.get(sessionId);
    if (!watch || watch.clients.size === 0) return;

    try {
      const stat = await fs.stat(watch.filePath);
      if (stat.size <= watch.byteOffset) return;

      const fileHandle = await fs.open(watch.filePath, 'r');
      try {
        const newBytes = stat.size - watch.byteOffset;
        const buffer = Buffer.alloc(newBytes);
        await fileHandle.read(buffer, 0, newBytes, watch.byteOffset);
        watch.byteOffset = stat.size;

        const newContent = buffer.toString('utf-8');
        const lines = newContent.split('\n').filter((l) => l.trim());

        const hasNewMessages = lines.some((line) => {
          try {
            const p = JSON.parse(line);
            return p.type === 'user' || p.type === 'assistant';
          } catch {
            return false;
          }
        });

        if (hasNewMessages) {
          this.broadcast(sessionId, {
            type: 'sync_update',
            data: {
              sessionId,
              timestamp: new Date().toISOString(),
            },
          });
        }
      } finally {
        await fileHandle.close();
      }
    } catch (err) {
      console.error(`[SessionBroadcaster] read error for ${sessionId}:`, err);
    }
  }

  private broadcast(sessionId: string, event: { type: string; data: unknown }): void {
    const watch = this.watches.get(sessionId);
    if (!watch) return;
    for (const client of watch.clients) {
      try {
        sendSSEEvent(client, event as import('@dorkos/shared/types').StreamEvent);
      } catch {
        /* Client may have disconnected */
      }
    }
  }

  async shutdown(): Promise<void> {
    for (const [, watch] of this.watches) {
      watch.watcher.close();
      if (watch.debounceTimer) clearTimeout(watch.debounceTimer);
      for (const client of watch.clients) {
        try {
          client.end();
        } catch {
          /* ignore */
        }
      }
    }
    this.watches.clear();
  }
}

export const sessionBroadcaster = new SessionBroadcaster();
```

**Tests:**

```typescript
describe('SessionBroadcaster', () => {
  it('starts watcher on first client registration');
  it('stops watcher when last client deregisters');
  it('broadcasts sync_update when JSONL file changes');
  it('does not broadcast for non-message JSONL lines');
  it('handles concurrent file changes with debouncing');
  it('cleans up on client disconnect (res.close)');
  it('shutdown closes all watchers and clients');
  it('uses incremental byte offset (not full re-read)');
});
```

Mock chokidar with `vi.mock('chokidar')`, use mock Response objects, and mock `fs/promises`.

**Acceptance Criteria:**

- File watcher starts on first client registration for a session
- File watcher stops when last client disconnects
- `sync_update` SSE event broadcast to all connected clients when JSONL changes with new user/assistant messages
- Non-message JSONL lines (system, init) do not trigger broadcast
- Debouncing (50ms) prevents partial reads during rapid writes
- `shutdown()` closes all watchers and client connections
- Incremental byte offset tracking (not full file re-read)

**Dependencies:** Task 7 (sync event types, chokidar), Task 8 (readFromOffset)

---

### Task 10: [cross-client-session-sync] [P2] Add persistent SSE stream endpoint and graceful shutdown

**Files:**

- `apps/server/src/routes/sessions.ts`
- `apps/server/src/index.ts`

Add `GET /:id/stream` endpoint:

```typescript
// GET /api/sessions/:id/stream - Persistent SSE for session sync
router.get('/:id/stream', async (req, res) => {
  const cwd = (req.query.cwd as string) || vaultRoot;
  const sessionId = req.params.id;

  const session = await transcriptReader.getSession(cwd, sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  await sessionBroadcaster.register(sessionId, res, cwd);

  sendSSEEvent(res, {
    type: 'sync_connected',
    data: { sessionId },
  } as StreamEvent);
});
```

Import `sessionBroadcaster` in the routes file.

Add graceful shutdown in `apps/server/src/index.ts`:

```typescript
import { sessionBroadcaster } from './services/session-broadcaster.js';

// In shutdown handler:
process.on('SIGTERM', async () => {
  await sessionBroadcaster.shutdown();
  // ... existing shutdown logic ...
});
process.on('SIGINT', async () => {
  await sessionBroadcaster.shutdown();
  // ... existing shutdown logic ...
});
```

**Tests (in route tests):**

```typescript
describe('GET /:id/stream', () => {
  it('returns 404 for non-existent session');
  it('establishes SSE connection with sync_connected event');
  it('handles multiple clients on same session');
  it('cleans up watcher when all clients disconnect');
});
```

**Acceptance Criteria:**

- `GET /api/sessions/:id/stream` establishes persistent SSE connection
- Returns 404 if session doesn't exist
- Sends `sync_connected` event on initial connection
- Graceful shutdown calls `sessionBroadcaster.shutdown()`
- Multiple clients can subscribe to the same session

**Dependencies:** Task 9 (SessionBroadcaster service)

---

### Task 11: [cross-client-session-sync] [P2] Add client EventSource subscription for real-time sync

**File:** `apps/client/src/hooks/use-chat-session.ts`

Add EventSource subscription that invalidates TanStack Query on `sync_update`:

```typescript
import { useQueryClient } from '@tanstack/react-query';

// Inside useChatSession:
const queryClient = useQueryClient();

useEffect(() => {
  if (!sessionId || status === 'streaming') return;

  const baseUrl = (transport as HttpTransport).baseUrl;
  const params = new URLSearchParams();
  if (selectedCwd) params.set('cwd', selectedCwd);
  const qs = params.toString();

  const eventSource = new EventSource(
    `${baseUrl}/sessions/${sessionId}/stream${qs ? `?${qs}` : ''}`
  );

  eventSource.addEventListener('sync_update', () => {
    queryClient.invalidateQueries({
      queryKey: ['messages', sessionId, selectedCwd],
    });
  });

  eventSource.addEventListener('error', () => {
    // EventSource auto-reconnects; polling is fallback
  });

  return () => {
    eventSource.close();
  };
}, [sessionId, selectedCwd, status, queryClient]);
```

Note: This hook needs access to the transport's `baseUrl`. If `HttpTransport` doesn't expose it publicly, add a getter or pass the base URL through context.

**Acceptance Criteria:**

- EventSource connection opened when viewing a session (idle state)
- EventSource closed when session changes or component unmounts
- `sync_update` events trigger TanStack Query invalidation for immediate re-fetch
- EventSource not opened while actively streaming
- Polling continues as fallback during EventSource reconnection
- CLI-originated messages appear in WebUI without refresh

**Dependencies:** Task 10 (server stream endpoint), Task 4 (polling as fallback)

---

### Task 12: [cross-client-session-sync] [P2] Update AGENTS.md and API reference documentation

**Files:**

- `AGENTS.md`
- `guides/api-reference.md`

Add to AGENTS.md "Server" section under services:

> **`services/session-broadcaster.ts`** (Phase 2) - Manages chokidar file watchers and SSE broadcast connections for cross-client session sync. Watches active session JSONL files, detects changes, and pushes `sync_update` events to all connected clients. Start watching on first client subscription, stop on last disconnect.

Add to "SSE Streaming Protocol" section:

> **Persistent SSE (Phase 2):** In addition to the per-POST streaming, clients can subscribe to `GET /api/sessions/:id/stream` for persistent SSE that broadcasts sync events. Event types: `sync_connected` (initial handshake), `sync_update` (new messages available -- client should re-fetch).

Add to "Session Architecture" section:

> **Session Locking:** Only one client can send messages to a session at a time. Lock is acquired on `POST /messages` and released when the SSE stream ends or the connection closes. Lock auto-expires after 5 minutes (TTL). Other clients receive 409 Conflict with `SESSION_LOCKED` code.

Update `guides/api-reference.md` with:

- `GET /api/sessions/:id/stream` endpoint documentation
- 409 Conflict response documentation for POST /messages

**Acceptance Criteria:**

- AGENTS.md updated with session-broadcaster service description
- AGENTS.md updated with persistent SSE protocol description
- AGENTS.md updated with session locking description
- API reference documents new stream endpoint and 409 response

**Dependencies:** Task 10, Task 3

---

## Dependency Graph

```
Task 1 (Session Locking)  ───────────────────┐
                                              ├──▶ Task 3 (Lock in POST route) ──▶ Task 5 (HttpTransport) ──▶ Task 6 (Session Busy UI)
Task 2 (ETag Support) ──────────────────────────────────────────────────────────────────┘
                                              │
                                              ├──▶ Task 4 (Client Polling) ──────────────────────────┐
                                              │                                                       │
Task 7 (Schemas + chokidar) ──┐               │                                                       │
                               ├──▶ Task 9 (SessionBroadcaster) ──▶ Task 10 (Stream endpoint) ──▶ Task 11 (Client EventSource)
Task 8 (readFromOffset)  ─────┘                                                                        │
                                                                                                       ▼
                                                                                              Task 12 (Documentation)
```

## Parallel Execution Opportunities

- **Phase 1:** Tasks 1 and 2 can run in parallel (no dependencies on each other)
- **Phase 2:** Tasks 7 and 8 can run in parallel (no dependencies on each other)
- Task 4 (client polling) can run in parallel with Tasks 3, 5 after Task 2 completes
- Task 12 (docs) can run after Tasks 3 and 10 are complete

## Summary

| Phase     | Tasks        | Description                                                          |
| --------- | ------------ | -------------------------------------------------------------------- |
| Phase 1   | Tasks 1-6    | Session locking, ETag, adaptive polling, 409 handling, busy UI       |
| Phase 2   | Tasks 7-12   | Chokidar watching, SessionBroadcaster, SSE stream, EventSource, docs |
| **Total** | **12 tasks** |                                                                      |
