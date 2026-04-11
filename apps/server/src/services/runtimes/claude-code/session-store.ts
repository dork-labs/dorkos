/**
 * In-memory session store — lifecycle, lookup, and interactive flow management.
 *
 * Extracted from ClaudeCodeRuntime to keep the runtime class as a thin facade.
 * Owns the session Map, SDK session index, and all session mutation logic.
 *
 * @module services/runtimes/claude-code/session-store
 */
import { forkSession as sdkForkSession } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionMode, EffortLevel, Session } from '@dorkos/shared/types';
import type { SessionOpts, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { AgentSession } from './agent-types.js';
import { SESSIONS } from '../../../config/constants.js';
import { logger } from '../../../lib/logger.js';
import type { TranscriptReader } from './transcript-reader.js';
import type { SessionLockManager } from './session-lock.js';

/**
 * Manages in-memory session state for the Claude Code runtime.
 *
 * Tracks active sessions, handles the SDK session ID reverse index,
 * and provides session lifecycle, interactive flow, and health check operations.
 */
export class SessionStore {
  private sessions = new Map<string, AgentSession>();
  /** Reverse index: SDK session ID → session map key, for O(1) lookup. */
  private sdkSessionIndex = new Map<string, string>();
  private readonly SESSION_TIMEOUT_MS = SESSIONS.TIMEOUT_MS;

  /** Expose the reverse index for message-sender's SDK session remapping. */
  getSdkSessionIndex(): Map<string, string> {
    return this.sdkSessionIndex;
  }

  /** Find a session by map key or SDK session ID (O(1) via reverse index). */
  findSession(sessionId: string): AgentSession | undefined {
    const direct = this.sessions.get(sessionId);
    if (direct) return direct;
    const mappedKey = this.sdkSessionIndex.get(sessionId);
    return mappedKey ? this.sessions.get(mappedKey) : undefined;
  }

  // ---------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start or resume an agent session.
   *
   * For new sessions, sdkSessionId is assigned after the first query() init message.
   * For resumed sessions, the sessionId IS the sdkSessionId.
   */
  ensureSession(sessionId: string, opts: SessionOpts): void {
    if (this.sessions.has(sessionId)) return;

    if (this.sessions.size >= SESSIONS.MAX_SESSIONS) {
      throw new Error(
        `Maximum session limit reached (${SESSIONS.MAX_SESSIONS}). ` +
          'Wait for existing sessions to expire or restart the server.'
      );
    }
    logger.debug('[ensureSession] creating new session', {
      session: sessionId,
      cwd: opts.cwd || '(empty)',
      permissionMode: opts.permissionMode,
      hasStarted: opts.hasStarted ?? false,
    });
    this.sessions.set(sessionId, {
      sdkSessionId: sessionId,
      lastActivity: Date.now(),
      permissionMode: opts.permissionMode,
      cwd: opts.cwd,
      hasStarted: opts.hasStarted ?? false,
      pendingInteractions: new Map(),
      eventQueue: [],
    });
    this.sdkSessionIndex.set(sessionId, sessionId);
  }

  /**
   * Resolve or create a session for an incoming message.
   *
   * Handles auto-creation with transcript-based hasStarted detection
   * and deferred transcript checks from updateSession.
   */
  async ensureForMessage(
    sessionId: string,
    transcriptReader: TranscriptReader,
    defaultCwd: string,
    opts?: MessageOpts
  ): Promise<AgentSession> {
    const existing = this.findSession(sessionId);
    if (!existing) {
      const effectiveCwd = opts?.cwd ?? defaultCwd;
      const hasTranscript = await transcriptReader.hasTranscript(effectiveCwd, sessionId);
      logger.debug('[sendMessage] auto-creating session', {
        session: sessionId,
        hasTranscript,
        cwd: effectiveCwd,
      });
      this.ensureSession(sessionId, {
        permissionMode: opts?.permissionMode ?? 'default',
        cwd: opts?.cwd,
        hasStarted: hasTranscript,
      });
    } else if (existing.needsTranscriptCheck) {
      // updateSession auto-created with hasStarted=false — verify transcript on disk
      existing.needsTranscriptCheck = false;
      const effectiveCwd = opts?.cwd || existing.cwd || defaultCwd;
      const hasTranscript = await transcriptReader.hasTranscript(effectiveCwd, sessionId);
      if (hasTranscript) {
        logger.debug('[sendMessage] upgrading hasStarted for existing transcript', {
          session: sessionId,
        });
        existing.hasStarted = true;
      }
    }
    return this.findSession(sessionId)!;
  }

  /** Fork a session, creating a new independent copy of the conversation. */
  async forkSession(
    projectDir: string,
    sessionId: string,
    transcriptReader: TranscriptReader,
    opts?: { upToMessageId?: string; title?: string }
  ): Promise<Session | null> {
    const internalId = this.getInternalSessionId(sessionId) ?? sessionId;
    try {
      const result = await sdkForkSession(internalId, {
        dir: projectDir,
        upToMessageId: opts?.upToMessageId,
        title: opts?.title,
      });
      logger.info('[forkSession] session forked', {
        source: sessionId,
        newSessionId: result.sessionId,
      });
      return transcriptReader.getSession(projectDir, result.sessionId);
    } catch (err) {
      logger.error('[forkSession] fork failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /** Return true if the session is currently tracked in memory. */
  hasSession(sessionId: string): boolean {
    return !!this.findSession(sessionId);
  }

  /** Update mutable session fields. Returns false if the session does not exist. */
  async updateSession(
    sessionId: string,
    opts: {
      permissionMode?: PermissionMode;
      model?: string;
      effort?: EffortLevel;
      fastMode?: boolean;
      autoMode?: boolean;
    }
  ): Promise<boolean> {
    let session = this.findSession(sessionId);
    if (!session) {
      // Auto-create with hasStarted=false — sendMessage will check the transcript
      // on disk before deciding whether to resume.
      this.ensureSession(sessionId, {
        permissionMode: opts.permissionMode ?? 'default',
        hasStarted: false,
      });
      this.sessions.get(sessionId)!.needsTranscriptCheck = true;
      session = this.sessions.get(sessionId)!;
    }
    if (opts.permissionMode) {
      const prevMode = session.permissionMode;
      session.permissionMode = opts.permissionMode;
      if (session.activeQuery) {
        try {
          await session.activeQuery.setPermissionMode(
            opts.permissionMode as Parameters<typeof session.activeQuery.setPermissionMode>[0]
          );
        } catch (err) {
          session.permissionMode = prevMode;
          logger.error('[updateSession] setPermissionMode failed', { sessionId, err });
          throw err;
        }
      }
      logger.debug('[updateSession] permissionMode change', {
        sessionId,
        from: prevMode,
        to: opts.permissionMode,
      });
    }
    if (opts.model) session.model = opts.model;
    if (opts.effort) session.effort = opts.effort;
    if (opts.fastMode !== undefined) session.fastMode = opts.fastMode;
    if (opts.autoMode !== undefined) session.autoMode = opts.autoMode;
    return true;
  }

  // ---------------------------------------------------------------------------
  // Interactive flows
  // ---------------------------------------------------------------------------

  /** Approve or deny a pending tool call. When `alwaysAllow` is true, forwards SDK suggestions. */
  approveTool(
    sessionId: string,
    toolCallId: string,
    approved: boolean,
    alwaysAllow?: boolean
  ): boolean {
    const session = this.findSession(sessionId);
    const pending = session?.pendingInteractions.get(toolCallId);
    if (!pending || pending.type !== 'approval') return false;

    if (approved && alwaysAllow && pending.suggestions?.length) {
      // "Always Allow" — pass the SDK permission suggestions array
      pending.resolve(pending.suggestions);
    } else {
      pending.resolve(approved);
    }
    return true;
  }

  /** Submit answers to a pending AskUserQuestion interaction. */
  submitAnswers(sessionId: string, toolCallId: string, answers: Record<string, string>): boolean {
    const session = this.findSession(sessionId);
    const pending = session?.pendingInteractions.get(toolCallId);
    if (!pending || pending.type !== 'question') return false;
    pending.resolve(answers);
    return true;
  }

  /** Submit a response to an MCP elicitation prompt. */
  submitElicitation(
    sessionId: string,
    interactionId: string,
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, unknown>
  ): boolean {
    const session = this.findSession(sessionId);
    const pending = session?.pendingInteractions.get(interactionId);
    if (!pending || pending.type !== 'elicitation') return false;
    pending.resolve({
      action,
      content: content as Record<string, string | number | boolean | string[]> | undefined,
    });
    return true;
  }

  /** Stop a running background task. */
  async stopTask(sessionId: string, taskId: string): Promise<boolean> {
    const session = this.findSession(sessionId);
    if (!session?.activeQuery) return false;
    try {
      await session.activeQuery.stopTask(taskId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Interrupt the active query for a session.
   *
   * Tries `query.interrupt()` first (graceful). If that throws,
   * falls back to `query.close()` (forceful subprocess termination).
   */
  async interruptQuery(sessionId: string): Promise<boolean> {
    const session = this.findSession(sessionId);
    if (!session?.activeQuery) return false;
    try {
      await session.activeQuery.interrupt();
      return true;
    } catch {
      // Interrupt failed — escalate to forceful close
      try {
        session.activeQuery.close();
        return true;
      } catch {
        return false;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Evict sessions that have exceeded their idle timeout. */
  checkSessionHealth(lockManager: SessionLockManager): void {
    const now = Date.now();
    const expiredIds: string[] = [];
    for (const [id, session] of this.sessions) {
      if (now - session.lastActivity > this.SESSION_TIMEOUT_MS) {
        for (const interaction of session.pendingInteractions.values()) {
          clearTimeout(interaction.timeout);
        }
        this.sdkSessionIndex.delete(session.sdkSessionId);
        this.sessions.delete(id);
        expiredIds.push(id);
      }
    }
    lockManager.cleanup(expiredIds);
  }

  /** Return the backend-internal session ID (SDK session ID) for a DorkOS session ID. */
  getInternalSessionId(sessionId: string): string | undefined {
    return this.findSession(sessionId)?.sdkSessionId;
  }

  /**
   * Backward-compatible alias for `getInternalSessionId`.
   *
   * @deprecated Use `getInternalSessionId()` instead.
   */
  getSdkSessionId(sessionId: string): string | undefined {
    return this.getInternalSessionId(sessionId);
  }
}
