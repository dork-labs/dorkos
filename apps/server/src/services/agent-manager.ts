import path from 'path';
import { fileURLToPath } from 'url';
import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Response } from 'express';
import type { StreamEvent, PermissionMode } from '@dorkos/shared/types';
import { SESSIONS } from '../config/constants.js';
import { SessionLockManager } from './session-lock.js';
import { createCanUseTool } from './interactive-handlers.js';
import { type AgentSession, createToolState } from './agent-types.js';
import { mapSdkMessage } from './sdk-event-mapper.js';
import { makeUserPrompt, resolveClaudeCliPath } from '../lib/sdk-utils.js';
import { buildSystemPromptAppend } from './context-builder.js';
import { validateBoundary } from '../lib/boundary.js';
import { logger } from '../lib/logger.js';

export { buildTaskEvent } from './build-task-event.js';

/**
 * Manages Claude Agent SDK sessions — creation, resumption, streaming, tool approval,
 * and session locking. Calls the SDK's `query()` function and maps streaming events
 * to DorkOS `StreamEvent` types. Tracks active sessions in-memory with 30-minute timeout.
 */
export class AgentManager {
  private sessions = new Map<string, AgentSession>();
  private lockManager = new SessionLockManager();
  private readonly SESSION_TIMEOUT_MS = SESSIONS.TIMEOUT_MS;
  private readonly cwd: string;
  private readonly claudeCliPath: string | undefined;
  private mcpServers: Record<string, unknown> = {};

  constructor(cwd?: string) {
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    this.cwd = cwd ?? process.env.DORKOS_DEFAULT_CWD ?? path.resolve(thisDir, '../../../../');
    this.claudeCliPath = resolveClaudeCliPath();
  }

  /**
   * Register MCP tool servers to be injected into every SDK query() call.
   * Called once at server startup after singleton services are initialized.
   */
  setMcpServers(servers: Record<string, unknown>): void {
    this.mcpServers = servers;
  }

