/**
 * SDK query execution -- extracted from ClaudeCodeRuntime.sendMessage()
 * for file size management.
 *
 * Contains the core messaging pipeline: boundary validation, agent manifest loading,
 * tool filtering, system prompt building, SDK option configuration, and event streaming.
 *
 * @module services/runtimes/claude-code/message-sender
 */
import {
  query,
  type Options,
  type SDKMessage,
  type McpServerConfig,
} from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent, ErrorCategory } from '@dorkos/shared/types';
import type { MessageOpts, AgentRegistryPort } from '@dorkos/shared/agent-runtime';
import type { McpServerEntry } from '@dorkos/shared/transport';
import type { AgentSession } from './agent-types.js';
import { createToolState } from './agent-types.js';
import { createCanUseTool } from './interactive-handlers.js';
import { mapSdkMessage } from './sdk-event-mapper.js';
import { makeUserPrompt } from './sdk-utils.js';
import { buildSystemPromptAppend, type RelayContextDeps } from './context-builder.js';
import type { BindingRouter } from '../../relay/binding-router.js';
import type { BindingStore } from '../../relay/binding-store.js';
import type { AdapterManager } from '../../relay/adapter-manager.js';
import { resolveToolConfig, buildAllowedTools } from './tool-filter.js';
import { validateBoundary } from '../../../lib/boundary.js';
import { logger } from '../../../lib/logger.js';
import { readManifest } from '@dorkos/shared/manifest';
import { isRelayEnabled } from '../../relay/relay-state.js';
import { isPulseEnabled } from '../../pulse/pulse-state.js';
import { configManager } from '../../core/config-manager.js';

/** Lightweight projection of the SDK's SlashCommand type — avoids leaking SDK types. */
export interface SdkCommandEntry {
  name: string;
  description: string;
  argumentHint: string;
}

/** Options bundle for executeSdkQuery, grouping runtime dependencies. */
export interface MessageSenderOpts {
  cwd: string;
  sessionCwd?: string;
  claudeCliPath?: string;
  meshCore?: AgentRegistryPort | null;
  bindingRouter?: BindingRouter;
  bindingStore?: BindingStore;
  adapterManager?: AdapterManager;
  mcpServerFactory?: ((session: AgentSession) => Record<string, McpServerConfig>) | null;
  onModelsReceived?: (
    models: Array<{
      value: string;
      displayName: string;
      description: string;
      supportsEffort?: boolean;
      supportedEffortLevels?: ('low' | 'medium' | 'high' | 'max')[];
    }>
  ) => void;
  onMcpStatusReceived?: (servers: McpServerEntry[]) => void;
  onCommandsReceived?: (commands: SdkCommandEntry[]) => void;
  sdkSessionIndex: Map<string, string>;
  sessionMapKey: string;
}

const RESUME_FAILURE_PATTERNS = [
  'query closed before response',
  'session not found',
  'no such file',
  'enoent',
];

/** Max transparent retries for stale session recovery before surfacing error. */
const MAX_RESUME_RETRIES = 1;

/** Detect whether an error indicates a failed SDK session resume. */
function isResumeFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return RESUME_FAILURE_PATTERNS.some((p) => msg.includes(p));
}

/**
 * Execute an SDK query and yield StreamEvent objects.
 *
 * This is the core messaging pipeline: validates boundary, loads agent manifest,
 * resolves tool filtering, builds system prompt context, configures SDK options,
 * and streams events from the SDK query.
 *
 * @param sessionId - Session identifier
 * @param content - User message text
 * @param session - In-memory session state (mutated during execution)
 * @param opts - Runtime dependencies and configuration
 * @param messageOpts - Optional caller-provided overrides
 */
