import { rankMatch, type MatchTier } from '@/layers/shared/lib';
import type { CommandEntry } from '@dorkos/shared/types';

/** A command enriched with the alias that surfaced it, when matched via an alias (DOR-120). */
export interface RankedCommandEntry extends CommandEntry {
  /** The alias the query matched, set only when the alias (not the name) is why the command surfaced. */
  matchedAlias?: string;
}

export interface CommandRank {
  match: boolean;
  /** Ranking bucket — lower is better. */
  bucket: number;
  /** Within-bucket tiebreak — higher is better. */
  score: number;
  /** The alias that produced the winning bucket, when that field was an alias. */
  matchedAlias?: string;
}

/**
 * Ranking ladder (lower = better), per DOR-119. Strong NAME matches rank above
 * every alias match; alias exact/prefix rank above any subsequence; a description
 * match only surfaces the command, ranked last.
 */
const BUCKET: Record<'name' | 'alias' | 'description', Record<MatchTier, number>> = {
  name: { exact: 0, prefix: 1, 'word-boundary': 2, substring: 6, subsequence: 8 },
  alias: { exact: 3, prefix: 4, 'word-boundary': 5, substring: 7, subsequence: 9 },
  description: { exact: 10, prefix: 11, 'word-boundary': 12, substring: 13, subsequence: 14 },
};

const NO_MATCH: CommandRank = { match: false, bucket: Number.POSITIVE_INFINITY, score: 0 };

function stripSlash(value: string): string {
  return value.startsWith('/') ? value.slice(1) : value;
}

/** True when `candidate` is a strictly better rank than `best`. */
function isBetter(candidate: { bucket: number; score: number }, best: CommandRank): boolean {
  return (
    candidate.bucket < best.bucket ||
    (candidate.bucket === best.bucket && candidate.score > best.score)
  );
}

/**
 * Rank a single command against a query across its name, aliases, and description
 * using the DOR-119 ranking ladder. The query must be the slash text without the
 * leading slash (e.g. `stats`), as produced by the palette's trigger detection.
 *
 * @param query - The slash query without the leading slash.
 * @param cmd - The command to score.
 */
export function rankCommand(query: string, cmd: CommandEntry): CommandRank {
  let best: CommandRank = NO_MATCH;

  const name = rankMatch(query, stripSlash(cmd.fullCommand));
  if (name.match && name.tier) {
    best = { match: true, bucket: BUCKET.name[name.tier], score: name.score };
  }

  for (const alias of cmd.aliases ?? []) {
    const m = rankMatch(query, stripSlash(alias));
    if (!m.match || !m.tier) continue;
    const candidate = { bucket: BUCKET.alias[m.tier], score: m.score };
    if (isBetter(candidate, best)) {
      best = { match: true, ...candidate, matchedAlias: alias };
    }
  }

  if (cmd.description) {
    const m = rankMatch(query, cmd.description);
    if (m.match && m.tier) {
      const candidate = { bucket: BUCKET.description[m.tier], score: m.score };
      if (isBetter(candidate, best)) {
        // A description match carries no alias provenance.
        best = { match: true, ...candidate };
      }
    }
  }

  return best;
}