  /**
   * Start or resume an agent session.
   * For new sessions, sdkSessionId is assigned after the first query() init message.
   * For resumed sessions, the sessionId IS the sdkSessionId.
   */
  ensureSession(
    sessionId: string,
    opts: {
      permissionMode: PermissionMode;
      cwd?: string;
      hasStarted?: boolean;
    }
  ): void {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, {
        sdkSessionId: sessionId,
        lastActivity: Date.now(),
        permissionMode: opts.permissionMode,
        cwd: opts.cwd,
        hasStarted: opts.hasStarted ?? false,
        pendingInteractions: new Map(),
        eventQueue: [],
      });
    }
  }

  async *sendMessage(
    sessionId: string,
    content: string,
    opts?: { permissionMode?: PermissionMode; cwd?: string }
  ): AsyncGenerator<StreamEvent> {
    // Auto-create session if it doesn't exist (for resuming SDK sessions).
    if (!this.sessions.has(sessionId)) {
      this.ensureSession(sessionId, {
        permissionMode: opts?.permissionMode ?? 'default',
        cwd: opts?.cwd,
        hasStarted: true,
      });
    }

    const session = this.sessions.get(sessionId)!;
    session.lastActivity = Date.now();
    session.eventQueue = [];

    const effectiveCwd = session.cwd ?? this.cwd;
    try {
      await validateBoundary(effectiveCwd);
    } catch {
      yield { type: 'error', data: { message: `Directory boundary violation: ${effectiveCwd}` } };
      return;
    }

    const systemPromptAppend = await buildSystemPromptAppend(effectiveCwd);

    const sdkOptions: Options = {
      cwd: effectiveCwd,
      includePartialMessages: true,
      settingSources: ['project', 'user'],
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: systemPromptAppend,
      },
      ...(this.claudeCliPath ? { pathToClaudeCodeExecutable: this.claudeCliPath } : {}),
    };

    if (session.hasStarted) {
      sdkOptions.resume = session.sdkSessionId;
    }

    logger.debug('[sendMessage]', {
      session: sessionId,
      permissionMode: session.permissionMode,
      hasStarted: session.hasStarted,
      resume: session.hasStarted ? session.sdkSessionId : 'N/A',
    });

    sdkOptions.permissionMode = session.permissionMode === 'bypassPermissions'
      || session.permissionMode === 'plan'
      || session.permissionMode === 'acceptEdits'
      ? session.permissionMode : 'default';
    if (session.permissionMode === 'bypassPermissions') {
      sdkOptions.allowDangerouslySkipPermissions = true;
    }

    if (session.model) {
      (sdkOptions as Record<string, unknown>).model = session.model;
    }

    // Inject MCP tool servers (if any registered)
    if (Object.keys(this.mcpServers).length > 0) {
      (sdkOptions as Record<string, unknown>).mcpServers = this.mcpServers;
    }

    sdkOptions.canUseTool = createCanUseTool(session, logger.debug.bind(logger));

    const agentQuery = query({ prompt: makeUserPrompt(content), options: sdkOptions });
    session.activeQuery = agentQuery;

    let emittedDone = false;
    const toolState = createToolState();

    try {
      const sdkIterator = agentQuery[Symbol.asyncIterator]();
      let pendingSdkPromise: Promise<{ sdk: true; result: IteratorResult<SDKMessage> }> | null =
        null;

      while (true) {
        while (session.eventQueue.length > 0) {
          const queuedEvent = session.eventQueue.shift()!;
          if (queuedEvent.type === 'done') emittedDone = true;
          yield queuedEvent;
        }

        const queuePromise = new Promise<'queue'>((resolve) => {
          session.eventQueueNotify = () => resolve('queue');
        });

        if (!pendingSdkPromise) {
          pendingSdkPromise = sdkIterator.next().then((result) => ({ sdk: true as const, result }));
        }

        const winner = await Promise.race([queuePromise, pendingSdkPromise]);

        if (winner === 'queue') {
          continue;
        }

        pendingSdkPromise = null;
        const { result } = winner;
        if (result.done) break;

        for await (const event of mapSdkMessage(result.value, session, sessionId, toolState)) {
          if (event.type === 'done') emittedDone = true;
          yield event;
        }
      }
    } catch (err) {
      yield {
        type: 'error',
        data: {
          message: err instanceof Error ? err.message : 'SDK error',
        },
      };
    } finally {
      session.activeQuery = undefined;
    }

    if (!emittedDone) {
      yield {
        type: 'done',
        data: { sessionId },
      };
    }
  }

  updateSession(
    sessionId: string,
    opts: { permissionMode?: PermissionMode; model?: string }
  ): boolean {
    let session = this.findSession(sessionId);
    if (!session) {
      this.ensureSession(sessionId, {
        permissionMode: opts.permissionMode ?? 'default',
        hasStarted: true,
      });
      session = this.sessions.get(sessionId)!;
    }
    if (opts.permissionMode) {
      logger.debug('[updateSession] permissionMode change', { sessionId, from: session.permissionMode, to: opts.permissionMode });
      session.permissionMode = opts.permissionMode;
      if (session.activeQuery) {
        session.activeQuery.setPermissionMode(opts.permissionMode).catch((err) => {
          logger.error('[updateSession] setPermissionMode failed', { sessionId, err });
        });
      }
    }
    if (opts.model) {
      session.model = opts.model;
    }
    return true;
  }

  approveTool(sessionId: string, toolCallId: string, approved: boolean): boolean {
    const session = this.findSession(sessionId);
    const pending = session?.pendingInteractions.get(toolCallId);
    if (!pending || pending.type !== 'approval') return false;
    pending.resolve(approved);
    return true;
  }

  submitAnswers(sessionId: string, toolCallId: string, answers: Record<string, string>): boolean {
    const session = this.findSession(sessionId);
    const pending = session?.pendingInteractions.get(toolCallId);
    if (!pending || pending.type !== 'question') return false;
    pending.resolve(answers);
    return true;
  }

  checkSessionHealth(): void {
    const now = Date.now();
    const expiredIds: string[] = [];
    for (const [id, session] of this.sessions) {
      if (now - session.lastActivity > this.SESSION_TIMEOUT_MS) {
        for (const interaction of session.pendingInteractions.values()) {
          clearTimeout(interaction.timeout);
        }
        this.sessions.delete(id);
        expiredIds.push(id);
      }
    }
    this.lockManager.cleanup(expiredIds);
  }

  /** Find a session by its map key OR by its sdkSessionId. */
  private findSession(sessionId: string): AgentSession | undefined {
    const direct = this.sessions.get(sessionId);
    if (direct) return direct;
    for (const session of this.sessions.values()) {
      if (session.sdkSessionId === sessionId) return session;
    }
    return undefined;
  }

  hasSession(sessionId: string): boolean {
    return !!this.findSession(sessionId);
  }

  /** Get the actual SDK session ID (may differ from input if SDK assigned a new one). */
  getSdkSessionId(sessionId: string): string | undefined {
    return this.findSession(sessionId)?.sdkSessionId;
  }

  // Session lock delegation
  acquireLock(sessionId: string, clientId: string, res: Response): boolean {
    return this.lockManager.acquireLock(sessionId, clientId, res);
  }

  releaseLock(sessionId: string, clientId: string): void {
    this.lockManager.releaseLock(sessionId, clientId);
  }

  isLocked(sessionId: string, clientId?: string): boolean {
    return this.lockManager.isLocked(sessionId, clientId);
  }

  getLockInfo(sessionId: string): { clientId: string; acquiredAt: number } | null {
    return this.lockManager.getLockInfo(sessionId);
  }
}

export const agentManager = new AgentManager();
