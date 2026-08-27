/**
 * The vocabulary and small helpers the two claude-code dispatch paths share:
 * the resume-per-message sender (`message-sender.ts`) and the persistent pump's
 * launch resolution (`launch-resolver.ts`).
 *
 * Split out for one reason only — the resolver is called BY the sender, so
 * anything the resolver needs cannot live in the sender without a cycle. The
 * sender re-exports every name here, so no existing import site moved.
 *
 * @module services/runtimes/claude-code/messaging/message-sender-shared
 */
import type { McpServerConfig, McpServerStatus } from '@anthropic-ai/claude-agent-sdk';
import type { AgentRegistryPort, McpAppServerConnection } from '@dorkos/shared/agent-runtime';
import type { McpServerEntry } from '@dorkos/shared/transport';
import type { EffortLevel } from '@dorkos/shared/types';
import { editToolFilePath, isEditFamilyTool } from '@dorkos/shared/diff-tools';
import path from 'node:path';
import { logger } from '../../../../lib/logger.js';
import { editBaselineStore } from '../../../diff/index.js';
import type { AdapterManager } from '../../../relay/adapter-manager.js';
import type { BindingRouter } from '../../../relay/binding-router.js';
import type { BindingStore } from '../../../relay/binding-store.js';
import type { AgentSession } from '../agent-types.js';
import type { ClaudeAgentSdkPlugin } from './plugin-activation.js';
import type { ModelThinkingCapability } from './thinking-config.js';

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
    ((session: AgentSession, sessionId: string) => Record<string, McpServerConfig>) | null;
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
