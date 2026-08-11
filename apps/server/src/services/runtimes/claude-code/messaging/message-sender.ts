/**
 * SDK query execution -- extracted from ClaudeCodeRuntime.sendMessage()
 * for file size management.
 *
 * Contains the core messaging pipeline: boundary validation, agent manifest loading,
 * tool-group resolution, system prompt building, SDK option configuration, and event
 * streaming.
 *
 * @module services/runtimes/claude-code/message-sender
 */
import {
  query,
  type Options,
  type SDKMessage,
  type McpServerConfig,
  type McpServerStatus,
} from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent, ErrorCategory, EffortLevel } from '@dorkos/shared/types';
import type {
  MessageOpts,
  AgentRegistryPort,
  McpAppServerConnection,
} from '@dorkos/shared/agent-runtime';
import type { McpServerEntry } from '@dorkos/shared/transport';
import type { AgentSession } from '../agent-types.js';
import { createToolState } from '../agent-types.js';
import { createCanUseTool, handleElicitation } from './interactive-handlers.js';
import {
  detectPhantomCancellations,
  buildPhantomCorrectionNote,
  PHANTOM_CORRECTIONS_MAX_PER_TURN,
} from './phantom-cancellation.js';
import { mapSdkMessage } from '../sdk/sdk-event-mapper.js';
import { createTurnSegments, DEFERRED_CLOSE_TIMEOUT_MS } from './turn-segments.js';
import { createHeldUserPrompt } from '../sdk/sdk-utils.js';
import { fetchContextBreakdown } from '../sdk/context-usage.js';
import { fetchSubscriptionUsage } from '../sdk/subscription-usage.js';
import { buildSystemPromptAppend, renderContextEntry } from './context-builder.js';
import { resolveThinkingOptions, type ModelThinkingCapability } from './thinking-config.js';
import { resolveEffectivePermissionMode, AUTO_DOWNGRADE_STATUS } from './permission-mode-guard.js';
import type { ClaudeAgentSdkPlugin } from './plugin-activation.js';
import type { BindingRouter } from '../../../relay/binding-router.js';
import type { BindingStore } from '../../../relay/binding-store.js';
import type { AdapterManager } from '../../../relay/adapter-manager.js';
import { resolveToolConfig } from '../tooling/tool-filter.js';
// A turn runs in the session's working directory, which for the system agent
// (DorkBot) and marketplace agents is {dorkHome}/agents/* — legitimately outside
// a narrow DORKOS_BOUNDARY. The turn must be able to run there (the onboarding
// first message), so this session-turn surface uses the agents-subtree seam;
// dork-home siblings (credential store) and boundary-external paths stay denied.
import { validateBoundaryOrDorkHome } from '../../../../lib/boundary.js';
import { logger } from '../../../../lib/logger.js';
import path from 'node:path';
import { isEditFamilyTool, editToolFilePath } from '@dorkos/shared/diff-tools';
import { editBaselineStore } from '../../../diff/index.js';
import { readManifest } from '@dorkos/shared/manifest';
import { isRelayEnabled } from '../../../relay/relay-state.js';
import { isTasksEnabled } from '../../../tasks/task-state.js';
import { configManager } from '../../../core/config-manager.js';
import { claudeConfigDirEnv, resolveActiveClaudeRoot } from '../claude-config-dir.js';
import { mcpToolTimeoutFloorEnv } from './mcp-tool-timeout-env.js';
import { resolveClaudeCredentialEnv } from '../../../core/credential-env.js';
import { resolveAgentTokenEnv } from '../../../core/agent-identity/index.js';
import { detectAuthError } from '@dorkos/shared/runtime-error-classification';

/** Lightweight projection of the SDK's SlashCommand type — avoids leaking SDK types. */
export interface SdkCommandEntry {
  name: string;
  description: string;
  argumentHint: string;
  /**
   * Alternate names that resolve to this command (SDK `SlashCommand.aliases`,
   * e.g. `/cost` and `/stats` both resolve to `/usage`). Propagated to
   * `CommandEntry` so the palette can fuzzy-match aliases (DOR-108).
   */
  aliases?: string[];
}

/**
 * Matches content shaped like a slash-command invocation: `/name` or `/ns:name`
 * at the very start, followed by whitespace or end-of-input. Multi-segment paths
 * (`/etc/hosts`) intentionally fail the lookahead and are treated as plain text.
 */
const SLASH_COMMAND_RE = /^\/([A-Za-z0-9][\w.-]*(?::[\w.-]+)*)(?=\s|$)/;

/**
 * Extract the slash-command name (without the leading `/`) from message content,
 * or null when the content is not shaped like a command invocation.
 *
 * @param content - Raw user message text.
 */
export function detectSlashCommandName(content: string): string | null {
  const match = SLASH_COMMAND_RE.exec(content.trimStart());
  return match ? match[1] : null;
}

/**
 * Build the pre-tool preflight that snapshots a file's pre-edit bytes for the
 * diff base (DOR-212). Wired at BOTH pre-tool seams so it fires before the SDK
 * applies an edit-family tool in every mode:
 *
 * - the SDK `PreToolUse` hook — fires for every tool use INCLUDING under
 *   `bypassPermissions` (which skips `canUseTool` entirely) and for subagent
 *   (Task) tool use;
 * - the `canUseTool` gate — belt-and-suspenders for the interactive modes.
 *
 * First-touch-wins makes the double capture harmless (the second call is a
 * no-op); a capture failure never blocks the tool. If the direct disk snapshot
 * can't be taken (a transient read error), it falls back to reconstructing the
 * pre-image from the tool input (§Q1 Fallback A).
 *
 * @internal Exported for testing only.
 * @param sessionId - The DorkOS session the edit belongs to.
 * @param cwd - The session's working directory (for resolving relative paths).
 */
