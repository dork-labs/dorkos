/**
 * The transcript marker's display rules (spec `claude-account-ui` §6.7): which
 * resolved episode a turn's `rate_limit` error belongs to, and the words of its
 * one-line marker. Pure: the server records how each episode ended (§7.1).
 *
 * @module features/continue-on-account/lib/limit-marker
 */
import type { LimitHistoryEntry } from '@dorkos/shared/account-usage';
import { modelBucketName } from '@/layers/shared/lib';

/** How far after the error's message a limit may start and still be its episode. */
export const EPISODE_MATCH_MS = 5 * 60 * 1000;

/** A model as the runtime's model list serves it. */
export interface ModelName {
  /** The model's id. */
  value: string;
  /** What a person calls it (`Sonnet`). */
  displayName: string;
}

/**
 * Whether a limit that started at `since` is the episode of an error part in
 * a message stamped `at`: it started at or after the message, within five
 * minutes.
 *
 * @param since - When the limit was hit, ISO-8601.
 * @param at - The error part's message timestamp, ISO-8601.
 */
export function isEpisodeOf(since: string, at: string): boolean {
  const gap = Date.parse(since) - Date.parse(at);
  return Number.isFinite(gap) && gap >= 0 && gap <= EPISODE_MATCH_MS;
}

/**
 * The resolved episode an error part belongs to: the history row whose `since`
 * is the first at or after the part's message timestamp, within five minutes.
 *
 * @param entries - The session's resolved episodes.
 * @param at - The error part's message timestamp, ISO-8601.
 * @returns The row, or `null` when no episode matches (one older than the history).
 */
export function episodeFor(
  entries: readonly LimitHistoryEntry[],
  at: string
): LimitHistoryEntry | null {
  let best: LimitHistoryEntry | null = null;
  for (const entry of entries) {
    if (!isEpisodeOf(entry.since, at)) continue;
    if (best === null || Date.parse(entry.since) < Date.parse(best.since)) best = entry;
  }
  return best;
}

/**
 * A model's display name from the runtime's model list, or `null` when the
 * model is unknown: a `null` or empty id is never named, so it never reads as
 * a switch.
 *
 * @param id - The model id, as the server recorded it.
 * @param models - The runtime's models.
 */
export function modelDisplayName(
  id: string | null | undefined,
  models: readonly ModelName[]
): string | null {
  if (!id) return null;
  return models.find((model) => model.value === id)?.displayName ?? id;
}

/**
 * The two models of a `resumed-model` episode, as the marker names them. The
 * model that ran out is the recorded `modelFrom`, else the model a model-scope
 * window names (`seven_day_opus` is Opus). Either side is `null` when unknown,
 * and the marker then says only what it knows.
 *
 * @param entry - The episode.
 * @param models - The runtime's models.
 */
export function switchedModels(
  entry: Pick<LimitHistoryEntry, 'modelFrom' | 'modelTo' | 'scope' | 'window'>,
  models: readonly ModelName[]
): { from: string | null; to: string | null } {
  const from =
    modelDisplayName(entry.modelFrom, models) ??
    (entry.scope === 'model' ? modelBucketName(entry.window, models) : null);
  return { from, to: modelDisplayName(entry.modelTo, models) };
}
