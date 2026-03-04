import { query, type Options, type SDKMessage, type McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { Response } from 'express';
import type { StreamEvent, PermissionMode, ModelOption } from '@dorkos/shared/types';
import { SESSIONS } from '../../config/constants.js';
import { SessionLockManager } from '../session/session-lock.js';
import { createCanUseTool } from './interactive-handlers.js';
import { type AgentSession, createToolState } from './agent-types.js';
import { mapSdkMessage } from './sdk-event-mapper.js';
import { makeUserPrompt, resolveClaudeCliPath } from '../../lib/sdk-utils.js';
import { buildSystemPromptAppend } from './context-builder.js';
import { resolveToolConfig, buildAllowedTools } from './tool-filter.js';
import { validateBoundary } from '../../lib/boundary.js';
import { logger } from '../../lib/logger.js';
import { DEFAULT_CWD } from '../../lib/resolve-root.js';
import { readManifest } from '@dorkos/shared/manifest';
import { isRelayEnabled } from '../relay/relay-state.js';
import { isPulseEnabled } from '../pulse/pulse-state.js';
import { configManager } from './config-manager.js';
import type { MeshCore } from '@dorkos/mesh';

export { buildTaskEvent } from '../session/build-task-event.js';

const RESUME_FAILURE_PATTERNS = [
  'query closed before response',
  'session not found',
  'no such file',
  'enoent',
  'process exited with code',
];

/** Detect whether an error indicates a failed SDK session resume. */
function isResumeFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return RESUME_FAILURE_PATTERNS.some((p) => msg.includes(p));
}

