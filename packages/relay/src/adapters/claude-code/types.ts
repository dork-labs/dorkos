/**
 * Shared type definitions for the Claude Code adapter sub-modules.
 *
 * Contains dependency interfaces and configuration types used across
 * the agent handler, tasks handler, and queue modules. Extracted to
 * avoid circular imports between the facade and sub-modules.
 *
 * @module relay/adapters/claude-code-types
 */

import type { PermissionMode, SessionSettings, StreamEvent } from '@dorkos/shared/types';

/**
 * What a relay-triggered turn runs with, beyond its permission mode.
 *
 * Permissions are deliberately absent. The relay resolves its own mode from the
 * binding that carried the message — and treats an absent one as `'default'`
 * rather than as consent (DOR-604) — so an execution setting that could also
 * carry a permission mode would be a second answer to a question that already
 * has one.
 */
export type TurnExecutionSettings = Omit<SessionSettings, 'permissionMode'>;

/**
 * What model, effort and fast-mode a relay-triggered turn should start with.
 *
 * The adapter cannot answer this itself: the ladder is an agent's manifest, then
 * the server's per-runtime default, and both live host-side (the server's
 * `resolveSessionDefaults`, which is also what a room turn resolves through).
 * So it is a seam — a host that wires one gets an agent answering on the model
 * it was pinned to, and a host that wires none behaves exactly as before, with
 * the runtime picking.
 *
 * **A session that already has settings keeps them.** The resolver is asked with
 * the key the turn is about to run under, which is the persisted SDK session id
 * once one exists, so a host can find the row a person's own choice was stored
 * in and answer with that instead of the manifest.
 *
 * Tolerant by contract: the adapter treats a rejection as "no preference" and
 * runs the turn anyway. A settings problem must never drop somebody's message.
 *
 * @param opts.sessionId - The session key this turn runs under (`ccaSessionKey`).
 * @param opts.agentDirectory - The addressed agent's project directory, the one
 *   holding `.dork/agent.json`. Absent when nothing resolved an agent for this
 *   subject, and the manifest tier then has nothing to read.
 */
export type ExecutionSettingsResolver = (opts: {
  sessionId: string;
  agentDirectory?: string;
}) => Promise<TurnExecutionSettings>;

/**
 * Minimal interface for agent session management.
 *
 * This is a structural subset of the `AgentRuntime` interface from
 * `@dorkos/shared/agent-runtime`. Any `AgentRuntime` implementation
 * (e.g., `ClaudeCodeRuntime`) satisfies this interface without explicit
 * casting, so callers can pass a runtime instance directly as `agentManager`.
 *
 * Kept as a separate interface (rather than importing `AgentRuntime`) so the
 * adapter states only the narrow surface it actually calls. The VALUE types it
 * exchanges are still the shared ones — a permission mode narrowed to `string`
 * here would let a mode nothing can run travel from a relay dispatch into a
 * live session with no compiler objection anywhere along the way.
 */
export interface AgentRuntimeLike {
  /**
   * The runtime's own type string (`'claude-code'`, `'test-mode'`, …).
   *
   * Optional because the adapter itself never dispatches on it — the handlers
   * below work the same whoever is behind them. It exists so a caller holding
   * only an `AgentRuntimeLike` can key it correctly in a runtime map instead of
   * guessing `'claude-code'`, which is wrong for every runtime that isn't
   * Claude Code and silently disables anything that looks the key up again.
   * Every real `AgentRuntime` supplies it.
   */
  readonly type?: string;

  ensureSession(
    sessionId: string,
    opts: TurnExecutionSettings & {
      permissionMode: PermissionMode;
      cwd?: string;
      hasStarted?: boolean;
    }
  ): void;
  sendMessage(
    sessionId: string,
    content: string,
    opts?: TurnExecutionSettings & {
      permissionMode?: PermissionMode;
      cwd?: string;
      systemPromptAppend?: string;
    }
  ): AsyncGenerator<StreamEvent>;
  /**
   * Get the SDK-assigned session UUID for a given session key.
   *
   * The SDK may assign a different UUID from the one passed to ensureSession()
   * after the first query() init message. This returns the actual SDK UUID.
   *
   * @param sessionId - The session key used in ensureSession/sendMessage
   * @returns The SDK session UUID, or undefined if the session does not exist
   */
  getSdkSessionId(sessionId: string): string | undefined;

  /**
   * Resolve a pending tool approval interaction.
   *
   * Called by the CCA adapter's approval handler when a chat adapter user
   * clicks Approve or Deny on a tool approval card.
   *
   * @param sessionId - The session key (ccaSessionKey)
   * @param toolCallId - The tool call to approve/deny
   * @param approved - Whether to approve (true) or deny (false)
   * @returns false if the session or pending interaction was not found
   */
  approveTool(sessionId: string, toolCallId: string, approved: boolean): boolean;

  /**
   * End the in-flight turn for a session.
   *
   * The only way to stop a running turn: `sendMessage` takes no `AbortSignal`,
   * so abandoning its stream leaves the agent running. The tasks handler calls
   * this when a run's TTL budget expires.
   *
   * @param sessionId - The session key used in ensureSession/sendMessage
   * @returns false if the runtime found no in-flight turn to abort
   */
  interruptQuery(sessionId: string): Promise<boolean>;
}

/**
 * Minimal interface for the persistent agent session store.
 *
 * Maps Mesh agent ULIDs (or other stable agent keys) to their SDK session UUIDs
 * so that conversation threads survive server restarts.
 */
export interface AgentSessionStoreLike {
  get(agentId: string): string | undefined;
  set(agentId: string, sdkSessionId: string): void;
}

/** Minimal TasksStore interface for Tasks run lifecycle updates. */
export interface TasksStoreLike {
  updateRun(runId: string, update: Record<string, unknown>): void;
}

/** Configuration for the ClaudeCodeAdapter. */
export interface ClaudeCodeAdapterConfig {
  /** Maximum concurrent agent sessions. Default: 3 */
  maxConcurrent?: number;
  /** Default session timeout in ms (used when envelope has no TTL). Default: 300000 (5 min) */
  defaultTimeoutMs?: number;
  /** Default working directory for agents without explicit directory */
  defaultCwd?: string;
}

/** Dependencies injected into ClaudeCodeAdapter. */
export interface ClaudeCodeAdapterDeps {
  agentManager: AgentRuntimeLike;
  traceStore: import('../../types.js').TraceStoreLike;
  taskStore?: TasksStoreLike;
  /**
   * Persistent store for mapping agent identifiers to SDK session UUIDs.
   *
   * When provided, handleAgentMessage() will look up the persisted SDK session
   * UUID for the agent key extracted from the subject, enabling conversation
   * continuity across server restarts. If not provided, the raw subject key
   * is used as the session ID (original behavior).
   */
  agentSessionStore?: AgentSessionStoreLike;
  /**
   * What model and effort an agent-addressed turn starts with — see
   * {@link ExecutionSettingsResolver}. Absent means no preference at all, which
   * is what every host did before this existed.
   */
  resolveExecutionSettings?: ExecutionSettingsResolver;
  logger?: import('@dorkos/shared/logger').Logger;
}

/** Resolved config type (all fields required after construction). */
export interface ResolvedConfig {
  maxConcurrent: number;
  defaultTimeoutMs: number;
  defaultCwd: string;
}
