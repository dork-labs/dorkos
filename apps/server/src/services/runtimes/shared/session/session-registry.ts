import { isDeepStrictEqual } from 'node:util';
import { shownToPerson, titleShownToPerson } from '@dorkos/shared/kickoff';
import type { SessionListEvent } from '@dorkos/shared/session-stream';
import type { PermissionModeId, Session } from '@dorkos/shared/types';
import { deriveSessionTitle } from './derive-title.js';
import { RuntimeEventQueue } from './event-queue.js';
import { projectMembership } from './project-membership.js';

/** Settings an in-memory registry can retain. Each runtime declares its supported subset. */
export type TrackedSessionPatch = Partial<
  Pick<Session, 'permissionMode' | 'model' | 'effort' | 'fastMode' | 'cwd'>
>;

/** Synchronous reads in the backing store's own order. The owner commits durable writes. */
export interface TrackedSessionSource {
  get(id: string): Session | null | undefined;
  values(): Iterable<Session>;
}

interface MemoryOwner {
  session: Session;
}

interface RegistryOptions {
  runtime: string;
  defaultPermissionMode: PermissionModeId;
  labelTitle?: (title: string) => string;
  projectMembership?: (projectDir: string) => (cwd: unknown) => boolean;
  display?: (session: Session) => Session;
  source?: TrackedSessionSource;
}

const PREVIEW_MAX_CHARS = 80;

/** Show the first line at up to 80 codepoints, with the runtime's overflow marker. */
export function sessionMessagePreview(content: string, overflow = '…'): string {
  const firstLine = shownToPerson(content).split('\n', 1)[0] ?? '';
  const codepoints = [...firstLine];
  return titleShownToPerson(
    codepoints.length > PREVIEW_MAX_CHARS
      ? `${codepoints.slice(0, PREVIEW_MAX_CHARS).join('')}${overflow}`
      : firstLine
  );
}

/** Ordered tracked metadata and its inventory-plus-live session list stream. */
export class TrackedSessionRegistry<Patch extends TrackedSessionPatch> {
  private readonly source: TrackedSessionSource;
  private readonly memoryRows?: Map<string, MemoryOwner>;
  private readonly subscribers = new Set<RuntimeEventQueue<SessionListEvent>>();

  constructor(private readonly options: RegistryOptions) {
    if (options.source) this.source = options.source;
    else {
      const rows = new Map<string, MemoryOwner>();
      this.memoryRows = rows;
      this.source = {
        get: (id) => rows.get(id)?.session,
        *values() {
          for (const row of rows.values()) yield row.session;
        },
      };
    }
  }

  /** Read a detached session row, including a draft without a project. */
  get(id: string): Session | null {
    const session = this.source.get(id);
    return session ? this.display(session) : null;
  }

  /** Check for a tracked row without changing it. */
  has(id: string): boolean {
    return this.source.get(id) != null;
  }

  /** Return detached rows in backing order, optionally scoped to one project. */
  list(projectDir?: string): Session[] {
    const rows = Array.from(this.source.values());
    const belongs =
      projectDir === undefined || rows.length === 0
        ? undefined
        : (this.options.projectMembership ?? projectMembership)(projectDir);
    return rows
      .filter((session) => belongs === undefined || belongs(session.cwd))
      .map((session) => this.display(session));
  }

  /** Return every tracked id, including drafts, in backing order. */
  ids(): string[] {
    return Array.from(this.source.values(), (session) => session.id);
  }

  /** Track a session or refresh settings without changing its message timestamps. */
  register(id: string, patch?: Patch): void {
    this.saveDraft(this.draft(id, patch));
  }

  /** Update first-message metadata and publish one snapshot after any runtime field edits. */
  recordMessage(
    id: string,
    content: string,
    patch?: Patch & { title?: string },
    edit?: (session: Session) => void
  ): void {
    const session = this.draft(id, patch);
    const preview = sessionMessagePreview(content);
    if (session.title === '')
      session.title = this.label(
        titleShownToPerson(patch?.title ?? (deriveSessionTitle(content) || preview))
      );
    session.lastMessagePreview = preview;
    session.updatedAt = new Date().toISOString();
    edit?.(session);
    this.saveDraft(session);
  }

