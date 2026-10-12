/**
 * When a raise may reach a person, and the key that names a raise. Split out of
 * `outbox.ts` so that file stays inside its line budget.
 *
 * @module services/heartbeats/raises/delivery-time
 */
import type { EndBeatRaise } from '@dorkos/shared/heartbeat-schemas';
import {
  isWithinWorkingHours,
  nextWorkingStart,
  type ResolvedWorkingHours,
} from '@dorkos/shared/working-hours';
import { HOUR_MS } from '../urgent-ceiling.js';

/** How often an away person with no return date is checked again. */
const AWAY_RECHECK_MS = HOUR_MS;

/** A person's hours and away state, as delivery reads them. */
export interface PersonPresence {
  /** Their working hours, in their zone. */
  hours: ResolvedWorkingHours;
  /** That they are away, or null. `until: null` is away until they say otherwise. */
  away: { until: string | null } | null;
}

/**
 * When a message to a person may be delivered, at or after `now`.
 *
 * @param presence - Their hours and away state.
 * @param now - Epoch ms.
 * @returns Epoch ms; `now` when it may go now.
 */
export function deliveryTime(presence: PersonPresence, now: number): number {
  const { hours, away } = presence;
  let from = now;
  if (away) {
    const until = away.until ? Date.parse(away.until) : NaN;
    if (Number.isNaN(until)) return now + AWAY_RECHECK_MS;
    if (until > now) from = until;
  }
  if (hours.days.length === 0 || isWithinWorkingHours(new Date(from), hours)) return from;
  return nextWorkingStart(new Date(from), hours)?.getTime() ?? from;
}

/**
 * A raise's stable key: the one it names, else its `about` keys sorted, else a
 * hash of its text (spec `heartbeats` §8).
 *
 * @param raise - The raise.
 */
export function raiseKey(raise: EndBeatRaise): string {
  if (raise.key) return raise.key;
  if (raise.about?.length) return [...raise.about].sort().join('|');
  let hash = 0;
  for (const char of raise.text) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return `text:${(hash >>> 0).toString(36)}`;
}
