/**
 * Pure derivation of status-bar inputs from the snapshot-backed per-session
 * stream status (spec chat-stream-reconnection, Phase 3 / #9).
 *
 * The status bar's server-derived items (context %, cost, cache, model,
 * permission mode) were read from the legacy send-path store, which is `null`
 * until the first live event — so they were absent on a cold mount / refresh.
 * This module maps the snapshot-hydrated {@link SessionStatus} onto those item
 * inputs so they populate immediately, falling back to the legacy/derived values
 * only when the stream status has not yet hydrated.
 *
 * @module features/chat/model/stream/derive-status-bar
 */
import { deriveContextPercent } from '@/layers/entities/session';
import type { SessionStatus } from '@dorkos/shared/session-stream';
import type { UsageStatus } from '@dorkos/shared/types';

/** Cache-item inputs derived from a session status. */
export interface CacheStatusInput {
  cacheReadTokens: number;
  cacheCreationTokens: number;
  contextTokens?: number;
}

/** The status-bar values projected from the snapshot-backed session status. */
export interface StatusBarValues {
  /** Context-window utilization percentage (0-100), or `null`. */
  contextPercent: number | null;
  /** Cumulative session cost in USD, or `null`. */
  costUsd: number | null;
  /** Active model identifier, or `null`. */
  model: string | null;
  /** Cache hit/write accounting, or `null`. */
  cacheStatus: CacheStatusInput | null;
  /** Runtime-neutral usage/cost descriptor for the merged item, or `null`. */
  usage: UsageStatus | null;
}

/** Build the cache-item input from the status' cache stats + context usage. */
function deriveCacheStatus(status: SessionStatus): CacheStatusInput | null {
  const cache = status.cacheStats;
  if (!cache || (cache.cacheReadTokens === 0 && cache.cacheCreationTokens === 0)) return null;
  return {
    cacheReadTokens: cache.cacheReadTokens,
    cacheCreationTokens: cache.cacheCreationTokens,
    contextTokens: status.contextUsage?.totalTokens,
  };
}

/**
 * Project the snapshot-backed {@link SessionStatus} onto the status-bar item
 * inputs. Returns all-`null` when there is no hydrated status yet, letting the
 * caller fall back to its legacy/derived values.
 *
 * @param status - The per-session stream status, or `null` before hydration.
 */
export function deriveStatusBarValues(status: SessionStatus | null): StatusBarValues {
  if (!status) {
    return { contextPercent: null, costUsd: null, model: null, cacheStatus: null, usage: null };
  }
  return {
    contextPercent: deriveContextPercent(
      status.contextUsage?.totalTokens,
      status.contextUsage?.maxTokens
    ),
    costUsd: status.cost,
    model: status.model,
    cacheStatus: deriveCacheStatus(status),
    usage: status.usage,
  };
}
