/**
 * The status a session projector starts from, before any event has said
 * anything about the session. Split out of `session-state-projector.ts`.
 *
 * @module services/session/projector/cold-status
 */
import type { SessionContextUsage, SessionStatus } from '@dorkos/shared/session-stream';
import type { PermissionMode } from '@dorkos/shared/types';

/** Permission mode used before any `status_change` reports one. */
const DEFAULT_PERMISSION_MODE: PermissionMode = 'default';

/** A fully-zeroed {@link SessionContextUsage}; the base for the first delta. */
const ZERO_CONTEXT_USAGE: SessionContextUsage = {
  totalTokens: 0,
  maxTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

/**
 * Resolve the base to field-wise-merge a partial `contextUsage` delta onto.
 * When no prior usage exists (cold status), start from {@link ZERO_CONTEXT_USAGE}
 * so the merged result is still the full (non-partial) {@link SessionContextUsage}.
 *
 * @param prior - The currently-held usage, or `null` on a cold status.
 */
export function mergeBaseContextUsage(prior: SessionContextUsage | null): SessionContextUsage {
  return prior ?? ZERO_CONTEXT_USAGE;
}

/** A cold-snapshot status: every usage field null, idle, no subagents. */
export function coldStatus(): SessionStatus {
  return {
    contextUsage: null,
    cost: null,
    usage: null,
    cacheStats: null,
    model: null,
    permissionMode: DEFAULT_PERMISSION_MODE,
    todoCounts: null,
    runningSubagentCount: 0,
    lifecycle: 'idle',
    lastError: null,
    limit: null,
    accountUsage: null,
  };
}
