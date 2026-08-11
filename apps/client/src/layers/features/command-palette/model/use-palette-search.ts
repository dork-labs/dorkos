import Fuse, { type IFuseOptions, type FuseResultMatch } from 'fuse.js';
import { useMemo } from 'react';
import type { RoomSummary } from '@/layers/entities/room';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';
import type { PaletteSessionItem } from './palette-sessions';
import {
  NO_USAGE,
  rankCandidates,
  selectBestMatch,
  type RankCandidate,
  type RankedRow,
} from './palette-ranking';
import type { PaletteUsage } from './use-palette-usage';
import type { FeatureItem, CommandItemData, QuickActionItem } from './use-palette-items';

/** What every searchable row carries, whatever kind of thing it stands for. */
interface SearchableItemBase {
  /** The row's identity within its own kind. */
  id: string;
  /** What it is called — the first thing Fuse matches against. */
  name: string;
  /** Everything else a person might type to reach it. Never message content (§15). */
  keywords?: string[];
  /**
   * Where this row's usage is recorded, as an `entities/interactions` key —
   * `null` for the rows nothing records, which is every action and every slash
   * command. Required rather than optional so a new kind of palette item cannot
   * arrive silently unranked: the corpus has to answer the question.
   */
  usageKey: string | null;
  /** When the thing itself was last active, ISO-8601. `null` when it has no such moment. */
  lastActivityAt: string | null;
  /** Something is waiting on a person here — an unread room, today. */
  waiting: boolean;
  /** Findable but not live — an archived room. Ranks below everything live. */
  demoted: boolean;
}

/**
 * One row in the palette's corpus, discriminated by what it stands for.
 *
 * A union rather than a `type` field beside a `data: A | B | C` field, because
 * the ranked list draws every kind from one array: the row renderer switches on
 * `type` and needs `data` to narrow with it. The old shape let the two disagree
 * and only a cast could bridge them.
 *
 * Rooms appear twice because the two prefixes address them differently (spec
 * `rooms` §13.2): `room` is a channel, reached with `#` because a room is named;
 * `dm` is a direct message, reached with `@` because a DM is addressed by who is
 * in it.
 */
export type SearchableItem =
  | (SearchableItemBase & { type: 'agent'; data: AgentPathEntry })
  | (SearchableItemBase & { type: 'session'; data: PaletteSessionItem })
  | (SearchableItemBase & { type: 'feature'; data: FeatureItem })
  | (SearchableItemBase & { type: 'command'; data: CommandItemData })
  | (SearchableItemBase & { type: 'quick-action'; data: QuickActionItem })
  | (SearchableItemBase & { type: 'room'; data: RoomSummary })
  | (SearchableItemBase & { type: 'dm'; data: RoomSummary });

export interface SearchResult {
  item: SearchableItem;
  matches: readonly FuseResultMatch[] | undefined;
}

const FUSE_OPTIONS: IFuseOptions<SearchableItem> = {
  keys: ['name', 'keywords'],
  includeMatches: true,
  // Load-bearing since ranking landed: the score IS the relevance signal, and
  // without this every row arrives at the ranker indistinguishable from every
  // other — which is the fixed-group-order bug wearing a different hat.
  includeScore: true,
  threshold: 0.3,
  distance: 100,
  minMatchCharLength: 1,
};

/** What {@link usePaletteSearch} needs beyond the corpus and the query. */
export interface PaletteSearchOptions {
  /** The operator's usage history, keyed by {@link SearchableItem.usageKey}. */
  usage: PaletteUsage;
  /** The instant to rank against, epoch ms — the caller's clock, never this module's. */
  now: number;
}

/** One ranked palette list, and the query that produced it. */
export interface PaletteSearchResult {
  /**
   * The row that stands clear of the rest, drawn in its own **Best match**
   * section — or `null` when no row has earned one (see `selectBestMatch`).
   */
  bestMatch: RankedRow<SearchResult> | null;
  /** Everything else, in ranked order. Never reordered to make up for a missing best match. */
  rows: RankedRow<SearchResult>[];
  /** The prefix that scoped the search, if any. */
  prefix: string | null;
  /** What was typed after the prefix. */
  term: string;
}

