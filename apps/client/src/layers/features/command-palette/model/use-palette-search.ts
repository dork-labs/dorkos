import Fuse, { type IFuseOptions, type FuseResultMatch } from 'fuse.js';
import { useMemo } from 'react';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';

export interface SearchableItem {
  id: string;
  name: string;
  type: 'agent' | 'feature' | 'command' | 'quick-action' | 'suggestion';
  keywords?: string[];
  data: AgentPathEntry | FeatureItem | CommandItemData | QuickActionItem;
}

export interface SearchResult {
  item: SearchableItem;
  matches: readonly FuseResultMatch[] | undefined;
}

interface FeatureItem {
  id: string;
  label: string;
  icon: string;
  shortcut?: string;
  action: string;
}

interface CommandItemData {
  name: string;
  description?: string;
}

interface QuickActionItem {
  id: string;
  label: string;
  icon: string;
  action: string;
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
 * Prefix @ filters agents only. Prefix > filters commands only.
 * No prefix searches all categories.
 *
 * @param items - All searchable items across categories
 * @param search - Raw search string from the input (may include prefix)
 */
export function usePaletteSearch(items: SearchableItem[], search: string) {
  const { prefix, term } = useMemo(() => parsePrefix(search), [search]);

  const filteredByPrefix = useMemo(() => {
    if (prefix === '@') return items.filter((i) => i.type === 'agent');
    if (prefix === '>') return items.filter((i) => i.type === 'command');
    return items;
  }, [items, prefix]);

  const fuse = useMemo(
    () => new Fuse(filteredByPrefix, FUSE_OPTIONS),
    [filteredByPrefix],
  );

  const results: SearchResult[] = useMemo(() => {
    if (!term) {
      return filteredByPrefix.map((item) => ({ item, matches: undefined }));
    }
    return fuse.search(term).map((r) => ({ item: r.item, matches: r.matches }));
  }, [fuse, term, filteredByPrefix]);

  return { results, prefix, term };
}

/**
 * Parse a prefix character (@, >) from the search string.
 *
 * @internal Exported for testing only.
 */
export function parsePrefix(search: string): { prefix: string | null; term: string } {
  if (search.startsWith('@')) return { prefix: '@', term: search.slice(1) };
  if (search.startsWith('>')) return { prefix: '>', term: search.slice(1) };
  return { prefix: null, term: search };
}
