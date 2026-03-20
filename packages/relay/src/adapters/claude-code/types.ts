/**
 * Shared type definitions for the Claude Code adapter sub-modules.
 *
 * Contains dependency interfaces and configuration types used across
 * the agent handler, pulse handler, and queue modules. Extracted to
 * avoid circular imports between the facade and sub-modules.
 *
 * @module relay/adapters/claude-code-types
 */

import type { StreamEvent } from '@dorkos/shared/types';

/**
 * Minimal interface for agent session management.
 *
 * This is a structural subset of the `AgentRuntime` interface from
 * `@dorkos/shared/agent-runtime`. Any `AgentRuntime` implementation
 * (e.g., `ClaudeCodeRuntime`) satisfies this interface without explicit
 * casting, so callers can pass a runtime instance directly as `agentManager`.
 *
 * Kept as a separate interface (rather than importing `AgentRuntime`) to avoid
 * adding a compile-time dependency from `@dorkos/relay` to `@dorkos/shared` for
 * types that are not relevant to the adapter's narrow concerns.
 */
export interface AgentRuntimeLike {
  ensureSession(
    sessionId: string,
    opts: { permissionMode: string; cwd?: string; hasStarted?: boolean }
  ): void;
  sendMessage(
    sessionId: string,
    content: string,
    opts?: { permissionMode?: string; cwd?: string; systemPromptAppend?: string }
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

/** Minimal PulseStore interface for Pulse run lifecycle updates. */
export interface PulseStoreLike {
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
  pulseStore?: PulseStoreLike;
  /**
   * Persistent store for mapping agent identifiers to SDK session UUIDs.
   *
   * When provided, handleAgentMessage() will look up the persisted SDK session
   * UUID for the agent key extracted from the subject, enabling conversation
   * continuity across server restarts. If not provided, the raw subject key
   * is used as the session ID (original behavior).
   */
  agentSessionStore?: AgentSessionStoreLike;
  logger?: import('@dorkos/shared/logger').Logger;
}

/** Resolved config type (all fields required after construction). */
export interface ResolvedConfig {
  maxConcurrent: number;
  defaultTimeoutMs: number;
  defaultCwd: string;
}
