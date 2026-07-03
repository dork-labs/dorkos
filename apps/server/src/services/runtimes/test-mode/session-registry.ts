/**
 * In-memory session metadata registry for the stateless test-mode runtime.
 *
 * Backs {@link TestModeRuntime.subscribeSessionList} (and `listSessions`/
 * `getSession`) WITHOUT any filesystem watch — the explicit proof (spec
 * chat-stream-reconnection task #15, ADR-0263 Decision 1) that the session-list
 * contract has no baked-in JSONL/file assumptions. A session is "tracked" the
 * moment DorkOS observes it (its first triggered message, or an explicit
 * `ensureSession`), and only METADATA lives here: the transcript itself is the
 * DorkOS-owned EventLog inside the session's projector.
 *
 * Unbounded by design: the runtime is dev/test-only (`DORKOS_TEST_RUNTIME=true`
 * gating in index.ts), so the tracked set is small and process-scoped.
 *
 * @module services/runtimes/test-mode/session-registry
 */
import type { Session, PermissionMode } from '@dorkos/shared/types';
import type { SessionListEvent } from '@dorkos/shared/session-stream';

/** Max characters of a first message used as the derived session title/preview. */
const PREVIEW_MAX_CHARS = 80;

/** Metadata fields the registry can update on an already-tracked session. */
export interface TrackedSessionPatch {
  permissionMode?: PermissionMode;
  model?: string;
  cwd?: string;
}

/** Truncate message content into a one-line title/preview (codepoint-safe). */
function toPreview(content: string): string {
  const firstLine = content.split('\n', 1)[0] ?? '';
  const codepoints = [...firstLine];
  return codepoints.length > PREVIEW_MAX_CHARS
    ? `${codepoints.slice(0, PREVIEW_MAX_CHARS).join('')}…`
    : firstLine;
}

/**
 * Tracked-session metadata + live `session_upserted` fan-out for the test-mode
 * runtime. `subscribe()` yields the current inventory first, then live upserts
 * — mirroring the Claude session-list watcher's contract, minus the watcher.
 */
export class TestModeSessionRegistry {
  private readonly sessions = new Map<string, Session>();
  private readonly listeners = new Set<(event: SessionListEvent) => void>();

  /**
   * Create a registry stamping sessions with the owning runtime's type.
   *
   * @param runtimeType - The owning runtime's type, stamped onto every tracked
   *   session (drives session-list runtime marks). Defaults to `'test-mode'`;
   *   a secondary e2e instance passes its own type.
   */
  constructor(private readonly runtimeType: string = 'test-mode') {}

  /**
   * Track a session (or refresh its settings) without a message — the
   * `ensureSession` path used by Tasks and relay bindings.
   */
  register(sessionId: string, patch: TrackedSessionPatch = {}): void {
    const session = this.upsert(sessionId, patch);
    // Emit a copy: a queued list event must not observe later mutations.
    this.emit({ type: 'session_upserted', session: { ...session } });
  }

  /**
   * Record a triggered message: tracks the session on first sight (deriving its
   * title from the first message, like the Claude adapter derives it from the
   * transcript head), refreshes `updatedAt`/`lastMessagePreview`, and fans out
   * the upsert to live list subscribers.
   */
  recordMessage(sessionId: string, content: string, patch: TrackedSessionPatch = {}): void {
    const session = this.upsert(sessionId, patch);
    const preview = toPreview(content);
    if (session.title === '') session.title = preview;
    session.lastMessagePreview = preview;
    session.updatedAt = new Date().toISOString();
    this.emit({ type: 'session_upserted', session: { ...session } });
  }

  /**
   * Apply operator settings to a tracked session (the PATCH path).
   *
   * @returns false when the session is not tracked.
   */
  applySettings(sessionId: string, patch: TrackedSessionPatch): boolean {
    if (!this.sessions.has(sessionId)) return false;
    this.register(sessionId, patch);
    return true;
  }

  /** Whether the session is tracked. */
  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** A copy of one tracked session's metadata, or null. */
  get(sessionId: string): Session | null {
    const session = this.sessions.get(sessionId);
    return session ? { ...session } : null;
  }

  /**
   * Tracked sessions scoped to a working directory. A session tracked without
   * a cwd is included everywhere (it cannot be attributed to any project).
   */
  list(projectDir: string): Session[] {
    return [...this.sessions.values()]
      .filter((s) => s.cwd === undefined || s.cwd === projectDir)
      .map((s) => ({ ...s }));
  }

  /**
   * Discovery + liveness stream: yields one `session_upserted` per tracked
   * session, then live upserts as sessions are tracked/updated. Hand-rolled
   * iterator (not an async generator) so `return()` resolves a parked `next()`
   * immediately — the session-list broadcaster awaits `iterator.return()` on
   * stop, and a generator parked on an un-settleable await would hang it.
   *
   * Single-consumer contract (the broadcaster iterates strictly sequentially):
   * a second concurrent `next()` while one is parked would overwrite the
   * waiter and leave the first promise unsettled.
   */
  subscribe(): AsyncIterableIterator<SessionListEvent> {
    const queue: SessionListEvent[] = [...this.sessions.values()].map((session) => ({
      type: 'session_upserted',
      session: { ...session },
    }));
    let waiter: ((result: IteratorResult<SessionListEvent>) => void) | null = null;
    let closed = false;

    const push = (event: SessionListEvent): void => {
      if (closed) return;
      if (waiter) {
        const resolve = waiter;
        waiter = null;
        resolve({ value: event, done: false });
      } else {
        queue.push(event);
      }
    };
    this.listeners.add(push);

    const close = (): void => {
      if (closed) return;
      closed = true;
      // Drop buffered events too: a post-return() next() must report done, not
      // drain a queue the consumer already walked away from.
      queue.length = 0;
      this.listeners.delete(push);
      if (waiter) {
        const resolve = waiter;
        waiter = null;
        resolve({ value: undefined, done: true });
      }
    };

    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next(): Promise<IteratorResult<SessionListEvent>> {
        if (queue.length > 0) {
          return Promise.resolve({ value: queue.shift()!, done: false });
        }
        if (closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => {
          waiter = resolve;
        });
      },
      async return(): Promise<IteratorResult<SessionListEvent>> {
        close();
        return { value: undefined, done: true };
      },
    };
  }

  /** Ids of every tracked session (for the runtime's reset to dispose projectors). */
  ids(): string[] {
    return [...this.sessions.keys()];
  }

  /**
   * Drop all tracked sessions (test-control reset), emitting `session_removed`
   * to live list subscribers so a connected sidebar drops the stale rows.
   */
  reset(): void {
    const ids = this.ids();
    this.sessions.clear();
    for (const sessionId of ids) {
      this.emit({ type: 'session_removed', sessionId });
    }
  }

  /** Get-or-create the tracked entry and fold in the patch (mutates in place). */
  private upsert(sessionId: string, patch: TrackedSessionPatch): Session {
    let session = this.sessions.get(sessionId);
    if (!session) {
      const now = new Date().toISOString();
      session = {
        id: sessionId,
        title: '',
        createdAt: now,
        updatedAt: now,
        permissionMode: patch.permissionMode ?? 'default',
        runtime: this.runtimeType,
      };
      this.sessions.set(sessionId, session);
    }
    if (patch.permissionMode !== undefined) session.permissionMode = patch.permissionMode;
    if (patch.model !== undefined) session.model = patch.model;
    if (patch.cwd !== undefined) session.cwd = patch.cwd;
    return session;
  }

  /** Fan an event to all live list subscribers. */
  private emit(event: SessionListEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
