import { createHash } from 'node:crypto';
import type { SessionOpts, SseResponse } from '@dorkos/shared/agent-runtime';
import type { Session, HistoryMessage, TaskItem } from '@dorkos/shared/types';
import type {
  SessionSnapshot,
  SessionEvent,
  SessionListEvent,
} from '@dorkos/shared/session-stream';
import { DoeInferenceConfigSchema } from '@dorkos/shared/config-schema';
import { DEFAULT_CWD } from '../../../lib/resolve-root.js';
import {
  getOrCreateProjector,
  peekProjector,
  streamGenerationOf,
} from '../../session/session-state-projector.js';
import { readLogBackedHistory } from '../../session/log-backed-history.js';
import { SessionLockManager } from '../../session/session-lock.js';
import { DoeSessionStore } from './session-store.js';
/** Metadata, display history and locks stay inert and separate from model execution. */
export class DoeSessionRuntime {
  readonly sessions: DoeSessionStore;
  private readonly locks = new SessionLockManager();
  constructor(
    protected readonly sessionOptions: {
      directory?: string;
      defaultCwd?: string;
    } = {}
  ) {
    this.sessions = new DoeSessionStore(sessionOptions.directory);
  }
  /** Register idempotently without doing model work. */
  ensureSession(id: string, opts: SessionOpts): void {
    this.sessions.ensure(id, opts);
  }
  /** Cold session lookup creates nothing. */
  hasSession(id: string): boolean {
    return this.sessions.get(id) !== null;
  }
  /** Forking is explicitly unsupported until full provider-message copying is supplied. */
  async forkSession(): Promise<Session | null> {
    return null;
  }
  /** Rename only a session in the requested project. */
  async renameSession(id: string, title: string, projectDir: string): Promise<void> {
    if (!this.sessions.belongs(id, projectDir)) return;
    const record = this.sessions.get(id)!;
    record.session.title = title;
    record.session.updatedAt = new Date().toISOString();
    this.sessions.save(record);
  }
  /** List only sessions belonging to this canonical project subtree. */
  async listSessions(project: string): Promise<Session[]> {
    return this.sessions.list(project);
  }
  /** Metadata lookup cannot leak a session from another project. */
  async getSession(project: string, id: string): Promise<Session | null> {
    return this.sessions.belongs(id, project) ? this.sessions.get(id)!.session : null;
  }
  /** Display history reads the durable EventLog, never the engine's provider records. */
  async getMessageHistory(project: string, id: string): Promise<HistoryMessage[]> {
    return this.sessions.belongs(id, project) ? readLogBackedHistory(id) : [];
  }
  /** The business engine has no vendor-specific transcript task list. */
  async getSessionTasks(): Promise<TaskItem[]> {
    return [];
  }
  /** A metadata/history identity for conditional display requests. */
  async getSessionETag(project: string, id: string): Promise<string | null> {
    if (!this.sessions.belongs(id, project)) return null;
    return createHash('sha256')
      .update(JSON.stringify(await this.getMessageHistory(project, id)))
      .digest('hex');
  }
  /** Display IDs come from the same EventLog the client hydrates. */
  async getLastMessageIds(id: string): Promise<{
    user: string;
    assistant: string;
  } | null> {
    const messages = readLogBackedHistory(id);
    const user = [...messages].reverse().find((message) => message.role === 'user');
    const assistant = [...messages].reverse().find((message) => message.role === 'assistant');
    return user && assistant ? { user: user.id, assistant: assistant.id } : null;
  }
  /** Synchronous metadata-only directory lookup, with no cold session creation. */
  getSessionCwd(id: string): string | undefined {
    return this.sessions.get(id)?.session.cwd;
  }
  /** Persisted provider usage remains separate from current prompt-size estimates. */
  async readContextUsage(id: string): Promise<{
    contextTokens: number;
    contextMaxTokens: number;
  } | null> {
    try {
      const record = this.sessions.get(id);
      if (!record?.inference) return null;
      const usage = this.sessions.models.latestUsage(id);
      const checkpoint = this.sessions.models.latestCheckpoint(id);
      const contextTokens =
        checkpoint && usage?.contextCheckpointSeq !== checkpoint.seq
          ? checkpoint.after.tokens
          : usage?.inputTokens;
      return contextTokens === undefined
        ? null
        : {
            contextTokens,
            contextMaxTokens: DoeInferenceConfigSchema.parse(record.inference).contextWindow,
          };
    } catch {
      return null;
    }
  }
  /** Offset reads expose only the display transcript, scoped to its project. */
  async readFromOffset(
    project: string,
    id: string,
    offset: number
  ): Promise<{
    content: string;
    newOffset: number;
  }> {
    const bytes = Buffer.from(JSON.stringify(await this.getMessageHistory(project, id)));
    const from = Number.isSafeInteger(offset) && offset >= 0 ? Math.min(offset, bytes.length) : 0;
    return { content: bytes.subarray(from).toString('utf8'), newOffset: bytes.length };
  }
  /** Build a durable display snapshot without starting model work. */
  async getSessionSnapshot(ctx: SessionOpts, id: string): Promise<SessionSnapshot> {
    const projector = getOrCreateProjector(id, ctx.cwd, { persist: 'history' });
    return projector.buildSnapshot(() =>
      this.getMessageHistory(ctx.cwd ?? this.sessionOptions.defaultCwd ?? DEFAULT_CWD, id)
    );
  }
  /** Bind resumable delivery to the same projector and generation as the trigger path. */
  subscribeSession(
    ctx: SessionOpts,
    id: string,
    since?: number,
    signal?: AbortSignal
  ): AsyncIterable<SessionEvent> {
    return getOrCreateProjector(id, ctx.cwd, { persist: 'history' }).subscribe(since, signal);
  }
  /** Peek-only counter identity, never a reason to mint a new stream. */
  streamGeneration(_ctx: SessionOpts, id: string): string {
    return streamGenerationOf(peekProjector(id));
  }
  /** Discover durable metadata and live updates without any vendor directory watch. */
  subscribeSessionList(): AsyncIterable<SessionListEvent> {
    return this.sessions.subscribe();
  }
  /** Use the shared token-matched session lock semantics. */
  acquireLock(id: string, client: string, res: SseResponse, token?: symbol): boolean {
    return this.locks.acquireLock(id, client, res, token);
  }
  /** Release only the matching holder and acquisition. */
  releaseLock(id: string, client: string, token?: symbol): void {
    this.locks.releaseLock(id, client, token);
  }
  /** Report shared lock state. */
  isLocked(id: string, client?: string): boolean {
    return this.locks.isLocked(id, client);
  }
  /** Read the current lock holder without acquiring it. */
  getLockInfo(id: string): {
    clientId: string;
    acquiredAt: number;
  } | null {
    return this.locks.getLockInfo(id);
  }
}
