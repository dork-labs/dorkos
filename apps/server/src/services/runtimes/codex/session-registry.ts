/**
 * In-memory session metadata registry for the Codex runtime.
 *
 * Backs {@link CodexRuntime.subscribeSessionList} (and `listSessions`/
 * `getSession`) without any filesystem watch: the Codex SDK exposes NO thread
 * listing or reading API (`Codex` is exactly `startThread`/`resumeThread`, a
 * `Thread` is `id`/`run`/`runStreamed`), so the honest discovery source is the
 * set of sessions DorkOS itself has observed — first triggered message, an
 * explicit `ensureSession`, or startup hydration from the durable
 * `codex_threads` rows via {@link CodexSessionRegistry.hydrate}. Only METADATA
 * lives here; the transcript is the DorkOS-owned EventLog inside the session's
 * projector (ADR-0263), and the durable sessionId↔threadId binding plus the
 * written-through display metadata live in the `codex_threads` table
 * (thread-map.ts), which is what makes resume AND the session list survive a
 * server restart.
 *
 * Mirrors `TestModeSessionRegistry` deliberately: that registry is test-only
 * by charter (never imported in production) and stamps its own runtime tag,
 * so it cannot be reused directly. If a third runtime needs this shape,
 * extract a shared tracked-session registry into `services/session/`.
 *
 * There is deliberately NO eviction: entries are metadata-only (a `Session`
 * record, a few short strings each) and the map is bounded by the number of
 * sessions this server observes in one lifetime. Evicting would silently drop
 * live sessions from the list UI — the wrong trade for kilobytes of metadata.
 *
 * @module services/runtimes/codex/session-registry
 */
import type { Session, PermissionMode, EffortLevel } from '@dorkos/shared/types';
import type { SessionListEvent } from '@dorkos/shared/session-stream';

/** Max characters of a first message used as the derived session title/preview. */
const PREVIEW_MAX_CHARS = 80;

/** Metadata fields the registry can update on a tracked session. */
export interface CodexSessionPatch {
  permissionMode?: PermissionMode;
  model?: string;
  effort?: EffortLevel;
  fastMode?: boolean;
  cwd?: string;
}

/**
 * Whether a session-list event may reach live subscribers. A
 * `session_upserted` for a cwd-less session is suppressed: such a session
 * belongs to NO project list (see `list()`), so announcing it fleet-wide over
 * the global `/api/events` stream re-created the DOR-202 ghosts that the
 * list-side fix removed from `GET /api/sessions`. The session stays reachable
 * by id and self-announces on the upsert that resolves its cwd.
 */
function isAnnounceable(event: SessionListEvent): boolean {
  return event.type !== 'session_upserted' || event.session.cwd !== undefined;
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
 * Tracked-session metadata + live `session_upserted` fan-out for the Codex
 * runtime. `subscribe()` yields the current inventory first, then live
 * upserts — mirroring the Claude session-list watcher's contract, minus the
 * watcher.
 */
export class CodexSessionRegistry {
  private readonly sessions = new Map<string, Session>();
  private readonly listeners = new Set<(event: SessionListEvent) => void>();

  /**
   * Track a session (or refresh its settings) without a message — the
   * `ensureSession` path used by Tasks and relay bindings.
   */
  register(sessionId: string, patch: CodexSessionPatch = {}): void {
    const session = this.upsert(sessionId, patch);
    // Emit a copy: a queued list event must not observe later mutations.
    this.emit({ type: 'session_upserted', session: { ...session } });
  }

  /**
   * Record a triggered message: tracks the session on first sight, derives its
   * title from the explicit first-turn title (when supplied) or the first
   * message, refreshes `updatedAt`/`lastMessagePreview`, and fans out the
   * upsert to live list subscribers.
   */
  recordMessage(
    sessionId: string,
    content: string,
    patch: CodexSessionPatch & { title?: string } = {}
  ): void {
    const { title, ...settings } = patch;
    const session = this.upsert(sessionId, settings);
    const preview = toPreview(content);
    // MessageOpts.title is only honored on the first turn (see AgentRuntime).
    if (session.title === '') session.title = title ?? preview;
    session.lastMessagePreview = preview;
    session.updatedAt = new Date().toISOString();
    this.emit({ type: 'session_upserted', session: { ...session } });
  }

  /**
   * Apply operator settings to a tracked session (the PATCH path).
   *
   * @returns false when the session is not tracked.
   */
  applySettings(sessionId: string, patch: CodexSessionPatch): boolean {
    if (!this.sessions.has(sessionId)) return false;
    this.register(sessionId, patch);
    return true;
  }

  /** Set a tracked session's display title, tracking it first if needed. */
  rename(sessionId: string, title: string): void {
    const session = this.upsert(sessionId, {});
    session.title = title;
    session.updatedAt = new Date().toISOString();
    this.emit({ type: 'session_upserted', session: { ...session } });
  }

  /**
   * Seed the registry with durably persisted sessions at startup.
   *
   * Inserts ONLY sessionIds not already tracked — live in-memory state is
   * always fresher than a DB row, so hydration never overwrites it (which is
   * also what makes repeat calls idempotent). Emits one `session_upserted` per
   * inserted session so live list subscribers self-heal even when hydration
   * completes after the broadcaster subscribed.
   */
  hydrate(sessions: Session[]): void {
    for (const session of sessions) {
      if (this.sessions.has(session.id)) continue;
      const copy = { ...session };
      this.sessions.set(session.id, copy);
      // Emit a copy: a queued list event must not observe later mutations.
      this.emit({ type: 'session_upserted', session: { ...copy } });
    }
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
   * a cwd belongs to NO project list — it cannot be attributed to any project,
   * and fanning it into every list rendered ghost sessions under every agent
   * (DOR-202). It stays reachable by id via {@link CodexSessionRegistry.get}
   * and joins a list once a turn resolves its cwd.
   */
  list(projectDir: string): Session[] {
    return [...this.sessions.values()].filter((s) => s.cwd === projectDir).map((s) => ({ ...s }));
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
    const queue: SessionListEvent[] = [...this.sessions.values()]
      .map((session): SessionListEvent => ({ type: 'session_upserted', session: { ...session } }))
      // The inventory snapshot honors the same announce rule as live pushes:
      // a cwd-less session is never announced (DOR-202).
      .filter(isAnnounceable);
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

  /** Get-or-create the tracked entry and fold in the patch (mutates in place). */
  private upsert(sessionId: string, patch: CodexSessionPatch): Session {
    let session = this.sessions.get(sessionId);
    if (!session) {
      const now = new Date().toISOString();
      session = {
        id: sessionId,
        title: '',
        createdAt: now,
        updatedAt: now,
        permissionMode: patch.permissionMode ?? 'default',
        runtime: 'codex',
      };
      this.sessions.set(sessionId, session);
    }
    if (patch.permissionMode !== undefined) session.permissionMode = patch.permissionMode;
    if (patch.model !== undefined) session.model = patch.model;
    if (patch.effort !== undefined) session.effort = patch.effort;
    if (patch.fastMode !== undefined) session.fastMode = patch.fastMode;
    if (patch.cwd !== undefined) session.cwd = patch.cwd;
    return session;
  }

  /** Fan an event to all live list subscribers (cwd-less upserts are suppressed — DOR-202). */
  private emit(event: SessionListEvent): void {
    if (!isAnnounceable(event)) return;
    for (const listener of this.listeners) listener(event);
  }
}
