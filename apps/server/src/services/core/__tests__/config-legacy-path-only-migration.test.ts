/**
 * The `'0.126.1'` migration marks every extension approval that predates
 * content pins (DOR-3068), so only those are pinned to the files a scan finds,
 * never a digest-less approval written since.
 *
 * @module services/core/__tests__/config-legacy-path-only-migration
 */
import { describe, expect, it } from 'vitest';
import { markLegacyPathOnlyApprovals } from '../config-migrations/v0-90-onward.js';
import { CONFIG_MIGRATIONS } from '../config-migrations/index.js';

/** A minimal conf-like store over one plain object. */
function memoryStore(initial: Record<string, unknown>) {
  const data = structuredClone(initial);
  return {
    data,
    get: (key: string) => data[key],
    set: (key: string, value: unknown) => {
      data[key] = value;
    },
  };
}

describe("the '0.126.1' migration (DOR-3068)", () => {
  it('is the key that runs it', () => {
    expect(CONFIG_MIGRATIONS['0.126.1']).toBe(markLegacyPathOnlyApprovals);
  });

  it('marks only approvals that name no content, and nothing else', () => {
    const store = memoryStore({
      extensions: {
        approvedToRun: ['a', 'b', 'c', 'd'],
        approvedSources: {
          a: { path: '/x/a' },
          b: { path: '/x/b', digest: 'sha256:1' },
          c: { path: '/x/c', authorHome: '/h', grants: 'sha256:2' },
          d: { path: '/x/d', devLink: '/work/d' },
        },
        enabled: [],
      },
    });
    markLegacyPathOnlyApprovals(store);
    const sources = (store.data.extensions as { approvedSources: Record<string, unknown> })
      .approvedSources;
    expect(sources).toEqual({
      a: { path: '/x/a', legacyPathOnly: true },
      b: { path: '/x/b', digest: 'sha256:1' },
      c: { path: '/x/c', authorHome: '/h', grants: 'sha256:2' },
      d: { path: '/x/d', devLink: '/work/d' },
    });
    expect((store.data.extensions as { enabled: unknown }).enabled).toEqual([]);
  });

  it('lists every approved id that names no copy at all, once', () => {
    const store = memoryStore({
      extensions: {
        approvedToRun: ['old', 'sourced'],
        approvedSources: { sourced: { path: '/x/s', digest: 'sha256:1' } },
      },
    });
    markLegacyPathOnlyApprovals(store);
    expect((store.data.extensions as { legacyUnsourced?: string[] }).legacyUnsourced).toEqual([
      'old',
    ]);
    // A second run never re-lists an id bound and dropped from the list since.
    (store.data.extensions as { legacyUnsourced?: string[] }).legacyUnsourced = [];
    markLegacyPathOnlyApprovals(store);
    expect((store.data.extensions as { legacyUnsourced?: string[] }).legacyUnsourced).toEqual([]);
  });

  it('changes nothing on a second run, or with no approvals at all', () => {
    const store = memoryStore({ extensions: { approvedSources: { a: { path: '/x/a' } } } });
    markLegacyPathOnlyApprovals(store);
    const once = JSON.stringify(store.data);
    markLegacyPathOnlyApprovals(store);
    expect(JSON.stringify(store.data)).toBe(once);
    const empty = memoryStore({ ui: {} });
    markLegacyPathOnlyApprovals(empty);
    expect(empty.data).toEqual({ ui: {} });
  });
});
