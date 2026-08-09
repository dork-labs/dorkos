import Fuse, { type IFuseOptions, type FuseResultMatch } from 'fuse.js';
import { useMemo } from 'react';
import type { RoomSummary } from '@/layers/entities/room';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';
import type { PaletteSessionItem } from './palette-sessions';
import type { FeatureItem, CommandItemData, QuickActionItem } from './use-palette-items';

export interface SearchableItem {
  id: string;
  name: string;
  /**
   * Which list this item belongs to. Rooms are split in two because the two
   * prefixes address them differently (spec `rooms` §13.2): `room` is a
   * channel, reached with `#` because a room is named; `dm` is a direct
   * message, reached with `@` because a DM is addressed by who is in it.
   */
  type: 'agent' | 'session' | 'feature' | 'command' | 'quick-action' | 'room' | 'dm';
  keywords?: string[];
  data:
    | AgentPathEntry
    | PaletteSessionItem
    | FeatureItem
    | CommandItemData
    | QuickActionItem
    | RoomSummary;
}

export interface SearchResult {
  item: SearchableItem;
  matches: readonly FuseResultMatch[] | undefined;
}

const FUSE_OPTIONS: IFuseOptions<SearchableItem> = {
  keys: ['name', 'keywords'],
  includeMatches: true,
  threshold: 0.3,
  distance: 100,
  minMatchCharLength: 1,
};

/**
 * Fuse.js-powered fuzzy search with category prefix detection.
 *
 * Prefix `#` filters channels. Prefix `@` filters agents and direct
 * messages — a DM is addressed by who is in it, so `@ana` offers the
 * conversation with Ana beside Ana herself (spec `rooms` §13.2). Prefix `>`
 * filters commands only. No prefix searches all categories.
 *
 * @param items - All searchable items across categories
 * @param search - Raw search string from the input (may include prefix)
 */
export function usePaletteSearch(items: SearchableItem[], search: string) {
  const { prefix, term } = useMemo(() => parsePrefix(search), [search]);

  const filteredByPrefix = useMemo(() => {
    if (prefix === '#') return items.filter((i) => i.type === 'room');
    if (prefix === '@') return items.filter((i) => i.type === 'agent' || i.type === 'dm');
    if (prefix === '>') return items.filter((i) => i.type === 'command');
    return items;
  }, [items, prefix]);

  const fuse = useMemo(() => new Fuse(filteredByPrefix, FUSE_OPTIONS), [filteredByPrefix]);

  const results: SearchResult[] = useMemo(() => {
    if (!term) {
      return filteredByPrefix.map((item) => ({ item, matches: undefined }));
    }
    return fuse.search(term).map((r) => ({ item: r.item, matches: r.matches }));
  }, [fuse, term, filteredByPrefix]);

  return { results, prefix, term };
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