export async function* executeSdkQuery(
  sessionId: string,
  content: string,
  session: AgentSession,
  opts: MessageSenderOpts,
  messageOpts?: MessageOpts,
  retryDepth = 0
): AsyncGenerator<StreamEvent> {
  session.lastActivity = Date.now();
  session.eventQueue = [];

  // Use messageOpts.cwd if explicitly provided (e.g., CCA passes Mesh context dir),
  // fall through empty strings from stale bindings, then fall back to default.
  const effectiveCwd = messageOpts?.cwd || opts.sessionCwd || opts.cwd;
  try {
    await validateBoundary(effectiveCwd);
  } catch {
    logger.warn('[sendMessage] boundary violation', { session: sessionId, effectiveCwd });
    yield {
      type: 'error',
      data: { message: `Directory boundary violation: ${effectiveCwd}` },
    };
    return;
  }

  // Stamp agent last_seen_at when a message is dispatched
  const meshAgent = opts.meshCore?.getByPath(effectiveCwd);
  const meshAgentId = meshAgent?.id;
  if (opts.meshCore && meshAgentId) {
    opts.meshCore.updateLastSeen(meshAgentId, 'message_sent');
  }

  // Load agent manifest for per-agent tool filtering
  let manifest: Awaited<ReturnType<typeof readManifest>> | null = null;
  try {
    manifest = await readManifest(effectiveCwd);
  } catch {
    // No manifest found -- all tools inherit global defaults
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

  const relayContext: RelayContextDeps | undefined =
    opts.bindingRouter && opts.bindingStore && opts.adapterManager && meshAgentId
      ? {
          agentId: meshAgentId,
          bindingRouter: opts.bindingRouter,
          bindingStore: opts.bindingStore,
          adapterManager: opts.adapterManager,
        }
      : undefined;

  const baseAppend = await buildSystemPromptAppend(
    effectiveCwd,
    opts.meshCore ?? undefined,
    toolConfig,
    relayContext,
    session.uiState
  );
  // Concatenate caller-supplied append (e.g. Pulse scheduler context) after the base
  const systemPromptAppend = messageOpts?.systemPromptAppend
    ? `${baseAppend}\n\n${messageOpts.systemPromptAppend}`
    : baseAppend;

  const sdkOptions: Options = {
    cwd: effectiveCwd,
    includePartialMessages: true,
    promptSuggestions: true,
    agentProgressSummaries: true,
    settingSources: ['local', 'project', 'user'],
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: systemPromptAppend,
    },
    toolConfig: {
      askUserQuestion: { previewFormat: 'html' },
    },
    env: {
      ...process.env,
      CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
    },
    ...(opts.claudeCliPath ? { pathToClaudeCodeExecutable: opts.claudeCliPath } : {}),
  };

  if (session.hasStarted) {
    sdkOptions.resume = session.sdkSessionId;
    if (session.sdkSessionId === sessionId) {
      logger.debug(
        '[sendMessage] resuming with sdkSessionId === sessionId (expected after server restart)',
        {
          session: sessionId,
        }
      );
    }
  }

  // CWD resolution chain: opts.cwd (from caller) -> session.cwd (from creation) -> this.cwd (default)
  const cwdSource = messageOpts?.cwd ? 'opts.cwd' : opts.sessionCwd ? 'session.cwd' : 'default';
  logger.debug('[sendMessage]', {
    session: sessionId,
    permissionMode: session.permissionMode,
    hasStarted: session.hasStarted,
    resume: session.hasStarted ? session.sdkSessionId : 'N/A',
    effectiveCwd,
    cwdSource,
    'opts.cwd': messageOpts?.cwd || '(empty)',
    'session.cwd': opts.sessionCwd || '(empty)',
  });

  sdkOptions.permissionMode =
    session.permissionMode === 'bypassPermissions' ||
    session.permissionMode === 'plan' ||
    session.permissionMode === 'acceptEdits'
      ? session.permissionMode
      : 'default';
  if (session.permissionMode === 'bypassPermissions') {
    sdkOptions.allowDangerouslySkipPermissions = true;
  }

  if (session.model) {
    sdkOptions.model = session.model;
  }
  if (session.effort) {
    sdkOptions.effort = session.effort;
  }

  // Inject MCP tool servers -- create fresh instances per query to avoid
  // "Already connected to a transport" errors from reused Protocol objects.
  if (opts.mcpServerFactory) {
    sdkOptions.mcpServers = opts.mcpServerFactory(session);
  }

  // Apply per-agent MCP tool filtering (undefined = no filter = all tools available)
  const allowedTools = buildAllowedTools(toolConfig);
  if (allowedTools) {
    sdkOptions.allowedTools = [...(sdkOptions.allowedTools ?? []), ...allowedTools];
  }

  sdkOptions.canUseTool = createCanUseTool(session, logger.debug.bind(logger));

  const agentQuery = query({ prompt: makeUserPrompt(content), options: sdkOptions });
  session.activeQuery = agentQuery;

  // Non-blocking model fetch on first invocation
  if (opts.onModelsReceived) {
    agentQuery
      .supportedModels()
      .then((models) => {
        opts.onModelsReceived!(
          models.map((m) => ({
            value: m.value,
            displayName: m.displayName,
            description: m.description,
            supportsEffort: m.supportsEffort,
            supportedEffortLevels: m.supportedEffortLevels,
          }))
        );
      })
      .catch((err) => {
        logger.debug('[sendMessage] failed to fetch supported models', { err });
      });
  }

  // Non-blocking MCP status snapshot — fires every query, overwrites cache
  if (opts.onMcpStatusReceived) {
    agentQuery
      .mcpServerStatus()
      .then((statuses) => {
        opts.onMcpStatusReceived!(
          statuses
            .filter((s) => s.name !== 'dorkos')
            .map((s) => ({
              name: s.name,
              type:
                s.config?.type === 'sse' || s.config?.type === 'http'
                  ? s.config.type
                  : ('stdio' as const),
              status: s.status,
              error: s.error,
              scope: s.scope,
            }))
        );
      })
      .catch((err) => {
        logger.debug('[sendMessage] failed to fetch MCP server status', { err });
      });
  }

  // Non-blocking command discovery — fires on first query, caches on runtime
  if (opts.onCommandsReceived) {
    agentQuery
      .supportedCommands()
      .then((commands) => {
        opts.onCommandsReceived!(
          commands.map((c) => ({
            name: c.name,
            description: c.description,
            argumentHint: c.argumentHint,
          }))
        );
      })
      .catch((err) => {
        logger.debug('[sendMessage] failed to fetch supported commands', { err });
      });
  }

  logger.info('[sendMessage] stream start', {
    session: sessionId,
    hasStarted: session.hasStarted,
    effectiveCwd,
  });

  let emittedDone = false;
  let emittedError = false;
  let eventCount = 0;
  let contentEventCount = 0;
  let wasInteractive = false;
  const streamStart = Date.now();
  const toolState = createToolState();

  try {
    const sdkIterator = agentQuery[Symbol.asyncIterator]();
    let pendingSdkPromise: Promise<{
      sdk: true;
      result: IteratorResult<SDKMessage>;
    }> | null = null;

    while (true) {
      while (session.eventQueue.length > 0) {
        const queuedEvent = session.eventQueue.shift()!;
        if (queuedEvent.type === 'done') emittedDone = true;
        eventCount++;
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
          if (opts.meshCore && meshAgentId) {
            opts.meshCore.updateLastSeen(meshAgentId, 'response_complete');
          }
        }
        // Track content events for empty-stream detection
        if (
          ['text_delta', 'tool_call_start', 'tool_result', 'thinking_delta'].includes(event.type)
        ) {
          contentEventCount++;
        }
        if (['approval_required', 'question_prompt'].includes(event.type)) {
          wasInteractive = true;
        }
        eventCount++;
        yield event;
      }
      // Update reverse index if sdk-event-mapper assigned a new SDK session ID
      if (session.sdkSessionId !== prevSdkId) {
        opts.sdkSessionIndex.delete(prevSdkId);
        opts.sdkSessionIndex.set(session.sdkSessionId, opts.sessionMapKey);
      }
    }

    // Fetch context usage breakdown after stream completes (before finally clears activeQuery)
    if (session.activeQuery) {
      try {
        const usage = await session.activeQuery.getContextUsage();
        yield {
          type: 'context_usage',
          data: {
            totalTokens: usage.totalTokens,
            maxTokens: usage.maxTokens,
            percentage: usage.percentage,
            model: usage.model,
            categories: usage.categories.map((c) => ({
              name: c.name,
              tokens: c.tokens,
              color: c.color,
            })),
          },
        };
      } catch (err) {
        logger.debug('[sendMessage] failed to fetch context usage', { err });
      }
    }
  } catch (err) {
    if (session.hasStarted && isResumeFailure(err) && retryDepth < MAX_RESUME_RETRIES) {
      logger.warn('[sendMessage] resume failed for stale session, retrying as new', {
        session: sessionId,
        retryDepth,
        error: err instanceof Error ? err.message : String(err),
      });
      session.hasStarted = false;
      yield* executeSdkQuery(sessionId, content, session, opts, messageOpts, retryDepth + 1);
      return;
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn('[sendMessage] stream error', {
      session: sessionId,
      error: errMsg,
      durationMs: Date.now() - streamStart,
      eventCount,
      contentEventCount,
      retryDepth,
    });
    yield {
      type: 'error',
      data: {
        message:
          'The agent stopped unexpectedly. The service may be temporarily overloaded — try again in a moment.',
        category: 'execution_error' as ErrorCategory,
        details: errMsg,
      },
    };
    emittedError = true;
  } finally {
    // Preserve the query reference for post-stream control methods (e.g. reloadPlugins)
    session.lastQuery = session.activeQuery;
    session.activeQuery = undefined;
  }

  // Detect empty streams — zero content events with no prior error
  if (contentEventCount === 0 && !emittedError && !wasInteractive) {
    logger.warn('[sendMessage] stream completed with zero content events', {
      session: sessionId,
      eventCount,
      durationMs: Date.now() - streamStart,
    });
    yield {
      type: 'error',
      data: {
        message: 'The agent did not respond. The service may be temporarily unavailable.',
        category: 'execution_error' as ErrorCategory,
      },
    };
    emittedError = true;
  }

  logger.info('[sendMessage] stream done', {
    session: sessionId,
    durationMs: Date.now() - streamStart,
    eventCount,
    contentEventCount,
  });

  if (!emittedDone) {
    yield {
      type: 'done',
      data: { sessionId },
    };
  }
}