export function createEditBaselineCapture(
  sessionId: string,
  cwd: string
): (toolName: string, input: Record<string, unknown>) => Promise<void> {
  return async (toolName, input) => {
    if (!isEditFamilyTool(toolName)) return;
    const filePath = editToolFilePath(input);
    if (!filePath) return;
    const abs = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
    try {
      const captured = await editBaselineStore.captureFromDisk(sessionId, abs);
      if (!captured) {
        await editBaselineStore.captureFromToolInput(sessionId, abs, toolName, input);
      }
    } catch (err) {
      logger.debug('[sendMessage] diff baseline capture failed', { session: sessionId, err });
    }
  };
}

/**
 * A model entry as the SDK reports it from `supportedModels()`.
 *
 * This shape is the narrow waist between the SDK and the model cache: every
 * capability field `mapSdkModelToModelOption` persists must be carried here,
 * because a field dropped at this seam is a capability silently lost
 * everywhere downstream. That is not hypothetical — a five-field pick at the
 * `supportedModels()` call site dropped `supportsAdaptiveThinking`, so
 * `resolveThinkingOptions` never engaged summarized thinking display and
 * every Opus 4.8 session streamed empty thinking blocks (alongside starved
 * `supportsAutoMode`/`supportsFastMode`). Pass the SDK's objects through
 * whole; never re-pick them.
 */
export interface SdkReportedModel {
  value: string;
  /**
   * The canonical wire id this row's `value` resolves to — `sonnet` →
   * `claude-sonnet-5` (SDK 0.3.224, `ModelInfo.resolvedModel`). Absent on rows
   * that are already a wire id, and on older SDKs. It is what lets a session
   * that persisted an explicit wire id find the alias row carrying that model's
   * capabilities; see {@link RuntimeCache.getCachedModel}.
   */
  resolvedModel?: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: EffortLevel[];
  supportsAdaptiveThinking?: boolean;
  supportsFastMode?: boolean;
  supportsAutoMode?: boolean;
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
  mcpServerFactory?:
    | ((session: AgentSession, sessionId: string) => Record<string, McpServerConfig>)
    | null;
  onModelsReceived?: (models: SdkReportedModel[]) => void;
  onMcpStatusReceived?: (servers: McpServerEntry[]) => void;
  /**
   * Server-only companion to {@link onMcpStatusReceived}: the resolved
   * connection config (stdio command/env or http/sse url) for each MCP server,
   * captured so the DorkOS server can open its own short-lived client to read
   * MCP App `ui://` resources (ADR `260708-141143`). Never mapped into the
   * client-facing `McpServerEntry`. Servers whose transport cannot be
   * independently reconnected (e.g. claude.ai proxy) are omitted.
   */
  onMcpServerConfigsReceived?: (
    configs: Array<{ name: string; connection: McpAppServerConnection }>
  ) => void;
  onCommandsReceived?: (commands: SdkCommandEntry[]) => void;
  /**
   * Replace the cached command list when the SDK pushes a mid-session
   * `commands_changed` message (e.g. after a plugin reload). Unlike
   * `onCommandsReceived` (first-population only), this fires every time and
   * REPLACES the cache wholesale, per SDK guidance (DOR-108).
   */
  onCommandsChanged?: (commands: SdkCommandEntry[]) => void;
  onSubagentsReceived?: (
    agents: Array<{ name: string; description: string; model?: string }>
  ) => void;
  /**
   * Report that the SDK bound this session to a NEW canonical id mid-turn. The
   * session store owns every lookup keyed by that id (its reverse index and the
   * durable settings row), so the sender only announces the change.
   *
   * Awaited BEFORE the event that carries the new id out of the server, which is
   * the ordering the whole thing rests on: `trigger-turn` re-keys the projector
   * on any event it sees, and that announcement is how the cockpit learns the id
   * it will POST its next message under. Handing that id out before the row has
   * moved is what made the session's own next message look like a brand-new one
   * (DOR-493, DOR-838). A failure inside is warned and swallowed by the store,
   * so this await cannot fail the turn.
   */
  onSdkSessionRebind: (previousSdkSessionId: string, nextSdkSessionId: string) => Promise<void>;
  /**
   * Thinking capability of the session's selected model, resolved from the model
   * cache at send time. Drives whether we attach an adaptive `thinking` config (see
   * `resolveThinkingOptions`). Undefined when the model is unset or not yet cached —
   * treated as "unknown", falling back to SDK defaults.
   */
  modelThinkingCapability?: ModelThinkingCapability;
  /**
   * Whether the session's selected model supports auto permission mode. `true`/`false`
   * when the model is known, `undefined` when unknown (cold cache / unrecognized model).
   * Drives the auto→default coercion guard (see `resolveEffectivePermissionMode`).
   */
  modelSupportsAutoMode?: boolean;
  /**
   * Pre-resolved marketplace plugin entries for the Claude Agent SDK
   * `options.plugins` field (marketplace-05, ADR-0239). Populated by the
   * runtime before calling `executeSdkQuery` so this module never touches
   * the filesystem itself — the indirection keeps message-sender's test
   * mocks simple and preserves fake-timer semantics.
   */
  plugins?: ClaudeAgentSdkPlugin[];
  /**
   * Resolve the known slash commands for this session's project (merged SDK +
   * filesystem registry, as `/name` strings). Returns `null` when the SDK
   * command cache is cold (no query has run for this cwd yet) — built-ins are
   * unknowable then, so command-shaped content is passed through unverified
   * and the CLI handles unknown names itself. Called lazily, only when the
   * message is shaped like a command (DOR-107).
   */
  getKnownCommands?: () => Promise<string[] | null>;
}

const RESUME_FAILURE_PATTERNS = [
  'query closed before response',
  'session not found',
  'no such file',
  'enoent',
];

/**
 * Max transparent retries before surfacing the error. A single budget shared by
 * BOTH resume-recovery paths — stale-session-as-new ({@link isResumeFailure})
 * and anchor-not-found ({@link isAnchorNotFound}) — so a turn that spends it on
 * an anchor retry gets no second retry for a stale-session failure that follows.
 */
