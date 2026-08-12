/**
 * The gate on ⌘K's hand-off row (P3 AC-6).
 *
 * @module features/command-palette/model/__tests__/search-surface
 */
import { describe, it, expect } from 'vitest';
import { APP_ROUTE_PATHS } from '@/layers/shared/lib';
import { SEARCH_SURFACE_PATH, searchHandoffHref } from '../search-surface';

describe('the hand-off to a message-search surface', () => {
  it('offers nothing while this cockpit serves no such surface', () => {
    // Read off the real registry rather than a copy of it: the claim is about
    // what SHIPS, and a literal list here would go on passing after the route
    // landed.
    expect(APP_ROUTE_PATHS).not.toContain(SEARCH_SURFACE_PATH);
    expect(searchHandoffHref('dash')).toBeNull();
  });

  it('offers it the moment the cockpit serves one — the check is not a constant `false`', () => {
    const href = searchHandoffHref('dash', [...APP_ROUTE_PATHS, SEARCH_SURFACE_PATH]);
    expect(href).toBe('/search?q=dash');
  });

  it('carries the words a person typed, whatever is in them', () => {
    const routes = [...APP_ROUTE_PATHS, SEARCH_SURFACE_PATH];
    // A query is arbitrary text and lands in a URL. `&`, `=` and `#` all mean
    // something there, and none of them may split the query in half.
    expect(searchHandoffHref('a&b=c#d', routes)).toBe('/search?q=a%26b%3Dc%23d');
    expect(searchHandoffHref('two words', routes)).toBe('/search?q=two%20words');
  });

  it('offers nothing to search for nothing', () => {
    const routes = [...APP_ROUTE_PATHS, SEARCH_SURFACE_PATH];
    // `Search messages for ""…` is a row that offers to look for nothing, and
    // whitespace is the same thing wearing a disguise.
    expect(searchHandoffHref('', routes)).toBeNull();
    expect(searchHandoffHref('   ', routes)).toBeNull();
  });

  it('trims what it sends, so a trailing space is not part of the question', () => {
    expect(searchHandoffHref('  dash  ', [...APP_ROUTE_PATHS, SEARCH_SURFACE_PATH])).toBe(
      '/search?q=dash'
    );
  });

  it('is not satisfied by some OTHER route existing', () => {
    // The check has to be about this surface and no other. Every path the
    // cockpit already serves is offered here, one at a time.
    for (const path of APP_ROUTE_PATHS) {
      expect(searchHandoffHref('dash', [path]), path).toBeNull();
    }
  });
});
