/** The stored authors behind this turn’s answers, for its notices only. */
import type { TurnStarter } from '@dorkos/shared/agent-runtime';
import { authorOrigin } from '../author-registry.js';

/** A mixed burst names the burst. A display name or message body never supplies its source. */
export function roomTurnStarter(
  authors: { getById(id: string): { naturalKey: string } | null },
  answered: readonly { authorId: string }[]
): TurnStarter | undefined {
  const starters = new Set(
    answered.map((entry): TurnStarter | undefined => {
      let record: { naturalKey: string } | null;
      try {
        record = authors.getById(entry.authorId);
      } catch {
        return 'unknown';
      }
      if (!record) return 'unknown';
      const origin = authorOrigin(record.naturalKey);
      if (origin === 'local') return undefined;
      return origin.platform === 'telegram' || origin.platform === 'slack'
        ? origin.platform
        : 'outside-message';
    })
  );
  if (starters.size > 1) return 'room-messages';
  return [...starters][0];
}
