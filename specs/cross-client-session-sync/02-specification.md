---
slug: cross-client-session-sync
---

# Cross-Client Session Synchronization -- Implementation Specification

**Status:** Draft
**Authors:** Claude Code
**Date:** 2026-02-13
**Branch:** feat/cross-client-session-sync

---

## Table of Contents

1. [Overview](#1-overview)
2. [Background / Problem Statement](#2-background--problem-statement)
3. [Goals](#3-goals)
4. [Non-Goals](#4-non-goals)
5. [Technical Dependencies](#5-technical-dependencies)
6. [Detailed Design](#6-detailed-design)
7. [User Experience](#7-user-experience)
8. [Testing Strategy](#8-testing-strategy)
9. [Performance Considerations](#9-performance-considerations)
10. [Security Considerations](#10-security-considerations)
11. [Documentation](#11-documentation)
12. [Implementation Phases](#12-implementation-phases)
13. [Open Questions](#13-open-questions)
14. [References](#14-references)

---

## 1. Overview

Add cross-client session synchronization so that multiple clients (browser tabs, devices, or CLI) viewing the same session stay in sync. Implemented in two phases:

- **Phase 1 (Polling + Session Locking):** TanStack Query adaptive polling with server-side ETag support for efficient 304 responses. Session locking prevents concurrent sends to the same session.
- **Phase 2 (File Watching + SSE Broadcast):** Chokidar file watching on active JSONL transcript files with persistent SSE broadcast to all connected clients. Detects CLI-originated changes and pushes completed messages within 100ms.

**Key design choices:**

- Sync scope is completed messages only (no streaming text deltas to passive clients)
- HttpTransport only (no changes to shared Transport interface or DirectTransport)
- Roll-our-own SSE broadcasting (~50 lines, extends existing `stream-adapter.ts`)
- Single server instance (no Redis, no horizontal scaling)
- No new runtime dependencies in Phase 1; Phase 2 adds only `chokidar`

---

## 2. Background / Problem Statement

The current architecture has three synchronization gaps:

**Gap 1: Passive client blindness.** When Client A sends a message, the SSE stream response flows only to Client A. Client B viewing the same session sees nothing until a manual refresh. The TanStack Query history fetch runs once on session load (`staleTime: 5min`, `refetchOnWindowFocus: false`) and never re-fetches.

**Gap 2: CLI invisibility.** When a user interacts with Claude Code via the CLI, it writes directly to the JSONL transcript file on disk. The server has no file watching and no mechanism to detect these changes. The WebUI remains stale indefinitely.

**Gap 3: No write coordination.** Two clients can simultaneously call `POST /api/sessions/:id/messages`, causing two SDK `query()` processes to write to the same JSONL file. This is a race condition that can corrupt session state.

**Current data flow:**

```
Client A sends message
  -> POST /api/sessions/:id/messages
  -> agentManager.sendMessage() -> SDK query() -> claude CLI process
  -> SDK streams events -> AsyncGenerator<StreamEvent>
  -> SSE response to Client A only
  -> SDK writes to JSONL file on disk

Client B viewing same session:
  -> Sees nothing (no push, history stale after initial load)

CLI user on same session:
  -> claude CLI writes directly to JSONL
  -> Server has no knowledge of the change
  -> WebUI sees nothing
```

---

## 3. Goals

1. Passive clients viewing a session see new completed messages within 3-5 seconds (Phase 1 polling)
2. Passive clients see new messages within 100ms of file change (Phase 2 file watching)
3. Only one client can send messages to a session at a time (session locking)
4. Server uses ETags to avoid re-serializing unchanged message history (bandwidth efficiency)
5. CLI-originated messages appear in WebUI without refresh (Phase 2)
6. Multiple browser tabs viewing the same session all stay in sync
7. Resource cleanup: watchers and SSE connections cleaned up when clients disconnect

---

## 4. Non-Goals

- Streaming text deltas to passive clients (only completed messages)
- Obsidian plugin sync (standalone web only)
- Multi-user collaboration features (shared cursors, presence indicators)
- Conflict resolution for simultaneous sends (prevented by locking, not resolved)
- Changes to the Claude Agent SDK
- Horizontal scaling / multi-server deployments
- Changes to the shared `Transport` interface or `DirectTransport`

---

## 5. Technical Dependencies

### Existing Dependencies (No Changes)

| Package                 | Version | Usage                                |
| ----------------------- | ------- | ------------------------------------ |
| `@tanstack/react-query` | v5      | Client polling via `refetchInterval` |
| `express`               | 4.21    | Server routing, SSE responses        |

### New Dependencies

| Package    | Version | Phase   | Size  | Usage                              |
| ---------- | ------- | ------- | ----- | ---------------------------------- |
| `chokidar` | ^4.0    | Phase 2 | ~12MB | File watching on JSONL transcripts |

Phase 1 requires zero new dependencies.

---

## 6. Detailed Design

### 6.1 Architecture Overview

```
Phase 1:
                                 ┌────────────────────┐
                                 │      Server         │
 Client A (sender)               │                    │
   POST /messages ──────────────▶│  Session Lock      │
   SSE ◀─────────────────────────│  Check + Acquire   │
                                 │       │             │
 Client B (passive)              │       ▼             │
   GET /messages (poll) ────────▶│  ETag Check        │
   304 or 200 ◀──────────────────│  (mtime+size)      │
                                 └────────────────────┘

Phase 2 (additions):
                                 ┌────────────────────┐
                                 │      Server         │
                                 │                    │
  ~/.claude/projects/…/x.jsonl   │  ┌──────────────┐  │
       │                         │  │ Chokidar     │  │
       │ (file change)           │  │ File Watcher │  │
       └─────────────────────────│──▶              │  │
                                 │  └──────┬───────┘  │
                                 │         ▼          │
                                 │  ┌──────────────┐  │
                                 │  │ Session      │  │
                                 │  │ Broadcaster  │  │
                                 │  │ Map<id, Set> │  │
                                 │  └──────┬───────┘  │
                                 │         │          │
                                 │    SSE broadcast   │
                                 └────────┬───────────┘
                                          │
                              ┌───────────┼───────────┐
                              ▼           ▼           ▼
                          Client A    Client B    Client C
                         EventSource EventSource EventSource
                         GET /stream GET /stream GET /stream
```

### 6.2 Session Locking (Phase 1)

**File:** `apps/server/src/services/agent-manager.ts`

Add a session lock mechanism to prevent concurrent sends. The lock is acquired when a client starts streaming (POST `/messages`) and released when the SSE connection closes or the stream completes.

**New types:**

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

**New methods:**

```typescript
/**
 * Attempt to acquire a lock on a session.
 * Returns true if lock acquired, false if already locked by another client.
 */
acquireLock(sessionId: string, clientId: string, res: Response): boolean {
  const existing = this.sessionLocks.get(sessionId);

  // Check if existing lock is still valid
  if (existing) {
    const expired = Date.now() - existing.acquiredAt > existing.ttl;
    if (!expired && existing.clientId !== clientId) {
      return false; // Locked by another client
    }
    // Expired or same client re-acquiring — allow
  }

  const lock: SessionLock = {
    clientId,
    acquiredAt: Date.now(),
    ttl: this.LOCK_TTL_MS,
    response: res,
  };

  this.sessionLocks.set(sessionId, lock);

  // Auto-release when SSE connection closes
  res.on('close', () => {
    const current = this.sessionLocks.get(sessionId);
    if (current && current.clientId === clientId) {
      this.sessionLocks.delete(sessionId);
    }
  });

  return true;
}

/**
 * Release a session lock explicitly (called on stream completion).
 */
releaseLock(sessionId: string, clientId: string): void {
  const lock = this.sessionLocks.get(sessionId);
  if (lock && lock.clientId === clientId) {
    this.sessionLocks.delete(sessionId);
  }
}

/**
 * Check if a session is locked by another client.
 */
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

/**
 * Get lock info for a session (used by route handler for 409 response body).
 */
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

**Lock cleanup in `checkSessionHealth()`:**

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
  // Also clean expired locks independently
  for (const [id, lock] of this.sessionLocks) {
    if (now - lock.acquiredAt > lock.ttl) {
      this.sessionLocks.delete(id);
    }
  }
}
```

### 6.3 ETag Support (Phase 1)

**File:** `apps/server/src/services/transcript-reader.ts`

Add a method to generate an ETag based on file mtime and size. This avoids reading and parsing the full JSONL when the file hasn't changed.

```typescript
/**
 * Generate an ETag for a session transcript file.
 * Uses mtime + size as a fast content-change proxy.
 */
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

**File:** `apps/server/src/routes/sessions.ts`

Modify `GET /:id/messages` to support ETag/If-None-Match:

```typescript
// GET /api/sessions/:id/messages - Get message history from SDK transcript
router.get('/:id/messages', async (req, res) => {
  const cwd = (req.query.cwd as string) || vaultRoot;

  // ETag support: check if client has current version
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

### 6.4 Route Handler Changes (Phase 1)

**File:** `apps/server/src/routes/sessions.ts`

Modify `POST /:id/messages` to check and acquire session lock:

```typescript
// POST /api/sessions/:id/messages - Send message (SSE stream response)
router.post('/:id/messages', async (req, res) => {
  const parsed = SendMessageRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.format() });
  }
  const { content, cwd } = parsed.data;
  const sessionId = req.params.id;

  // Generate a unique client ID for this request
  const clientId = (req.headers['x-client-id'] as string) || crypto.randomUUID();

  // Check session lock
  if (agentManager.isLocked(sessionId, clientId)) {
    const lockInfo = agentManager.getLockInfo(sessionId);
    return res.status(409).json({
      error: 'Session is busy',
      code: 'SESSION_LOCKED',
      lockedSince: lockInfo?.acquiredAt ? new Date(lockInfo.acquiredAt).toISOString() : undefined,
    });
  }

  // Acquire lock before streaming
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

### 6.5 Client Polling (Phase 1)

**File:** `apps/client/src/hooks/use-chat-session.ts`

Modify the existing `useQuery` for message history to add adaptive polling:

```typescript
// Load message history from SDK transcript via TanStack Query
const historyQuery = useQuery({
  queryKey: ['messages', sessionId, selectedCwd],
  queryFn: () => transport.getMessages(sessionId, selectedCwd ?? undefined),
  staleTime: 0, // Always check (ETag handles efficiency on the server)
  refetchInterval: (query) => {
    // Don't poll while this client is actively streaming
    if (status !== 'idle') return false;

    // Adaptive interval based on session activity
    const lastMsg = query.state.data?.messages?.at(-1);
    if (!lastMsg?.timestamp) return 10_000; // 10s default for empty sessions

    const ageMs = Date.now() - new Date(lastMsg.timestamp).getTime();
    const fiveMinutes = 5 * 60 * 1000;

    return ageMs < fiveMinutes ? 3_000 : 10_000; // 3s active, 10s idle
  },
  refetchIntervalInBackground: false, // Don't poll when tab is hidden
});
```

**Important:** The current code seeds messages from history only once via `historySeededRef`. For polling to work, we need to merge polled updates into the existing message list rather than replacing it. When `historyQuery.data` changes and the client is idle (not streaming), reconcile by comparing message counts:

```typescript
// Merge polled history updates (after initial seed)
useEffect(() => {
  if (!historyQuery.data || status !== 'idle') return;

  const history = historyQuery.data.messages;

  // Initial seed (existing behavior)
  if (!historySeededRef.current) {
    if (history.length > 0) {
      historySeededRef.current = true;
      setMessages(history.map((m) => mapHistoryMessage(m)));
    }
    return;
  }

  // Polling update: merge new messages if history grew
  if (history.length > messages.length) {
    setMessages(history.map((m) => mapHistoryMessage(m)));
  }
}, [historyQuery.data, status]);
```

Extract the message mapping logic into a helper function `mapHistoryMessage` to avoid duplication:

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

### 6.6 Client HTTP Error Handling (Phase 1)

**File:** `apps/client/src/lib/http-transport.ts`

Update `fetchJSON` and `sendMessage` to handle 409 Conflict and 304 Not Modified:

```typescript
async function fetchJSON<T>(baseUrl: string, url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });

  // 304 Not Modified: return undefined (TanStack Query will keep previous data)
  if (res.status === 304) {
    return undefined as T;
  }

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    // Preserve error code for structured error handling
    const err = new Error(error.error || `HTTP ${res.status}`);
    (err as Record<string, unknown>).code = error.code;
    (err as Record<string, unknown>).status = res.status;
    throw err;
  }
  return res.json();
}
```

For `getMessages`, add `If-None-Match` header support:

```typescript
getMessages(sessionId: string, cwd?: string): Promise<{ messages: HistoryMessage[] }> {
  const params = new URLSearchParams();
  if (cwd) params.set('cwd', cwd);
  const qs = params.toString();

  // Include ETag header if we have a cached version
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
      // Content unchanged, return cached data
      // TanStack Query will keep previous data via keepPreviousData
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

Add ETag and message caches to HttpTransport:

```typescript
export class HttpTransport implements Transport {
  private etagCache = new Map<string, string>();
  private messageCache = new Map<string, { messages: HistoryMessage[] }>();

  constructor(private baseUrl: string) {}
  // ...
}
```

For `sendMessage`, handle 409 Conflict:

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

  // ... existing SSE parsing logic ...
}
```

Add a stable client ID to HttpTransport:

```typescript
export class HttpTransport implements Transport {
  private readonly clientId: string;

  constructor(private baseUrl: string) {
    this.clientId = crypto.randomUUID();
  }
  // ...
}
```

### 6.7 "Session Busy" UI (Phase 1)

**File:** `apps/client/src/hooks/use-chat-session.ts`

Add a `sessionBusy` state that is set when a 409 is received:

```typescript
const [sessionBusy, setSessionBusy] = useState(false);

// In handleSubmit:
try {
  // ... existing send logic ...
} catch (err) {
  if ((err as Record<string, unknown>).code === 'SESSION_LOCKED') {
    setSessionBusy(true);
    // Auto-clear after 5 seconds
    setTimeout(() => setSessionBusy(false), 5000);
  } else if ((err as Error).name !== 'AbortError') {
    setError((err as Error).message);
    setStatus('error');
  }
}
```

Expose `sessionBusy` from the hook return value. The `ChatInput` component disables the send button and shows a "Session is busy" indicator when `sessionBusy` is true.

### 6.8 Session Broadcaster (Phase 2)

**File:** `apps/server/src/services/session-broadcaster.ts` (NEW)

Core service that manages chokidar file watchers and SSE broadcast connections.

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
  byteOffset: number; // Track position for incremental reads
  vaultRoot: string;
  debounceTimer?: ReturnType<typeof setTimeout>;
}

export class SessionBroadcaster {
  private watches = new Map<string, SessionWatch>();

  /**
   * Register a client SSE connection for a session.
   * Starts file watching when the first client subscribes.
   */
  async register(sessionId: string, res: Response, vaultRoot: string): Promise<void> {
    let watch = this.watches.get(sessionId);

    if (!watch) {
      const transcriptsDir = transcriptReader.getTranscriptsDir(vaultRoot);
      const filePath = path.join(transcriptsDir, `${sessionId}.jsonl`);

      // Get initial file size as byte offset (don't re-read existing content)
      let initialOffset = 0;
      try {
        const stat = await fs.stat(filePath);
        initialOffset = stat.size;
      } catch {
        // File may not exist yet; offset stays 0
      }

      // Start chokidar watcher
      const watcher = chokidar.watch(filePath, {
        persistent: true,
        awaitWriteFinish: {
          stabilityThreshold: 100,
          pollInterval: 50,
        },
        // Don't emit 'add' event on initial scan
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

    // Add client
    watch.clients.add(res);

    // Initialize SSE stream for this client
    initSSEStream(res);

    // Clean up on disconnect
    res.on('close', () => {
      this.deregister(sessionId, res);
    });
  }

  /**
   * Remove a client SSE connection.
   * Stops file watching when the last client disconnects.
   */
  deregister(sessionId: string, res: Response): void {
    const watch = this.watches.get(sessionId);
    if (!watch) return;

    watch.clients.delete(res);

    if (watch.clients.size === 0) {
      // Last client disconnected — stop watching
      watch.watcher.close();
      if (watch.debounceTimer) clearTimeout(watch.debounceTimer);
      this.watches.delete(sessionId);
    }
  }

  /**
   * Handle JSONL file change. Debounce to avoid partial reads.
   */
  private onFileChange(sessionId: string): void {
    const watch = this.watches.get(sessionId);
    if (!watch) return;

    // Debounce: wait 50ms for writes to settle
    if (watch.debounceTimer) clearTimeout(watch.debounceTimer);
    watch.debounceTimer = setTimeout(() => {
      this.readAndBroadcast(sessionId).catch((err) => {
        console.error(`[SessionBroadcaster] Error reading ${sessionId}:`, err);
      });
    }, 50);
  }

  /**
   * Read new content from JSONL file (incremental) and broadcast completed messages.
   */
  private async readAndBroadcast(sessionId: string): Promise<void> {
    const watch = this.watches.get(sessionId);
    if (!watch || watch.clients.size === 0) return;

    try {
      const stat = await fs.stat(watch.filePath);

      // No new content
      if (stat.size <= watch.byteOffset) return;

      // Read only new bytes
      const fileHandle = await fs.open(watch.filePath, 'r');
      try {
        const newBytes = stat.size - watch.byteOffset;
        const buffer = Buffer.alloc(newBytes);
        await fileHandle.read(buffer, 0, newBytes, watch.byteOffset);
        watch.byteOffset = stat.size;

        const newContent = buffer.toString('utf-8');
        const lines = newContent.split('\n').filter((l) => l.trim());

        // Parse new completed messages
        const newMessages: HistoryMessage[] = [];

        for (const line of lines) {
          let parsed;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }

          // We broadcast user and assistant messages only
          // (skip system, init, and other internal lines)
          if (parsed.type === 'user' || parsed.type === 'assistant') {
            // Re-read the full transcript to get properly parsed messages
            // This is simpler and more correct than duplicating parsing logic
            // The ETag check in the TranscriptReader cache makes this efficient
            break; // Flag that we need a full re-parse
          }
        }

        // If we found new user/assistant messages, broadcast a sync event
        // that tells clients to re-fetch. This is simpler and more reliable
        // than trying to parse individual messages incrementally.
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

  /**
   * Broadcast an SSE event to all connected clients for a session.
   */
  private broadcast(sessionId: string, event: { type: string; data: unknown }): void {
    const watch = this.watches.get(sessionId);
    if (!watch) return;

    for (const client of watch.clients) {
      try {
        sendSSEEvent(client, event as import('@dorkos/shared/types').StreamEvent);
      } catch {
        // Client may have disconnected; will be cleaned up by 'close' handler
      }
    }
  }

  /**
   * Stop all watchers and close all client connections. For graceful shutdown.
   */
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

### 6.9 Persistent SSE Endpoint (Phase 2)

**File:** `apps/server/src/routes/sessions.ts`

Add a new endpoint for persistent SSE subscriptions:

```typescript
// GET /api/sessions/:id/stream - Persistent SSE for session sync (Phase 2)
router.get('/:id/stream', async (req, res) => {
  const cwd = (req.query.cwd as string) || vaultRoot;
  const sessionId = req.params.id;

  // Verify session exists
  const session = await transcriptReader.getSession(cwd, sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  // Register this client for broadcast updates
  await sessionBroadcaster.register(sessionId, res, cwd);

  // Send initial heartbeat
  sendSSEEvent(res, {
    type: 'sync_connected',
    data: { sessionId },
  } as StreamEvent);
});
```

### 6.10 Client SSE Subscription (Phase 2)

**File:** `apps/client/src/hooks/use-chat-session.ts`

Add an EventSource subscription alongside the existing polling. When a `sync_update` event is received, invalidate the TanStack Query to trigger an immediate re-fetch:

```typescript
import { useQueryClient } from '@tanstack/react-query';

// Inside useChatSession:
const queryClient = useQueryClient();

// Phase 2: Subscribe to persistent SSE for real-time sync
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
    // Invalidate query to trigger immediate re-fetch
    queryClient.invalidateQueries({
      queryKey: ['messages', sessionId, selectedCwd],
    });
  });

  eventSource.addEventListener('error', () => {
    // EventSource auto-reconnects on error; no action needed.
    // Polling continues as fallback during reconnection.
  });

  return () => {
    eventSource.close();
  };
}, [sessionId, selectedCwd, status, queryClient]);
```

### 6.11 New Schema Types

**File:** `packages/shared/src/schemas.ts`

Add new event types to the `StreamEventTypeSchema` enum:

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

Add a schema for the session lock error response:

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

### 6.12 Stream Adapter Extensions (Phase 2)

**File:** `apps/server/src/services/stream-adapter.ts`

No changes needed to the existing `stream-adapter.ts`. The `sendSSEEvent` function already accepts any `StreamEvent` and the `SessionBroadcaster` calls it directly. The broadcast logic lives in `session-broadcaster.ts` rather than being added here, keeping stream-adapter focused on wire protocol.

### 6.13 Incremental Reading Enhancement (Phase 2)

**File:** `apps/server/src/services/transcript-reader.ts`

Add a method for reading JSONL content from a specific byte offset. This is used by the `SessionBroadcaster` for efficient incremental reads:

```typescript
/**
 * Read new lines from a JSONL file starting at a byte offset.
 * Returns the new content and updated byte offset.
 */
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

---

## 7. User Experience

### Phase 1: Polling

**Passive client viewing a session:**

1. Messages appear within 3 seconds when the session was recently active (last message < 5 min ago)
2. Messages appear within 10 seconds for idle sessions (last message > 5 min ago)
3. No visual indicator of polling -- messages simply appear in the list
4. Polling pauses when the browser tab is not visible (`refetchIntervalInBackground: false`)
5. Polling pauses when this client is actively streaming

**Client attempting to send to a locked session:**

1. User types message and hits send
2. Server returns 409 Conflict
3. Chat input shows a brief "Session is busy" indicator (fades after 5 seconds)
4. User's typed message remains in the input (not cleared on 409)
5. User can retry after the active session completes

### Phase 2: File Watching

**All connected clients:**

1. Messages from any source (CLI, SDK, another browser tab) appear within 100ms
2. A persistent SSE connection is maintained while viewing a session
3. The connection auto-reconnects on network interruption (native EventSource behavior)
4. Polling continues as a fallback during reconnection gaps

**No new UI chrome is added.** Messages simply appear in the list as they are created. The only new UI element is the "Session is busy" indicator for locked sessions.

---

## 8. Testing Strategy

### Phase 1 Tests

#### Session Locking (`apps/server/src/services/__tests__/agent-manager-locking.test.ts`)

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

**Pattern:** Create mock Express `Response` objects with `on('close', cb)` support. Test TTL by manipulating `acquiredAt` timestamps.

#### ETag Support (`apps/server/src/services/__tests__/transcript-reader.test.ts`)

```typescript
describe('getTranscriptETag', () => {
  it('returns ETag string based on mtime and size');
  it('returns null when file does not exist');
  it('returns different ETag after file is modified');
});
```

**Pattern:** Mock `fs.stat` to return controlled `mtimeMs` and `size` values.

#### Route Handler Tests (`apps/server/src/routes/__tests__/sessions.test.ts`)

```typescript
describe('GET /:id/messages with ETag', () => {
  it('returns ETag header on successful response');
  it('returns 304 when If-None-Match matches');
  it('returns 200 with new ETag when content changed');
});

describe('POST /:id/messages with locking', () => {
  it('acquires lock and streams response');
  it('returns 409 when session is locked by another client');
  it('includes SESSION_LOCKED code in 409 response');
  it('releases lock after stream completes');
});
```

#### Client Tests (`apps/client/src/hooks/__tests__/use-chat-session.test.tsx`)

```typescript
describe('useChatSession polling', () => {
  it('polls at 3s intervals for recently active sessions');
  it('polls at 10s intervals for idle sessions');
  it('stops polling while streaming');
  it('does not poll when tab is in background');
  it('merges polled messages into existing state');
});

describe('useChatSession session busy', () => {
  it('sets sessionBusy on 409 response');
  it('clears sessionBusy after timeout');
  it('preserves input text on 409');
});
```

### Phase 2 Tests

#### Session Broadcaster (`apps/server/src/services/__tests__/session-broadcaster.test.ts`)

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

**Pattern:** Use `vi.mock('chokidar')` to control file watcher events. Use mock `Response` objects. Test file reading with `vi.mock('fs/promises')`.

#### Integration Tests

```typescript
describe('GET /:id/stream', () => {
  it('returns 404 for non-existent session');
  it('establishes SSE connection with sync_connected event');
  it('broadcasts sync_update on file change');
  it('handles multiple clients on same session');
  it('cleans up watcher when all clients disconnect');
});
```

### All Phases

- All existing tests must pass without modification (except adding new mocks where needed)
- `turbo test`, `turbo typecheck`, and `turbo build` must all succeed

---

## 9. Performance Considerations

### Polling Overhead (Phase 1)

**Server load per poll request:**

- `fs.stat()` call for ETag generation: ~0.1ms
- String comparison for If-None-Match: negligible
- 304 response: no JSONL parsing, no JSON serialization, ~0.1ms total

**Worst case polling load:**

- 10 browser tabs on the same session, all polling at 3s intervals
- = ~3.3 `fs.stat()` calls/second
- This is negligible on any modern filesystem

**Best case (304 responses):**

- When nothing changes, the server performs only `fs.stat()` + string comparison
- No file reads, no JSON parsing, no response body serialization

### File Watching (Phase 2)

**Watcher resource usage:**

- One chokidar watcher per active session (only sessions with connected clients)
- macOS uses `fsevents` (kernel-level, zero polling)
- Linux uses `inotify` (kernel-level, zero polling)
- Windows uses `ReadDirectoryChangesW`

**Incremental reading:**

- Track byte offset per session
- Read only new bytes appended since last check
- Parse only new JSONL lines
- Never re-read the full transcript file

**Memory:**

- `Map<sessionId, SessionWatch>` grows only with actively-watched sessions
- Each `SessionWatch` holds a `Set<Response>` (just object references)
- Byte offsets are single numbers
- Total memory per watched session: ~200 bytes + chokidar internal state

### Cleanup

- Watchers are stopped when the last client disconnects from a session
- The `checkSessionHealth()` interval (every 5 minutes) provides a safety net
- Graceful shutdown closes all watchers via `sessionBroadcaster.shutdown()`

---

## 10. Security Considerations

1. **No new authentication surface.** The new `/stream` endpoint uses the same access model as existing endpoints (none, since this is a local-first single-user application).

2. **Session locking is advisory.** The lock prevents accidental concurrent sends from the same user's multiple tabs. It is not a security mechanism -- there is no authentication of client IDs.

3. **Client ID generation.** The `X-Client-Id` header is a random UUID generated per `HttpTransport` instance. It is used solely for lock ownership tracking. A malicious local client could spoof another client's ID, but since this is a single-user local application, this is not a threat.

4. **File watching scope.** Chokidar watches only specific JSONL files that the client has explicitly subscribed to. It does not scan directories or watch arbitrary paths.

5. **SSE connection limits.** Browsers limit concurrent SSE connections per domain (typically 6 for HTTP/1.1). With one SSE connection per viewed session, this is unlikely to be hit. HTTP/2 multiplexing eliminates this limit entirely.

6. **No secrets in broadcast.** The `sync_update` event contains only the session ID and a timestamp. The actual message content is fetched via the existing `GET /messages` endpoint.

---

## 11. Documentation

### AGENTS.md Updates

Add the following to the "Server" section under services:

> **`services/session-broadcaster.ts`** (Phase 2) - Manages chokidar file watchers and SSE broadcast connections for cross-client session sync. Watches active session JSONL files, detects changes, and pushes `sync_update` events to all connected clients. Start watching on first client subscription, stop on last disconnect.

Add to the "SSE Streaming Protocol" section:

> **Persistent SSE (Phase 2):** In addition to the per-POST streaming, clients can subscribe to `GET /api/sessions/:id/stream` for persistent SSE that broadcasts sync events. Event types: `sync_connected` (initial handshake), `sync_update` (new messages available -- client should re-fetch).

Add to the "Session Architecture" section:

> **Session Locking:** Only one client can send messages to a session at a time. Lock is acquired on `POST /messages` and released when the SSE stream ends or the connection closes. Lock auto-expires after 5 minutes (TTL). Other clients receive 409 Conflict with `SESSION_LOCKED` code.

### guides/api-reference.md Updates

Document the new endpoint:

> **GET /api/sessions/:id/stream** - Persistent SSE endpoint for session sync. Returns `sync_connected` on initial connection, then `sync_update` whenever the session's JSONL file changes. Query params: `cwd` (optional).

Document the 409 response:

> **409 Conflict** on POST /api/sessions/:id/messages - Returned when another client is actively streaming to this session. Body: `{ error: "Session is busy", code: "SESSION_LOCKED", lockedSince?: string }`.

---

## 12. Implementation Phases

### Phase 1: Polling + Session Locking

**Estimated effort:** 2-3 days

#### Step 1: Session Locking (Server)

- [ ] Add `SessionLock` interface and lock state to `apps/server/src/services/agent-manager.ts`
- [ ] Implement `acquireLock()`, `releaseLock()`, `isLocked()`, `getLockInfo()` methods
- [ ] Add lock cleanup to `checkSessionHealth()`
- [ ] Write tests: `apps/server/src/services/__tests__/agent-manager-locking.test.ts`

#### Step 2: ETag Support (Server)

- [ ] Add `getTranscriptETag()` to `apps/server/src/services/transcript-reader.ts`
- [ ] Modify `GET /:id/messages` in `apps/server/src/routes/sessions.ts` to set ETag and handle If-None-Match
- [ ] Write tests for ETag in `apps/server/src/services/__tests__/transcript-reader.test.ts`
- [ ] Write tests for 304 in `apps/server/src/routes/__tests__/sessions.test.ts`

#### Step 3: Lock Check on Send (Server)

- [ ] Modify `POST /:id/messages` in `apps/server/src/routes/sessions.ts` to acquire lock and return 409
- [ ] Add `SessionLockedErrorSchema` to `packages/shared/src/schemas.ts`
- [ ] Write tests for 409 in `apps/server/src/routes/__tests__/sessions.test.ts`

#### Step 4: Client Polling

- [ ] Extract `mapHistoryMessage()` helper in `apps/client/src/hooks/use-chat-session.ts`
- [ ] Modify `useQuery` to add `refetchInterval` with adaptive logic
- [ ] Add merge logic for polled updates (replace `historySeededRef` pattern)
- [ ] Write client tests: `apps/client/src/hooks/__tests__/use-chat-session-polling.test.tsx`

#### Step 5: Client Error Handling

- [ ] Add `clientId`, `etagCache`, `messageCache` to `apps/client/src/lib/http-transport.ts`
- [ ] Handle 304 responses in `getMessages()`
- [ ] Handle 409 responses in `sendMessage()` with `SESSION_LOCKED` error code
- [ ] Add `sessionBusy` state and UI indicator to `use-chat-session.ts`

#### Step 6: Validation

- [ ] Run `turbo test`
- [ ] Run `turbo typecheck`
- [ ] Run `turbo build`
- [ ] Manual test: open same session in two tabs, verify polling shows messages from Tab A in Tab B within 3-5s
- [ ] Manual test: attempt to send from Tab B while Tab A is streaming, verify 409 and "Session is busy" indicator

### Phase 2: File Watching + SSE Broadcast

**Estimated effort:** 2-3 days

#### Step 7: Dependencies

- [ ] Add `chokidar` to `apps/server/package.json`
- [ ] Run `npm install`
- [ ] Add `sync_update` and `sync_connected` to `StreamEventTypeSchema` in `packages/shared/src/schemas.ts`

#### Step 8: Session Broadcaster (Server)

- [ ] Create `apps/server/src/services/session-broadcaster.ts`
- [ ] Implement `register()`, `deregister()`, `onFileChange()`, `readAndBroadcast()`, `broadcast()`, `shutdown()`
- [ ] Write tests: `apps/server/src/services/__tests__/session-broadcaster.test.ts`

#### Step 9: Incremental Reading

- [ ] Add `readFromOffset()` to `apps/server/src/services/transcript-reader.ts`
- [ ] Write tests for incremental reading

#### Step 10: Stream Endpoint

- [ ] Add `GET /:id/stream` to `apps/server/src/routes/sessions.ts`
- [ ] Import `sessionBroadcaster` singleton
- [ ] Add graceful shutdown call in `apps/server/src/index.ts`

#### Step 11: Client EventSource

- [ ] Add `EventSource` subscription in `apps/client/src/hooks/use-chat-session.ts`
- [ ] Invalidate TanStack Query on `sync_update` event
- [ ] Reduce polling interval or disable when EventSource is connected (optional optimization)

#### Step 12: Validation

- [ ] Run `turbo test`
- [ ] Run `turbo typecheck`
- [ ] Run `turbo build`
- [ ] Manual test: open same session in two tabs, send message from Tab A, verify Tab B sees it within 100ms
- [ ] Manual test: use CLI to send a message, verify WebUI shows it without refresh
- [ ] Manual test: close all tabs for a session, verify watcher is cleaned up (check server logs)

---

## 13. Open Questions

1. ~~**Polling interval when EventSource is connected (Phase 2).**~~ (RESOLVED)
   **Answer:** Keep 10s polling as fallback even when EventSource is connected. The 304 response makes it nearly free, and it provides resilience against EventSource disconnections.

2. ~~**ETag cache invalidation in HttpTransport.**~~ (RESOLVED)
   **Answer:** No eviction needed initially. Session count is finite, entries are small (one ETag string + one message array reference). Add LRU eviction later if needed.

3. ~~**Broadcast strategy for active sender.**~~ (RESOLVED)
   **Answer:** Broadcast to all clients including the active sender. The active sender's `refetchInterval` is disabled during streaming, so no redundant re-fetch occurs. The ETag check prevents wasted work if polling happens to fire.

4. ~~**Multiple working directories.**~~ (RESOLVED)
   **Answer:** Key broadcaster by `sessionId` alone. JSONL files are stored per-session-ID regardless of the requesting cwd.

---

## 14. References

### Files Modified (Phase 1)

| File                                            | Change                                              |
| ----------------------------------------------- | --------------------------------------------------- |
| `apps/server/src/services/agent-manager.ts`     | Add session lock mechanism                          |
| `apps/server/src/services/transcript-reader.ts` | Add `getTranscriptETag()` method                    |
| `apps/server/src/routes/sessions.ts`            | ETag on GET /messages, lock check on POST /messages |
| `apps/client/src/hooks/use-chat-session.ts`     | Adaptive polling, session busy state, message merge |
| `apps/client/src/lib/http-transport.ts`         | ETag cache, 409 handling, client ID                 |
| `packages/shared/src/schemas.ts`                | `SessionLockedErrorSchema`                          |

### Files Created (Phase 2)

| File                                              | Purpose                              |
| ------------------------------------------------- | ------------------------------------ |
| `apps/server/src/services/session-broadcaster.ts` | File watcher + SSE broadcast manager |

### Files Modified (Phase 2)

| File                                            | Change                                      |
| ----------------------------------------------- | ------------------------------------------- |
| `apps/server/src/services/transcript-reader.ts` | Add `readFromOffset()` method               |
| `apps/server/src/routes/sessions.ts`            | New `GET /:id/stream` endpoint              |
| `apps/server/src/index.ts`                      | Graceful shutdown for broadcaster           |
| `apps/client/src/hooks/use-chat-session.ts`     | EventSource subscription                    |
| `packages/shared/src/schemas.ts`                | `sync_update`, `sync_connected` event types |
| `apps/server/package.json`                      | Add `chokidar` dependency                   |

### Key Context Files (Not Modified)

| File                                         | Relevance                                          |
| -------------------------------------------- | -------------------------------------------------- |
| `packages/shared/src/transport.ts`           | Transport interface -- NOT modified                |
| `apps/server/src/services/stream-adapter.ts` | SSE wire protocol -- reused, not modified          |
| `guides/architecture.md`                     | Hexagonal architecture documentation               |
| `guides/interactive-tools.md`                | Tool approval flow (relevant for lock interaction) |

### Acceptance Criteria Summary

| #   | Criterion                                               | Phase |
| --- | ------------------------------------------------------- | ----- |
| 1   | Passive clients see new messages within 3-5s (polling)  | 1     |
| 2   | Adaptive polling: 3s active, 10s idle                   | 1     |
| 3   | Server returns ETag; returns 304 when unchanged         | 1     |
| 4   | Only one client can send at a time (session lock)       | 1     |
| 5   | Locked session returns 409 with SESSION_LOCKED code     | 1     |
| 6   | Lock auto-releases after 5 minutes TTL                  | 1     |
| 7   | Lock releases on SSE connection close                   | 1     |
| 8   | Client shows "session is busy" on 409                   | 1     |
| 9   | New persistent SSE endpoint: GET /stream                | 2     |
| 10  | Chokidar watches only active session JSONL files        | 2     |
| 11  | New messages broadcast within 100ms of file change      | 2     |
| 12  | CLI-originated messages appear in WebUI without refresh | 2     |
| 13  | Multiple tabs viewing same session all stay in sync     | 2     |
| 14  | File watcher uses awaitWriteFinish for stability        | 2     |
| 15  | Incremental reading (byte offset, not full file)        | 2     |
| 16  | Watchers and SSE connections cleaned up on disconnect   | 2     |
| 17  | No changes to Transport interface or DirectTransport    | Both  |
| 18  | No new runtime dependencies in Phase 1                  | 1     |
| 19  | Phase 2 adds only chokidar                              | 2     |
| 20  | All existing tests pass                                 | Both  |
| 21  | New tests for locking, ETag, and broadcast logic        | Both  |
