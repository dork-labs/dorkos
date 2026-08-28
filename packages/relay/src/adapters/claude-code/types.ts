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
import type { ApprovalAuthorizer } from './approval-handler.js';

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
 * @param opts.runtimeType - The runtime this turn was RESOLVED onto, not the one
 *   the adapter happened to boot with. A model id lives in one runtime's
 *   namespace and an effort is dropped where a runtime has none, so every tier
 *   below the session row is a per-runtime answer — asking with the wrong
 *   runtime is how a codex turn got handed a Claude model alias.
 * @param opts.agentDirectory - The addressed AGENT's project directory, the one
 *   holding `.dork/agent.json` — not necessarily where the turn runs, which a
 *   payload can move without changing who is answering. Absent when nothing
 *   resolved either, and the manifest tier then has nothing to read.
 */
export type ExecutionSettingsResolver = (opts: {
  sessionId: string;
  runtimeType: string;
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
      /**
       * True when nobody is watching — a scheduled task run, which is refused
       * at the ten-minute countdown rather than parked for four hours waiting
       * for an answer that is not coming. Mirrors `SessionOpts.unattended`; the
       * tasks handler is the one caller that sets it.
       */
      unattended?: boolean;
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
   * **Optional, because renaming your own sessions is a Claude Code habit and
   * not a runtime contract.** Codex and OpenCode keep the id DorkOS hands them
   * — a codex thread and an OpenCode session are both keyed by it — so there is
   * no second id for them to report, and `AgentRuntime` does not declare this
   * method at all. Callers must treat absence as "the key IS the durable id"
   * rather than as a missing capability: a relay turn on such a runtime simply
   * has no mapping to persist, and a sticky task run records the key it ran on.
   *
   * @param sessionId - The session key used in ensureSession/sendMessage
   * @returns The SDK session UUID, or undefined if the session does not exist
   */
  getSdkSessionId?(sessionId: string): string | undefined;

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
  /**
   * The runtime that answers when nothing NAMES one.
   *
   * That is a real case rather than a fallback for tidiness: a legacy
   * three-token `relay.agent.<sessionId>` subject and a task dispatch both
   * arrive with no runtime segment, and something has to run them. It is also
   * the entry every host has always passed, so a host that wires only this
   * behaves exactly as it did before {@link ClaudeCodeAdapterDeps.agentRuntimes}
   * existed.
   */
  agentManager: AgentRuntimeLike;
  /**
   * Every runtime this adapter may drive, keyed by runtime type.
   *
   * The adapter picks one PER MESSAGE from what the message itself names — the
   * runtime segment of a `relay.agent.<runtimeType>.<sessionId>` subject, or a
   * task dispatch's own `runtime` field — and refuses loudly when the named
   * runtime is absent (DOR-1614). A message that names nothing takes
   * {@link ClaudeCodeAdapterDeps.agentManager}.
   *
   * Optional so the many hosts and test doubles that drive exactly one runtime
   * keep working unchanged: an absent map means "one runtime, the one above".
   */
  agentRuntimes?: ReadonlyMap<string, AgentRuntimeLike>;
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
  /**
   * Whether a click on a chat platform may authorize one session's tool call.
   *
   * **Required**, never defaulted: the adapters' own `mayApprove` gate answers
   * for the binding it lives on, and a room-bound Ask reaches the approval bus
   * by a path no adapter binding covers (spec `ask-entitlement` §5.3). A
   * default here would be an allow for whatever publisher is added next.
   */
  approvalAuthorizer: ApprovalAuthorizer;
  logger?: import('@dorkos/shared/logger').Logger;
}

/** Resolved config type (all fields required after construction). */
export interface ResolvedConfig {
  maxConcurrent: number;
  defaultTimeoutMs: number;
  defaultCwd: string;
}
