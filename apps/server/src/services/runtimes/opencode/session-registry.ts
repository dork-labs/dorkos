/**
 * In-memory session metadata registry for the OpenCode runtime.
 *
 * Unlike Codex (whose SDK exposes no listing surface), OpenCode sessions are
 * durably listable through the sidecar — so this registry is NOT the listing
 * source of truth. It exists for three facade concerns the sidecar cannot
 * serve: (1) per-session DorkOS settings (permission mode, model) that
 * OpenCode has no native store for — the overlay `listSessions` applies and
 * the mode the approval coordinator enforces; (2) the `hasSession` in-memory
 * tracking contract; (3) live `session_upserted` fan-out for
 * {@link OpenCodeRuntime.subscribeSessionList} so a session created or
 * renamed through DorkOS reaches the sidebar without a refresh.
 *
 * Mirrors `CodexSessionRegistry` deliberately (third instance of this shape,
 * after test-mode's). Extracting a shared tracked-session registry into
 * `services/session/` is the flagged follow-up — not folded into this task
 * because the codex file is concurrently owned by another change.
 *
 * @module services/runtimes/opencode/session-registry
 */
import type { Session, PermissionMode, EffortLevel } from '@dorkos/shared/types';
import type { SessionListEvent } from '@dorkos/shared/session-stream';

/** Max characters of a first message used as the derived session title/preview. */
const PREVIEW_MAX_CHARS = 80;

/** Metadata fields the registry can update on a tracked session. */
export interface OpenCodeSessionPatch {
  permissionMode?: PermissionMode;
  model?: string;
  effort?: EffortLevel;
  fastMode?: boolean;
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
 * Tracked-session settings + live `session_upserted` fan-out for the OpenCode
 * runtime. `subscribe()` yields the current inventory first, then live
 * upserts — mirroring the Claude session-list watcher's contract, minus the
 * watcher.
 */
export class OpenCodeSessionRegistry {
  private readonly sessions = new Map<string, Session>();
  private readonly listeners = new Set<(event: SessionListEvent) => void>();

  /**
   * Track a session (or refresh its settings) without a message — the
   * `ensureSession` path used by Tasks and relay bindings.
   */
  register(sessionId: string, patch: OpenCodeSessionPatch = {}): void {
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
    patch: OpenCodeSessionPatch & { title?: string } = {}
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

  /** Set a tracked session's display title, tracking it first if needed. */
  rename(sessionId: string, title: string): void {
    const session = this.upsert(sessionId, {});
    session.title = title;
    session.updatedAt = new Date().toISOString();
    this.emit({ type: 'session_upserted', session: { ...session } });
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
   * (DOR-202, ADR 260707-193314; mirrored from the Codex registry). It stays
   * reachable by id via {@link OpenCodeSessionRegistry.get}.
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

  /** Get-or-create the tracked entry and fold in the patch (mutates in place). */
  private upsert(sessionId: string, patch: OpenCodeSessionPatch): Session {
    let session = this.sessions.get(sessionId);
    if (!session) {
      const now = new Date().toISOString();
      session = {
        id: sessionId,
        title: '',
        createdAt: now,
        updatedAt: now,
        permissionMode: patch.permissionMode ?? 'default',
        runtime: 'opencode',
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

  /** Fan an event to all live list subscribers. */
  private emit(event: SessionListEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
