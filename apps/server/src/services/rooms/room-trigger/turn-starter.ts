/** The stored authors behind this turn’s answers, for its notices only. */
import type { TurnStarter } from '@dorkos/shared/agent-runtime';
import { authorOrigin, isOwnerRecord, type AuthorRecord } from '../author-registry.js';

/** A mixed burst names the burst. A display name or message body never supplies its source. */
export function roomTurnStarter(
  authors: { getById(id: string): AuthorRecord | null },
  answered: readonly { authorId: string }[],
  ownerUserId: string | null = null
): TurnStarter | undefined {
  const starters = new Set(
    answered.map((entry): TurnStarter | undefined => {
      let record: AuthorRecord | null;
      try {
        record = authors.getById(entry.authorId);
      } catch {
        return 'unknown';
      }
      if (!record) return 'unknown';
      const origin = authorOrigin(record.naturalKey);
      if (origin === 'local') return isOwnerRecord(record, ownerUserId) ? 'person' : 'agent';
      return origin.platform === 'telegram' || origin.platform === 'slack'
        ? origin.platform
        : 'outside-message';
    })
  );
  if (starters.size > 1) return 'room-messages';
  return [...starters][0];
}