const MAX_RESUME_RETRIES = 1;

/** Max time to wait for the post-turn `getContextUsage()` control response. */
const CONTEXT_USAGE_TIMEOUT_MS = 8_000;

/** Detect whether an error indicates a failed SDK session resume. */
function isResumeFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return RESUME_FAILURE_PATTERNS.some((p) => msg.includes(p));
}

/**
 * Detect the CLI's hard failure when a `resumeSessionAt` anchor uuid is not in
 * the (possibly compacted or externally rewritten) transcript — it throws
 * `No message found with message.uuid of: <uuid>`. Distinct from
 * {@link isResumeFailure}: recovery drops the anchor and resumes plainly,
 * preserving history, rather than restarting as a brand-new session.
 */
function isAnchorNotFound(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /no message found with message\.uuid/i.test(err.message);
}

/**
 * Map a resolved SDK MCP server config to the runtime-neutral connection the
 * DorkOS server uses to read MCP App `ui://` resources (ADR 260708-141143).
 * Returns null when config is absent or the transport cannot be independently
 * reconnected (claude.ai proxy).
 *
 * @param config - The `config` field from an SDK `McpServerStatus`.
 * @internal Exported for testing only.
 */
export function toMcpAppConnection(
  config: McpServerStatus['config']
): McpAppServerConnection | null {
  if (!config) return null;
  // stdio is the default when `type` is omitted (McpStdioServerConfig).
  if ((config.type ?? 'stdio') === 'stdio' && 'command' in config) {
    return { transport: 'stdio', command: config.command, args: config.args, env: config.env };
  }
  if (config.type === 'http' && 'url' in config) {
    return { transport: 'http', url: config.url, headers: config.headers };
  }
  if (config.type === 'sse' && 'url' in config) {
    return { transport: 'sse', url: config.url, headers: config.headers };
  }
  return null;
}

/**
 * The typed error surfaced when a turn produced zero content events: the SDK
 * stream ran but the agent never said or did anything visible.
 */
function emptyStreamError(): StreamEvent {
  return {
    type: 'error',
    data: {
      message: 'The agent did not respond. The service may be temporarily unavailable.',
      category: 'execution_error' as ErrorCategory,
    },
  };
}

