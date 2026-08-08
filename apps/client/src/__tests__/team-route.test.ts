/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import { createAppRouter } from '../router';
import { teamSearchSchema } from '../router';

function router() {
  return createAppRouter(new QueryClient(), createMockTransport() as Transport);
}

/**
 * Run the `/agents` alias's own `beforeLoad` and report the redirect it threw.
 *
 * The alias is one line of route config, so this drives that line directly
 * rather than mounting the app: the assertion is about what the route does with
 * a search object, and a rendered tree would only make the same claim slower.
 */
function redirectFor(searchStr: string) {
  const route = router().routesByPath['/agents'];
  // The alias validates with the destination's schema, so the object its
  // `beforeLoad` receives is the normalized one — which is the whole reason
  // `?view=list` can arrive at `/team` already spelled `table`.
  const search = teamSearchSchema.parse(
    Object.fromEntries(new URLSearchParams(searchStr).entries())
  );
  try {
    route.options.beforeLoad?.({ search } as never);
  } catch (thrown) {
    // `redirect()` returns a `Response` carrying the navigation on `.options`.
    return (
      thrown as { options: { to: string; search: Record<string, unknown>; replace?: boolean } }
    ).options;
  }
  throw new Error('/agents did not redirect');
}

describe('the /team route', () => {
  it('serves /team and keeps /agents only as an alias', () => {
    const paths = Object.keys(router().routesByPath);
    expect(paths).toContain('/team');
    expect(paths).toContain('/agents');
  });

  it('normalizes the old ?view=list address to the table', () => {
    // `/agents?view=list` is the media-capture pipeline's live address. It has
    // to land on a view, not on the default and not on a 404.
    expect(teamSearchSchema.parse({ view: 'list' }).view).toBe('table');
  });

  it('defaults to the cards roster', () => {
    expect(teamSearchSchema.parse({}).view).toBe('cards');
    expect(teamSearchSchema.parse({}).kind).toBe('all');
    expect(teamSearchSchema.parse({}).group).toBe('none');
  });

  it('lands on the roster when a stale URL names something it no longer knows', () => {
    // A URL is hand-editable, bookmarkable, and outlives release notes. A value
    // this route stopped serving is a stale address, not a broken app — it used
    // to throw, and the person got "Something went wrong" over a raw Zod dump.
    const parsed = teamSearchSchema.parse({ view: 'bogus', kind: 'nope', group: 'weird' });

    expect(parsed.view).toBe('cards');
    expect(parsed.kind).toBe('all');
    expect(parsed.group).toBe('none');
  });

  it('keeps the good params when only one of them is stale', () => {
    // Falling back on `view` must not throw away a filter the person set.
    const parsed = teamSearchSchema.parse({ view: 'bogus', kind: 'agents', owner: 'person-1' });

    expect(parsed.view).toBe('cards');
    expect(parsed.kind).toBe('agents');
    expect(parsed.owner).toBe('person-1');
  });
});

describe('the /agents alias', () => {
  it('sends ?view=list to /team?view=table, replacing the entry', () => {
    const redirect = redirectFor('view=list&sort=name%3Aasc');

    expect(redirect.to).toBe('/team');
    expect(redirect.search.view).toBe('table');
    // The whole search object rides along — a redirect that dropped params
    // would silently discard a filtered roster somebody shared.
    expect(redirect.search.sort).toBe('name:asc');
    // `replace`, so Back returns to where the person came from rather than
    // bouncing them through the alias again.
    expect(redirect.replace).toBe(true);
  });

  it('keeps the topology view', () => {
    const redirect = redirectFor('view=topology&agent=abc');

    expect(redirect.to).toBe('/team');
    expect(redirect.search.view).toBe('topology');
    expect(redirect.search.agent).toBe('abc');
  });

  it('carries the roster filters', () => {
    const redirect = redirectFor('view=cards&kind=agents&owner=person-1&group=manager&q=aur');

    expect(redirect.search).toMatchObject({
      view: 'cards',
      kind: 'agents',
      owner: 'person-1',
      group: 'manager',
      q: 'aur',
    });
  });
});
