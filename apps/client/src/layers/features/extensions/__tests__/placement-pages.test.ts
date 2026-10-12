import { describe, expect, it } from 'vitest';
import { APP_ROUTE_PATHS } from '@dorkos/shared/app-route-paths';
import { pageKeyForPath } from '@dorkos/shared/mini-app-placement';
import { PLACEMENT_PAGES, placementPageLabel } from '../lib/placement-pages';

describe('PLACEMENT_PAGES', () => {
  it('offers only pages the router really has', () => {
    const routeKeys = new Set(APP_ROUTE_PATHS.map((path) => pageKeyForPath(path)));
    for (const page of PLACEMENT_PAGES) expect(routeKeys).toContain(page.key);
  });

  it('names each key once', () => {
    const keys = PLACEMENT_PAGES.map((page) => page.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('names the wildcard and add-on pages, and falls back to the key otherwise', () => {
    expect(placementPageLabel('session')).toBe('Every chat');
    expect(placementPageLabel('x/social-queue')).toBe('Add-on page social-queue');
    expect(placementPageLabel('*')).toBe('Everywhere');
    expect(placementPageLabel('somewhere')).toBe('somewhere');
  });
});