/**
 * Execute an SDK query and yield StreamEvent objects.
 *
 * This is the core messaging pipeline: validates boundary, loads agent manifest,
 * resolves tool groups, builds system prompt context, configures SDK options,
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
  // Clear last turn's breakdown so a failed fetch this turn never shows stale data.
  session.contextBreakdown = undefined;
  // A stop stamped in a PREVIOUS turn must not blind this turn's phantom
  // detector (DOR-1087) — the suppression window is scoped to the turn the
  // operator actually interrupted.
  session.interruptRequestedAt = undefined;

  // Use messageOpts.cwd if explicitly provided (e.g., CCA passes Mesh context dir),
  // fall through empty strings from stale bindings, then fall back to default.
  const effectiveCwd = messageOpts?.cwd || opts.sessionCwd || opts.cwd;
  try {
    await validateBoundaryOrDorkHome(effectiveCwd);
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

  // Load agent manifest for the agent's per-agent tool-group settings. These decide
  // which tool docs reach the system prompt; they never restrict what is callable.
  let manifest: Awaited<ReturnType<typeof readManifest>> | null = null;
  try {
    manifest = await readManifest(effectiveCwd);
  } catch {
    // No manifest found -- all tools inherit global defaults
  }

  const globalConfig = configManager.get('agentContext') ?? {
    tasksTools: true,
    relayTools: true,
    meshTools: true,
    adapterTools: true,
  };

  const toolConfig = resolveToolConfig(manifest?.enabledToolGroups, {
    relayEnabled: isRelayEnabled(),
    tasksEnabled: isTasksEnabled(),
    globalConfig,
  });

  // Slash commands must reach the CLI as the bare prompt — it only parses a
  // command when `/` starts the message (DOR-107). Verify the name against the
  // known command list; a cold SDK cache (null) can't rule out built-ins, so
  // command-shaped content passes through and the CLI rejects unknown names.
  const commandName = detectSlashCommandName(content);
  let isCommandDispatch = false;
  if (commandName && opts.getKnownCommands) {
    const knownCommands = await opts.getKnownCommands();
    isCommandDispatch = knownCommands === null || knownCommands.includes(`/${commandName}`);
  }

  const baseAppend = await buildSystemPromptAppend(effectiveCwd, toolConfig);
  // Concatenate caller-supplied append (e.g. Tasks scheduler context) after the base
  const systemPromptAppend = messageOpts?.systemPromptAppend
    ? `${baseAppend}\n\n${messageOpts.systemPromptAppend}`
    : baseAppend;

  // Prepend the server-assembled additional-context bag (git status, UI state,
  // queue note, …) to the user message — keeps it out of the system prompt to
  // preserve prompt cache hits on the static prefix. The user's `content` is
  // NEVER mutated: the prepend produces a separate `enrichedContent` and the
  // tags are stripped on render (ADR-0273).
  let enrichedContent = content;
  if (isCommandDispatch) {
    // DOR-107: a `/`-prefixed prompt must reach the CLI bare (leading whitespace
    // also breaks command parsing). NO context prepend on command turns. Retained.
    enrichedContent = content.trim();
  } else {
    const contextBlocks = (messageOpts?.additionalContext ?? [])
      .map(renderContextEntry)
      .filter(Boolean);
    if (contextBlocks.length > 0) {
      enrichedContent = `${contextBlocks.join('\n\n')}\n\n${content}`;
    }
  }

  // Resolve a stored Claude credential REFERENCE into ANTHROPIC_API_KEY at the
  // env seam (ADR-0315). Injected below ONLY when configured; a missing or
  // dangling reference yields `{}`, leaving host/delegated-login auth untouched.
  const claudeCredentialEnv = await resolveClaudeCredentialEnv();

  // Mint this session's agent identity token (spec `agent-trust` §3.1). It
  // rides the process env — NOT the context-builder's prompt block — so it
  // stays a credential for the tools the agent runs (`dorkos call ...`) rather
  // than text in the model's context and the transcript. Yields `{}` when the
  // working directory hosts no registered agent, leaving the session
  // unattributed exactly as before.
  const agentTokenEnv = await resolveAgentTokenEnv(
    meshAgent ? effectiveCwd : undefined,
    meshAgent?.name
  );

  // Which Claude Code account this turn runs and BILLS on (spec
  // `claude-code-accounts` D3): the session's own account when disk has already
  // told us one — a resumed conversation must stay on the client whose
  // subscription paid for it, whichever account happens to be active — else the
  // active account, which is what a brand-new session runs on.
  //
  // `undefined` is "unknown", never an error: a session with no transcript yet
  // legitimately has no account of its own.
  const accountEnv = claudeConfigDirEnv(session.accountRoot ?? resolveActiveClaudeRoot());

  const sdkOptions: Options = {
    cwd: effectiveCwd,
    includePartialMessages: true,
    promptSuggestions: true,
    agentProgressSummaries: true,
    // Stream subagent text deltas (tagged with parent_tool_use_id) so the operator
    // can watch what a subagent is doing, not just a progress spinner. Mapped to
    // `subagent_text_delta` events in sdk-event-mapper.ts (SDK 0.2.119+).
    forwardSubagentText: true,
    settingSources: ['local', 'project', 'user'],
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: systemPromptAppend,
      // Suppress the preset's native working-directory/auto-memory/git sections so
      // DorkOS's own server-derived <git_status> block is the single source of truth.
      // Ends the per-turn double-injection of git status (ADR-0273 decision A2).
      excludeDynamicSections: true,
    },
    toolConfig: {
      askUserQuestion: { previewFormat: 'html' },
    },
    env: {
      // eslint-disable-next-line no-restricted-syntax -- full env needed for SDK subprocess inheritance
      ...process.env,
      CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
      // An inherited MCP_TOOL_TIMEOUT shorter than the in-session approval hold
      // would kill every held destructive call mid-wait, with an ERROR where the
      // poll payload used to be. Floored, never erased — see the module TSDoc for
      // the tradeoff (DOR-987).
      ...mcpToolTimeoutFloorEnv(),
      // The account, ALWAYS spelled out (see `claudeConfigDirEnv`) so it is never
      // inherited from `process.env`. That is load-bearing for D8: rename and
      // fork point the in-process SDK at an account by mutating
      // `process.env.CLAUDE_CONFIG_DIR` process-globally for the duration of the
      // call (`claude-config-env-lock.ts`), and a query spawning inside that
      // window must not pick the transient value up. The two changes are safe
      // only together — do not separate them.
      ...accountEnv,
      // Resolved credential (if any) wins over an inherited ANTHROPIC_API_KEY.
      ...claudeCredentialEnv,
      // This session's freshly minted agent identity token (or nothing).
      ...agentTokenEnv,
    },
    ...(opts.claudeCliPath ? { pathToClaudeCodeExecutable: opts.claudeCliPath } : {}),
  };

  // Set the session title on the first turn when the caller supplies one
  // (SDK 0.2.113 `title` option — skips auto-generation). Ignored on resume.
  if (!session.hasStarted && messageOpts?.title) {
    sdkOptions.title = messageOpts.title;
  }

  if (session.hasStarted) {
    sdkOptions.resume = session.sdkSessionId;
    // Anchor the resume at the last main-thread assistant message this session
    // produced. Without this, the claude CLI's resume classifier treats a
    // trailing bookkeeping attachment — a Stop-hook `hook_success` entry, a
    // skill/agent listing — as an `interrupted_turn` and injects a synthetic
    // "Continue from where you left off." prompt (`getResumePrompt()`), which the
    // model answers "No response requested." BEFORE our real message runs, so the
    // operator sees a junk turn between every interaction (DOR phantom-continue).
    // Truncating the resume to the last assistant excludes those trailing
    // attachments, so the classifier settles the turn cleanly and our message is
    // the next turn's sole prompt. The anchor is undefined on a cold resume or a
    // no-assistant turn — a plain resume, unchanged behavior. `resumeSessionAt`
    // never rewrites the transcript file, so nothing is lost: only what THIS
    // resume loads is truncated (the excluded attachments stay on disk).
    if (session.lastAssistantUuid) {
      sdkOptions.resumeSessionAt = session.lastAssistantUuid;
    }
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

  // Reconcile the permission mode against the active model: `'auto'` only works on
  // models KNOWN to support it, so coerce it to `'default'` here (the runtime is the
  // authoritative chokepoint) rather than letting the SDK 400. This is a per-query
  // coercion only — we deliberately do NOT mutate `session.permissionMode`, so the
  // operator's Auto choice isn't silently destroyed: the displayed mode stays honest,
  // the status note fires each send the model can't be trusted with Auto, and Auto
  // resumes automatically once it can be. The note's wording follows the REASON —
  // an unconfirmed model must not be described as one that lacks Auto.
  const { permissionMode: effectivePermissionMode, autoDowngrade } = resolveEffectivePermissionMode(
    {
      permissionMode: session.permissionMode,
      modelSupportsAutoMode: opts.modelSupportsAutoMode,
    }
  );
  if (autoDowngrade) {
    yield {
      type: 'system_status',
      data: { message: AUTO_DOWNGRADE_STATUS[autoDowngrade] },
    };
  }
  // The schema validates valid values upstream; no allowlist needed here.
  sdkOptions.permissionMode = effectivePermissionMode;
  // Always launch with the bypass capability (ADR-0261). The flag is a pure
  // capability gate the SDK consults ONLY when permissionMode is
  // 'bypassPermissions' — verified inert in default/acceptEdits/plan, which
  // still route to canUseTool. Granting it unconditionally lets the operator
  // switch a live session to bypass instantly (query.setPermissionMode),
  // instead of the SDK rejecting the escalation because the session wasn't
  // launched with it.
  sdkOptions.allowDangerouslySkipPermissions = true;

  if (session.model) {
    sdkOptions.model = session.model;
  }
  // Resolve thinking + effort together: adaptive-capable models (Opus 4.8/4.7 default
  // their thinking to omitted) get `display: 'summarized'` so thinking text streams;
  // non-adaptive models are left untouched. Also normalizes DorkOS-only effort values
  // (`none`/`minimal`) that the SDK does not accept.
  const { thinking, effort } = resolveThinkingOptions({
    effort: session.effort,
    capability: opts.modelThinkingCapability,
  });
  if (thinking) {
    sdkOptions.thinking = thinking;
  }
  if (effort) {
    sdkOptions.effort = effort;
  }
  // Pass fastMode via SDK settings (not top-level options).
  // The SDK uses Settings.fastMode.
  if (session.fastMode) {
    const base = typeof sdkOptions.settings === 'object' ? sdkOptions.settings : {};
    sdkOptions.settings = {
      ...base,
      fastMode: true,
    };
  }

  // Inject MCP tool servers -- create fresh instances per query to avoid
  // "Already connected to a transport" errors from reused Protocol objects.
  if (opts.mcpServerFactory) {
    sdkOptions.mcpServers = opts.mcpServerFactory(session, sessionId);
  }

  // Nothing here sets `allowedTools`, on purpose (DOR-519). The tool-group toggles
  // used to feed it a list, on the premise that the SDK option restricts which tools
  // a session may call. It does not: it auto-approves the names in it. Because the
  // list was only non-empty once a group was turned OFF, turning a group off widened
  // this agent's auto-approval instead of narrowing its access. Every DorkOS tool now
  // goes through `canUseTool` below, which auto-approves only `DORKOS_AGENT_TOOLS`.
  // The toggles still take effect through `buildSystemPromptAppend` above, which
  // leaves a disabled group's tool block out of the agent's context.
  const editBaselineCapture = createEditBaselineCapture(sessionId, effectiveCwd);
  sdkOptions.canUseTool = createCanUseTool(session, logger, editBaselineCapture);
  // Pre-edit baseline capture must ALSO ride the SDK PreToolUse hook (DOR-212):
  // `canUseTool` is skipped entirely under `bypassPermissions`, but PreToolUse
  // hooks fire in every mode, before the tool runs. The matcher confines the
  // callback to the edit-family tools; the callback itself never blocks or
  // modifies the tool (`continue: true`). First-touch-wins in the store makes
  // the canUseTool+hook double-fire a no-op.
  //
  // This used to also claim `canUseTool` does not see subagent (Task) tool use.
  // That is not true at SDK 0.3.177 and the claim caused a real misdiagnosis
  // (DOR-782): a foreground `Task` subagent's tool calls are routed to the SAME
  // `can_use_tool` callback, tagged with `agentID` (`sdk.d.ts` `CanUseTool`), so
  // they raise a normal approval card. That is pinned by a test in
  // interactive-handlers.test.ts.
  //
  // Whether BACKGROUNDED (async) subagents also arrive here is UNRESOLVED and is
  // not asserted either way (DOR-795) — the reasoning lives in the native CLI
  // binary rather than the shipped JS. Replacing one confident unverified claim
  // with another is how the first one survived this long.
  //
  // 2026-08-07, on the 0.3.177 → 0.3.224 bump: upstream now has an ANSWER-SHAPED
  // change, but not yet an answer we have earned. The 0.3.186 release note says
  // background agents route permission prompts to the host's `canUseTool` instead
  // of auto-denying them. Against that, a static read of the 0.3.224 binary shows
  // the `shouldAvoidPermissionPrompts` gate and its `{type:'asyncAgent'}` deny
  // still present — so the deny path was NOT removed wholesale, and what changed
  // is presumably WHEN that flag gets set. Which of the two governs a DorkOS
  // background subagent has not been observed live, so this stays unresolved on
  // purpose. Either way the backstop holds: `interactive-handlers.ts` auto-denies
  // on abort and on timeout, so a prompt that arrives outside a foreground turn
  // degrades gracefully rather than hanging one.
  sdkOptions.hooks = {
    PreToolUse: [
      {
        matcher: 'Edit|Write|MultiEdit|NotebookEdit',
        hooks: [
          async (hookInput) => {
            if (hookInput.hook_event_name === 'PreToolUse') {
              await editBaselineCapture(
                hookInput.tool_name,
                (hookInput.tool_input ?? {}) as Record<string, unknown>
              );
            }
            return { continue: true };
          },
        ],
      },
    ],
  };
  sdkOptions.onElicitation = (request, { signal }) => {
    logger.debug('[sendMessage] elicitation request', {
      session: sessionId,
      serverName: request.serverName,
      mode: request.mode,
    });
    return handleElicitation(session, request, signal);
  };

  // Activate installed marketplace plugins (marketplace-05, ADR-0239).
  // The runtime pre-resolves the plugin list via `opts.plugins`; this module
  // does not touch the filesystem itself so fake-timer tests stay simple.
  if (opts.plugins && opts.plugins.length > 0) {
    (sdkOptions as Options & { plugins?: unknown }).plugins = opts.plugins;
    logger.debug('[sendMessage] activated marketplace plugins', {
      session: sessionId,
      count: opts.plugins.length,
    });
  }

  // Hold the input stream open so the subprocess survives past the result message
  // and can answer getContextUsage() (closed below once the turn completes).
  const heldPrompt = createHeldUserPrompt(enrichedContent);
  const agentQuery = query({ prompt: heldPrompt.prompt, options: sdkOptions });
  session.activeQuery = agentQuery;

  // Non-blocking model fetch on first invocation
  if (opts.onModelsReceived) {
    agentQuery
      .supportedModels()
      // Whole objects, never a field pick — see the SdkReportedModel doc for
      // the capability-starvation incident a pick here caused.
      .then((models) => {
        opts.onModelsReceived!(models);
      })
      .catch((err) => {
        logger.debug('[sendMessage] failed to fetch supported models', { err });
      });
  }

  // Non-blocking MCP status snapshot — fires every query, overwrites cache
  if (opts.onMcpStatusReceived || opts.onMcpServerConfigsReceived) {
    agentQuery
      .mcpServerStatus()
      .then((statuses) => {
        const external = statuses.filter((s) => s.name !== 'dorkos');
        opts.onMcpStatusReceived?.(
          external.map((s) => ({
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
        // Capture resolved connection config server-side for MCP App resource
        // reads (ADR 260708-141143). Kept separate from the client-facing entry.
        if (opts.onMcpServerConfigsReceived) {
          const captured: Array<{ name: string; connection: McpAppServerConnection }> = [];
          for (const s of external) {
            const connection = toMcpAppConnection(s.config);
            if (connection) captured.push({ name: s.name, connection });
          }
          opts.onMcpServerConfigsReceived(captured);
        }
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
            aliases: c.aliases,
          }))
        );
      })
      .catch((err) => {
        logger.debug('[sendMessage] failed to fetch supported commands', { err });
      });
  }

  // Non-blocking subagent discovery — fires on first query, caches on runtime
  if (opts.onSubagentsReceived) {
    agentQuery
      .supportedAgents?.()
      ?.then((agents) => {
        opts.onSubagentsReceived!(
          agents.map((a) => ({
            name: a.name,
            description: a.description,
            model: a.model,
          }))
        );
      })
      .catch((err) => {
        logger.debug('[sendMessage] failed to fetch supported agents', { err });
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
  // Anchor for the NEXT turn's resume: the last main-thread assistant uuid seen
  // this turn (undefined until one arrives). Committed to the session in the
  // `finally`, unless a recursion retry already set the authoritative value.
  let lastMainAssistantUuid: string | undefined;
  let retriedViaRecursion = false;
  // Corrective notes steered into this turn after phantom cancellations
  // (DOR-1087) — capped so the correction can never feed itself. There is no
  // separate post-`result` gate: the held prompt being OPEN is the whole
  // condition, because a turn with background tasks outstanding continues past
  // its first `result` (see `turn-segments.ts`) and a note pushed then lands in
  // the segment that is still running. Once the stream is closed for good,
  // `push()` refuses on its own (DOR-1149).
  // Separate budgets, because they compete for different reasons (DOR-1150).
  // Subagent phantoms arrive in bursts — one misbehaving helper produced four in
  // the 2026-08-11 session — and a shared pool let them spend every note before
  // the coordinator's OWN cancellation, the one where the recipient is the
  // victim, ever got a correction.
  let mainThreadCorrections = 0;
  let subagentCorrections = 0;
  const segments = createTurnSegments();
  /**
   * Deadline promise for a held-back stdin close, armed at the deferring
   * `result` and cleared the moment the close actually happens.
   */
  let deferredCloseDeadline: Promise<'expired'> | undefined;
  let deferredCloseTimer: NodeJS.Timeout | undefined;
  /** Drop an armed deadline — the close it guarded is happening now. */
  const releaseDeferredClose = (): void => {
    if (deferredCloseTimer) clearTimeout(deferredCloseTimer);
    deferredCloseTimer = undefined;
    deferredCloseDeadline = undefined;
  };
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

      // A deferred close must not be able to wedge the turn: while it is held,
      // the CLI waits on stdin and we wait on the CLI, so neither the deferral
      // cap nor the `finally` is ever reached. The deadline is armed ONCE per
      // deferral (see `DEFERRED_CLOSE_TIMEOUT_MS`) rather than re-armed each
      // iteration, so a chatty stream cannot push it back for ever (DOR-1149).
      const winner = await Promise.race(
        deferredCloseDeadline
          ? [queuePromise, pendingSdkPromise, deferredCloseDeadline]
          : [queuePromise, pendingSdkPromise]
      );

      if (winner === 'expired') {
        logger.warn('[sendMessage] deferred close expired; releasing input stream', {
          session: sessionId,
          owedNotifications: segments.owedCount(),
        });
        releaseDeferredClose();
        heldPrompt.close();
        continue;
      }

      if (winner === 'queue') {
        continue;
      }

      pendingSdkPromise = null;
      const { result } = winner;
      if (result.done) break;

      // Track the last MAIN-THREAD assistant message uuid so the NEXT turn can
      // anchor its resume at it (see the `resumeSessionAt` note above). Subagent
      // assistant messages carry a `parent_tool_use_id` and live in a separate
      // transcript, so they must never become the main-session anchor.
      if (result.value.type === 'assistant' && result.value.parent_tool_use_id === null) {
        lastMainAssistantUuid = result.value.uuid;
      }

      // Background-task lifecycle drives BOTH decisions below: whether a
      // `result` ends the turn or only a segment of it, and therefore whether a
      // corrective note still has a live channel (DOR-1149).
      segments.observe(result.value);

      // Phantom cancellation (DOR-1087): the CLI cancelled pending tool calls
      // because a task-notification was queued, writing a sentinel that reads
      // as a user refusal. Tell the model it wasn't the user, and surface a
      // status line for the operator. The notice event carries NO `status`
      // field (the client strip drops any system_status that has one) and is
      // yielded AFTER this message's mapped events below — yielded here, the
      // same message's tool_result events would re-derive the strip and wipe it
      // in the same frame.
      //
      // A SUBAGENT phantom is steered too (DOR-1150). The note cannot reach the
      // subagent — its input stream is not ours — so it goes to the coordinator,
      // which is the party that will otherwise believe the subagent's false "the
      // user declined" and abandon the work. This does push a message into the
      // main thread's queue while a subagent runs, which is itself the mechanism
      // that causes phantoms; `PHANTOM_CORRECTIONS_MAX_PER_TURN` is what stops
      // that from feeding itself, and a coordinator acting on a false refusal is
      // the worse of the two failures.
      const phantoms = detectPhantomCancellations(result.value, session);
      let phantomNotice: string | undefined;
      if (phantoms.length > 0) {
        // A batch is uniformly one or the other: `parent_tool_use_id` is a
        // message-level field (see `detectPhantomCancellations`).
        const mainThread = phantoms.some((p) => p.mainThread);
        const spent = mainThread ? mainThreadCorrections : subagentCorrections;
        const steered =
          spent < PHANTOM_CORRECTIONS_MAX_PER_TURN &&
          heldPrompt.push(buildPhantomCorrectionNote(phantoms));
        if (steered) {
          if (mainThread) mainThreadCorrections++;
          else subagentCorrections++;
        }
        logger.warn('[sendMessage] phantom tool-call cancellation detected', {
          session: sessionId,
          toolUseIds: phantoms.map((p) => p.toolUseId),
          mainThread,
          steered,
        });
        const plural =
          phantoms.length > 1 ? `${phantoms.length} pending tool calls` : 'a pending tool call';
        const where = mainThread ? '' : ' inside one of its helpers';
        phantomNotice = `A background task finished at the wrong moment and cancelled ${plural}${where}. That was a system glitch, not you. The agent has been told.`;
      }

      // The `result` message marks the end of a SEGMENT — which is the end of
      // the turn only when no background task still owes a notification
      // (DOR-1149). The subprocess is alive either way (the prompt stream is
      // held open), so fetch the authoritative context-usage breakdown AND the
      // current subscription utilization now — before this message maps to
      // `done`, so the resulting `context_usage` event precedes `done` and the
      // terminal `session_status` carries `usage` (DOR-99).
      //
      // This frame's OWN query, never the session's shared slot (DOR-1088): an
      // overlapping turn can have replaced `activeQuery`, and the usage
      // breakdown has to come from the subprocess that produced THIS result.
      // The guard on `session.activeQuery` that used to sit here also gated the
      // `heldPrompt.close()` below — so a frame whose slot had been cleared
      // never released its own stdin, and the subprocess it owned could not
      // exit. Reading the local removes both problems at once.
      if (result.value.type === 'result') {
        const query = agentQuery;
        const [breakdown, subscriptionUsage] = await Promise.all([
          fetchContextBreakdown(query, CONTEXT_USAGE_TIMEOUT_MS).catch((err: unknown) => {
            logger.debug('[sendMessage] getContextUsage failed', { err });
            return undefined;
          }),
          fetchSubscriptionUsage(query, CONTEXT_USAGE_TIMEOUT_MS).catch((err: unknown) => {
            logger.debug('[sendMessage] get_usage failed', { err });
            return undefined;
          }),
        ]);
        if (breakdown) session.contextBreakdown = breakdown;
        // Hold the freshest utilization on the session so the result mapper
        // stamps it onto the terminal session_status. `undefined` (API-key
        // session, fetch failure) keeps the last known value — the item must
        // never flicker back to cost-only between turns.
        if (subscriptionUsage) session.lastSubscriptionUsage = subscriptionUsage;
        // Release stdin so the process drains its trailing messages and exits —
        // unless the CLI still owes us a queued-notification segment, in which
        // case closing here would strand the steering channel for the rest of
        // the turn (DOR-1149). The `finally` closes unconditionally, so a
        // deferral can never leak the subprocess.
        if (segments.holdOpenAtResult()) {
          // Arm the deadline for THIS deferral. Any earlier one has already been
          // released, so there is never more than one live timer.
          deferredCloseDeadline = new Promise<'expired'>((resolve) => {
            deferredCloseTimer = setTimeout(() => resolve('expired'), DEFERRED_CLOSE_TIMEOUT_MS);
            // Never let this timer alone hold the process open.
            deferredCloseTimer.unref?.();
          });
        } else {
          releaseDeferredClose();
          heldPrompt.close();
        }
      }

      // A mid-session `commands_changed` push carries the full, authoritative
      // command list. Replace the runtime cache here (this loop holds the
      // callback; the pure system-event mapper does not) so `/api/commands`
      // reflects the change without a restart (DOR-108).
      if (
        result.value.type === 'system' &&
        'subtype' in result.value &&
        (result.value as { subtype?: string }).subtype === 'commands_changed' &&
        opts.onCommandsChanged
      ) {
        const changed = result.value as unknown as {
          commands?: Array<{
            name: string;
            description: string;
            argumentHint: string;
            aliases?: string[];
          }>;
        };
        opts.onCommandsChanged(
          (changed.commands ?? []).map((c) => ({
            name: c.name,
            description: c.description,
            argumentHint: c.argumentHint,
            aliases: c.aliases,
          }))
        );
      }

      let prevSdkId = session.sdkSessionId;
      for await (const event of mapSdkMessage(result.value, session, sessionId, toolState)) {
        // BEFORE this event leaves the server. The mapper may have just adopted
        // a new canonical id, and yielding first is what opened the window this
        // closes: `trigger-turn` re-keys the projector on every event it sees,
        // which announces the new id to the cockpit as `retiredSessionId`, and
        // the cockpit's very next message is POSTed under it. That POST reaches
        // `persistSessionRuntime`, which mints a row for an id it has never
        // seen — pre-seeded with the server's default trust stop — and reports
        // a brand-new session. Moving the row first means the POST lands on a
        // row that is already bound: nothing is seeded, nothing is counted
        // twice, and the merge below never has to choose between the operator's
        // mode and a default nobody picked (DOR-493, DOR-838).
        if (session.sdkSessionId !== prevSdkId) {
          const retired = prevSdkId;
          prevSdkId = session.sdkSessionId;
          await opts.onSdkSessionRebind(retired, session.sdkSessionId);
        }
        if (event.type === 'done') {
          emittedDone = true;
          if (opts.meshCore && meshAgentId) {
            opts.meshCore.updateLastSeen(meshAgentId, 'response_complete');
          }
          // Zero-content turn about to close: surface the no-response error
          // BEFORE the terminal done — nothing may follow done (a trailing
          // error would leave the durable snapshot idle with a stale
          // lastError instead of settling the turn to error).
          if (contentEventCount === 0 && !emittedError && !wasInteractive) {
            logger.warn('[sendMessage] stream completed with zero content events', {
              session: sessionId,
              eventCount,
              durationMs: Date.now() - streamStart,
            });
            emittedError = true;
            yield emptyStreamError();
          }
        }
        // A mapped typed error (e.g. a non-success result subtype) counts as
        // a prior error for the empty-stream guard below; without this, a
        // failed zero-content turn would get a second generic error appended
        // after its terminal done.
        if (event.type === 'error') emittedError = true;
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
      // The phantom notice trails this message's own mapped events (see the
      // detection block above) so the strip re-derivation those events trigger
      // cannot wipe it in the same frame.
      if (phantomNotice !== undefined) {
        eventCount++;
        yield { type: 'system_status', data: { message: phantomNotice } };
      }
      // Catch-all for an id adopted after the last event of this message was
      // yielded (nothing does that today, and this costs one comparison if
      // nothing ever does). The in-loop rebind above is the one that carries the
      // ordering guarantee; this one only makes sure a rename can never be
      // missed outright. `rebindSdkSession` is a no-op when the ids match, so
      // the two can never double-apply.
      if (session.sdkSessionId !== prevSdkId) {
        await opts.onSdkSessionRebind(prevSdkId, session.sdkSessionId);
      }
    }
  } catch (err) {
    // A stale/absent `resumeSessionAt` anchor (transcript compacted or rewritten
    // out from under us) makes the CLI hard-fail. Drop the anchor and resume
    // plainly — this preserves history (unlike the resume-as-new path below) and
    // at worst re-admits a single phantom continue this one turn.
    if (sdkOptions.resumeSessionAt && isAnchorNotFound(err) && retryDepth < MAX_RESUME_RETRIES) {
      logger.warn('[sendMessage] resumeSessionAt anchor not found, retrying without anchor', {
        session: sessionId,
        retryDepth,
        anchor: sdkOptions.resumeSessionAt,
      });
      session.lastAssistantUuid = undefined;
      retriedViaRecursion = true;
      yield* executeSdkQuery(sessionId, content, session, opts, messageOpts, retryDepth + 1);
      return;
    }
    if (session.hasStarted && isResumeFailure(err) && retryDepth < MAX_RESUME_RETRIES) {
      logger.warn('[sendMessage] resume failed for stale session, retrying as new', {
        session: sessionId,
        retryDepth,
        error: err instanceof Error ? err.message : String(err),
      });
      // `accountRoot` deliberately survives this reset (spec C2). The retry
      // starts a BRAND-NEW SDK session, whose transcript is written under
      // whatever account the recursion pins — so clearing the account here
      // alongside `hasStarted` would silently move a paying client's
      // conversation onto whichever account happens to be active. The account is
      // a fact about the conversation, not about whether it has started.
      session.hasStarted = false;
      retriedViaRecursion = true;
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
    // A pre-stream credential failure (the classic first-run "not signed in"
    // case) throws here before any typed error event reaches the mappers, so
    // classify the raw thrown message: an auth failure earns the re-auth
    // category (and its "Fix sign-in" affordance) instead of the generic
    // overloaded copy. The raw message stays reachable via `details`.
    const isAuthError = detectAuthError({ message: errMsg });
    yield {
      type: 'error',
      data: {
        message: isAuthError
          ? 'Your sign-in stopped working. Sign in again to keep going.'
          : 'The agent stopped unexpectedly. The service may be temporarily overloaded — try again in a moment.',
        category: (isAuthError ? 'auth_error' : 'execution_error') as ErrorCategory,
        details: errMsg,
      },
    };
    emittedError = true;
  } finally {
    // Always release the held input stream so the subprocess can never leak if we
    // exit before the result message (error, interrupt, empty stream). Idempotent.
    // Clearing the deadline here also covers the path where the race THREW —
    // otherwise a rejected SDK promise would leave a live timer behind.
    releaseDeferredClose();
    heldPrompt.close();
    // Preserve the query reference for post-stream control methods (e.g.
    // reloadPlugins) — but only when this frame still OWNS the active query
    // (DOR-1088). Unconditional, this cleared whatever query happened to be
    // active, so a frame that settled late stranded its successor: the newer
    // turn kept streaming with `activeQuery` set to `undefined`, and every
    // control call that reaches for it (interrupt, model change, context usage)
    // found nothing to talk to. The recursion retry has the same shape — the
    // inner frame installs and clears its own query, and this line then wiped
    // the `lastQuery` the inner frame had just recorded.
    if (session.activeQuery === agentQuery) {
      session.lastQuery = agentQuery;
      session.activeQuery = undefined;
    }
    // Commit this turn's resume anchor for the next turn: the last main-thread
    // assistant uuid, or undefined when the turn produced none (empty/error) so
    // the next resume stays plain and keeps this turn's user message in context.
    // Skipped when a recursion retry ran — that inner call set the correct value
    // and this outer frame's local would clobber it.
    if (!retriedViaRecursion) {
      session.lastAssistantUuid = lastMainAssistantUuid;
    }
  }

  // Detect empty streams that also never produced a done — zero content
  // events with no prior error. The done-bearing zero-content case is handled
  // in-loop (error yielded BEFORE the terminal done); this arm covers streams
  // that died without any terminal at all, where the trailing done below
  // still closes the turn after this error.
  if (contentEventCount === 0 && !emittedError && !emittedDone && !wasInteractive) {
    logger.warn('[sendMessage] stream completed with zero content events', {
      session: sessionId,
      eventCount,
      durationMs: Date.now() - streamStart,
    });
    yield emptyStreamError();
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