  /** Set the title without a message, retaining other metadata for a tracked session. */
  rename(id: string, title: string, patch?: Patch): void {
    const session = this.draft(id, patch);
    session.title = this.label(title);
    session.updatedAt = new Date().toISOString();
    this.saveDraft(session);
  }

  /** Replace a memory row and enqueue a detached copy. Callers decide merge and hydration policy. */
  set(session: Session): void {
    this.memory().set(session.id, { session: { ...session } });
    this.publishSaved(session);
  }

  /** Publish only after the owner has committed the row, without writing to its store. */
  publishSaved(session: Session): void {
    if (session.cwd !== undefined)
      this.emit({ type: 'session_upserted', session: this.display(session) });
  }

  /** Move a memory row to its canonical id and announce only the resulting upsert. */
  rekey(oldId: string, newId: string): void {
    if (oldId === newId) return;
    const memory = this.memory();
    const session = memory.get(oldId);
    if (!session) return;
    memory.delete(oldId);
    this.set({ ...session.session, id: newId, updatedAt: new Date().toISOString() });
  }

  /** Remove all memory rows, keeping existing subscriptions open for subsequent changes. */
  reset(): void {
    const memory = this.memory();
    const ids = [...memory.keys()];
    memory.clear();
    for (const sessionId of ids) this.emit({ type: 'session_removed', sessionId });
  }

  /** Yield a snapshot before subsequent events, with an immediately cancellable pending read. */
  subscribe(): AsyncIterableIterator<SessionListEvent> {
    const queue = new RuntimeEventQueue<SessionListEvent>();
    for (const session of this.list()) {
      if (session.cwd !== undefined) queue.push({ type: 'session_upserted', session });
    }
    this.subscribers.add(queue);
    const finish = queue.return.bind(queue);
    queue.return = () => {
      this.subscribers.delete(queue);
      return finish();
    };
    return queue;
  }

  /** Close readers before the owning runtime closes its backing store. */
  closeSubscribers(): void {
    for (const subscriber of this.subscribers) void subscriber.return();
  }

  /** Observe ownership and value together without exposing the mutable memory entry. */
  protected observeMemoryOwner(id: string) {
    const rows = this.memory();
    const owner = rows.get(id);
    const snapshot = owner ? structuredClone(owner.session) : undefined;
    return {
      tracked: owner !== undefined,
      isCurrent: (): boolean => {
        const current = rows.get(id);
        return (
          current === owner &&
          (current === undefined ||
            (current.session.id === id && isDeepStrictEqual(current.session, snapshot)))
        );
      },
    };
  }

  private saveDraft(session: Session): void {
    const owner = this.memory().get(session.id);
    if (!owner) {
      this.set(session);
      return;
    }
    owner.session = { ...session };
    this.publishSaved(session);
  }

  private draft(id: string, patch: TrackedSessionPatch = {}): Session {
    const current = this.memory().get(id)?.session;
    let session: Session;
    if (current) session = { ...current };
    else {
      const now = new Date().toISOString();
      session = {
        id,
        title: this.label(''),
        createdAt: now,
        updatedAt: now,
        permissionMode: this.options.defaultPermissionMode,
        runtime: this.options.runtime,
      };
    }
    if (patch.permissionMode !== undefined) session.permissionMode = patch.permissionMode;
    if (patch.cwd !== undefined) session.cwd = patch.cwd;
    if (patch.model !== undefined) session.model = patch.model;
    if (patch.effort !== undefined) session.effort = patch.effort;
    if (patch.fastMode !== undefined) session.fastMode = patch.fastMode;
    return session;
  }

  private label(title: string): string {
    return this.options.labelTitle?.(title) ?? title;
  }

  private display(session: Session): Session {
    const copy = { ...session };
    return this.options.display?.(copy) ?? copy;
  }

  private memory(): Map<string, MemoryOwner> {
    if (!this.memoryRows) throw new Error('The session source owns its writes.');
    return this.memoryRows;
  }

  private emit(event: SessionListEvent): void {
    for (const subscriber of this.subscribers) subscriber.push(event);
  }
}