const DEFAULT_MODELS: ModelOption[] = [
  { value: 'claude-sonnet-4-5-20250929', displayName: 'Sonnet 4.5', description: 'Fast, intelligent model for everyday tasks' },
  { value: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5', description: 'Fastest, most compact model' },
  { value: 'claude-opus-4-6', displayName: 'Opus 4.6', description: 'Most capable model for complex tasks' },
];

/**
 * Manages Claude Agent SDK sessions — creation, resumption, streaming, tool approval,
 * and session locking. Calls the SDK's `query()` function and maps streaming events
 * to DorkOS `StreamEvent` types. Tracks active sessions in-memory with 30-minute timeout.
 */
export class AgentManager {
  private sessions = new Map<string, AgentSession>();
  /** Reverse index: SDK session ID → our session map key, for O(1) lookup. */
  private sdkSessionIndex = new Map<string, string>();
  private lockManager = new SessionLockManager();
  private readonly SESSION_TIMEOUT_MS = SESSIONS.TIMEOUT_MS;
  private readonly cwd: string;
  private readonly claudeCliPath: string | undefined;
  private mcpServerFactory: (() => Record<string, McpServerConfig>) | null = null;
  private cachedModels: ModelOption[] | null = null;
  private meshCore: MeshCore | null = null;

  constructor(cwd?: string) {
    this.cwd = cwd ?? DEFAULT_CWD;
    this.claudeCliPath = resolveClaudeCliPath();
  }

  /**
   * Set the MeshCore instance for agent manifest resolution and peer agent context.
   *
   * @param meshCore - The MeshCore instance from server startup
   */
  setMeshCore(meshCore: MeshCore): void {
    this.meshCore = meshCore;
  }

  /**
   * Register a factory that creates fresh MCP tool server configs per query() call.
   *
   * Each SDK query() call needs its own McpServer instance because the SDK's
   * internal Protocol can only be connected to one transport at a time. Reusing
   * the same instance across concurrent queries causes "Already connected to a
   * transport" errors.
   *
   * @param factory - A function that returns a fresh McpServerConfig record
   */
  setMcpServerFactory(factory: () => Record<string, McpServerConfig>): void {
    this.mcpServerFactory = factory;
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
      // Initial reverse index entry (sdkSessionId === sessionId at creation)
      this.sdkSessionIndex.set(sessionId, sessionId);
    }
  }

  async *sendMessage(
    sessionId: string,
    content: string,
    opts?: { permissionMode?: PermissionMode; cwd?: string; systemPromptAppend?: string }
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

    // Use opts.cwd if explicitly provided (e.g., CCA passes Mesh context dir),
    // fall through empty strings from stale bindings, then fall back to default.
    const effectiveCwd = opts?.cwd || session.cwd || this.cwd;
    try {
      await validateBoundary(effectiveCwd);
    } catch {
      yield { type: 'error', data: { message: `Directory boundary violation: ${effectiveCwd}` } };
      return;
    }

    // Stamp agent last_seen_at when a message is dispatched
    const meshAgent = this.meshCore?.getByPath(effectiveCwd);
    const meshAgentId = meshAgent?.id;
    if (this.meshCore && meshAgentId) {
      this.meshCore.updateLastSeen(meshAgentId, 'message_sent');
    }

    // Load agent manifest for per-agent tool filtering
    let manifest: Awaited<ReturnType<typeof readManifest>> | null = null;
    try {
      manifest = await readManifest(effectiveCwd);
    } catch {
      // No manifest found — all tools inherit global defaults
    }

    const globalConfig = configManager.get('agentContext') ?? {
      pulseTools: true,
      relayTools: true,
      meshTools: true,
      adapterTools: true,
    };

    const toolConfig = resolveToolConfig(manifest?.enabledToolGroups, {
      relayEnabled: isRelayEnabled(),
      pulseEnabled: isPulseEnabled(),
      globalConfig,
    });

    const baseAppend = await buildSystemPromptAppend(effectiveCwd, this.meshCore, toolConfig);
    // Concatenate caller-supplied append (e.g. Pulse scheduler context) after the base
    const systemPromptAppend = opts?.systemPromptAppend
      ? `${baseAppend}\n\n${opts.systemPromptAppend}`
      : baseAppend;

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

    // CWD resolution chain: opts.cwd (from caller) → session.cwd (from creation) → this.cwd (default)
    const cwdSource = opts?.cwd ? 'opts.cwd' : session.cwd ? 'session.cwd' : 'default';
    logger.debug('[sendMessage]', {
      session: sessionId,
      permissionMode: session.permissionMode,
      hasStarted: session.hasStarted,
      resume: session.hasStarted ? session.sdkSessionId : 'N/A',
      effectiveCwd,
      cwdSource,
      'opts.cwd': opts?.cwd || '(empty)',
      'session.cwd': session.cwd || '(empty)',
    });

    sdkOptions.permissionMode = session.permissionMode === 'bypassPermissions'
      || session.permissionMode === 'plan'
      || session.permissionMode === 'acceptEdits'
      ? session.permissionMode : 'default';
    if (session.permissionMode === 'bypassPermissions') {
      sdkOptions.allowDangerouslySkipPermissions = true;
    }

    if (session.model) {
      sdkOptions.model = session.model;
    }

    // Inject MCP tool servers — create fresh instances per query to avoid
    // "Already connected to a transport" errors from reused Protocol objects.
    if (this.mcpServerFactory) {
      sdkOptions.mcpServers = this.mcpServerFactory();
    }

    // Apply per-agent MCP tool filtering (undefined = no filter = all tools available)
    const allowedTools = buildAllowedTools(toolConfig);
    if (allowedTools) {
      sdkOptions.allowedTools = [
        ...(sdkOptions.allowedTools ?? []),
        ...allowedTools,
      ];
    }

    sdkOptions.canUseTool = createCanUseTool(session, logger.debug.bind(logger));

    const agentQuery = query({ prompt: makeUserPrompt(content), options: sdkOptions });
    session.activeQuery = agentQuery;

    // Non-blocking model fetch on first invocation
    if (!this.cachedModels) {
      agentQuery.supportedModels().then((models) => {
        this.cachedModels = models.map((m) => ({
          value: m.value,
          displayName: m.displayName,
          description: m.description,
        }));
        logger.debug('[sendMessage] cached supported models', { count: this.cachedModels.length });
      }).catch((err) => {
        logger.debug('[sendMessage] failed to fetch supported models', { err });
      });
    }

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

        const prevSdkId = session.sdkSessionId;
        for await (const event of mapSdkMessage(result.value, session, sessionId, toolState)) {
          if (event.type === 'done') {
            emittedDone = true;
            if (this.meshCore && meshAgentId) {
              this.meshCore.updateLastSeen(meshAgentId, 'response_complete');
            }
          }
          yield event;
        }
        // Update reverse index if sdk-event-mapper assigned a new SDK session ID
        if (session.sdkSessionId !== prevSdkId) {
          this.sdkSessionIndex.delete(prevSdkId);
          this.sdkSessionIndex.set(session.sdkSessionId, sessionId);
        }
      }
    } catch (err) {
      if (session.hasStarted && isResumeFailure(err)) {
        logger.warn('[sendMessage] resume failed for stale session, retrying as new', {
          session: sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        session.hasStarted = false;
        yield* this.sendMessage(sessionId, content, opts);
        return;
      }
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
        this.sdkSessionIndex.delete(session.sdkSessionId);
        this.sessions.delete(id);
        expiredIds.push(id);
      }
    }
    this.lockManager.cleanup(expiredIds);
  }

  /** Find a session by its map key OR by its sdkSessionId (O(1) via reverse index). */
  private findSession(sessionId: string): AgentSession | undefined {
    const direct = this.sessions.get(sessionId);
    if (direct) return direct;
    const mappedKey = this.sdkSessionIndex.get(sessionId);
    return mappedKey ? this.sessions.get(mappedKey) : undefined;
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

  /** Get available models — returns SDK-reported models if cached, otherwise defaults. */
  async getSupportedModels(): Promise<ModelOption[]> {
    return this.cachedModels ?? DEFAULT_MODELS;
  }
}

export const agentManager = new AgentManager();