/**
 * Fuse.js-powered fuzzy search, blended into one ranked list.
 *
 * Prefix `#` filters channels. Prefix `@` filters agents and direct
 * messages — a DM is addressed by who is in it, so `@ana` offers the
 * conversation with Ana beside Ana herself (spec `rooms` §13.2). Prefix `>`
 * filters commands only. No prefix searches all categories.
 *
 * **The prefixes filter and the ranker orders — in that order, and they never
 * swap jobs.** A row a prefix excluded is gone before scoring, so no score can
 * bring it back; a row a prefix admitted is ordered by what it is worth rather
 * than by which group it belongs to (design-decisions §15).
 *
 * @param items - All searchable items across categories
 * @param search - Raw search string from the input (may include prefix)
 * @param options - The usage history and the clock to rank against
 */
export function usePaletteSearch(
  items: SearchableItem[],
  search: string,
  options: PaletteSearchOptions
): PaletteSearchResult {
  const { usage, now } = options;
  const { prefix, term } = useMemo(() => parsePrefix(search), [search]);

  const filteredByPrefix = useMemo(() => {
    if (prefix === '#') return items.filter((i) => i.type === 'room');
    if (prefix === '@') return items.filter((i) => i.type === 'agent' || i.type === 'dm');
    if (prefix === '>') return items.filter((i) => i.type === 'command');
    return items;
  }, [items, prefix]);

  const fuse = useMemo(() => new Fuse(filteredByPrefix, FUSE_OPTIONS), [filteredByPrefix]);

  const candidates: RankCandidate<SearchResult>[] = useMemo(() => {
    const toCandidate = (
      item: SearchableItem,
      matches: readonly FuseResultMatch[] | undefined,
      distance: number | null
    ): RankCandidate<SearchResult> => {
      const lastActivityAt = item.lastActivityAt === null ? NaN : Date.parse(item.lastActivityAt);
      return {
        // Typed rather than the bare id: two kinds can share an id space (a DM
        // and the agent it is with, most obviously), and the tiebreak key has
        // to separate rows that a score cannot.
        key: `${item.type}:${item.id}`,
        item: { item, matches },
        distance,
        usage: (item.usageKey === null ? undefined : usage[item.usageKey]) ?? NO_USAGE,
        lastActivityAt: Number.isNaN(lastActivityAt) ? null : lastActivityAt,
        waiting: item.waiting,
        demoted: item.demoted,
      };
    };

    if (!term) return filteredByPrefix.map((item) => toCandidate(item, undefined, null));
    return fuse.search(term).map((r) => toCandidate(r.item, r.matches, r.score ?? 0));
  }, [fuse, term, filteredByPrefix, usage]);

  const ranked = useMemo(() => rankCandidates(candidates, now), [candidates, now]);
  // The TERM, not the raw search string. `#` on its own is a truthy search that
  // scopes the list without asking for anything, and a "Best match" over rows
  // nobody typed a word at is a claim the palette has not earned.
  const { best, rest } = useMemo(
    () => selectBestMatch(ranked, { queried: term.length > 0 }),
    [ranked, term]
  );

  return { bestMatch: best, rows: rest, prefix, term };
}

/**
 * Parse a prefix character (`#`, `@`, `>`) from the search string.
 *
 * @internal Exported for testing only.
 */
export function parsePrefix(search: string): { prefix: string | null; term: string } {
  if (search.startsWith('#')) return { prefix: '#', term: search.slice(1) };
  if (search.startsWith('@')) return { prefix: '@', term: search.slice(1) };
  if (search.startsWith('>')) return { prefix: '>', term: search.slice(1) };
  return { prefix: null, term: search };
}
