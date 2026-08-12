/**
 * @vitest-environment jsdom
 *
 * Retiring `dorkos:agent-frecency-v2` (spec `sidebar-now-today-library` P3 AC-4).
 *
 * Two halves, and they fail differently. The **translation** is a pure function
 * over a payload an older release wrote, so it is asserted directly against a
 * realistic one. The **migration** is a hook with a side effect on a real
 * browser store, so it is driven through `renderHook` against jsdom's own
 * `localStorage` — the same storage the shipped code writes to, not a mock of
 * it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  translateLegacyRecords,
  useInteractionStore,
  useLegacyFrecencyMigration,
  type MigratableAgent,
} from '../index';

const LEGACY_KEY = 'dorkos:agent-frecency-v2';
/** The key before that one, which shipped a different record shape. */
const OLDER_KEY = 'dorkos-agent-frecency';

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-08-11T12:00:00.000Z');

const AGENTS: MigratableAgent[] = [
  { id: 'agent-alpha', projectPath: '/repos/alpha' },
  { id: 'agent-beta', projectPath: '/repos/beta' },
  { id: 'agent-gamma', projectPath: '/repos/gamma' },
];

/**
 * A payload the retired hook would really have written.
 *
 * Its shape is the one that shipped: mesh agent ids, at most ten epoch-ms
 * timestamps most-recent-first, and a `totalCount` that keeps counting past
 * them. `beta` is the habit — opened constantly and most recently; `alpha` is
 * frequent but colder; `gamma` was opened once, months ago.
 */
function realisticPayload() {
  return [
    {
      agentId: 'agent-alpha',
      timestamps: [NOW - 30 * HOUR, NOW - 50 * HOUR, NOW - 90 * HOUR],
      totalCount: 14,
    },
    {
      agentId: 'agent-beta',
      timestamps: Array.from({ length: 10 }, (_, i) => NOW - (i + 1) * HOUR),
      totalCount: 63,
    },
    { agentId: 'agent-gamma', timestamps: [NOW - 90 * 24 * HOUR], totalCount: 1 },
  ];
}

function seedLegacy(payload: unknown): void {
  localStorage.setItem(LEGACY_KEY, JSON.stringify(payload));
}

beforeEach(() => {
  localStorage.clear();
  useInteractionStore.getState().reset();
});

describe('translateLegacyRecords', () => {
  it('keys each record by the agent DIRECTORY, which is what the new store ranks by', () => {
    expect(translateLegacyRecords(realisticPayload(), AGENTS)).toEqual([
      { key: 'agent:/repos/alpha', lastUsedAt: NOW - 30 * HOUR, useCount: 14 },
      { key: 'agent:/repos/beta', lastUsedAt: NOW - HOUR, useCount: 63 },
      { key: 'agent:/repos/gamma', lastUsedAt: NOW - 90 * 24 * HOUR, useCount: 1 },
    ]);
  });

  it('takes the newest stamp, not the first one it happens to read', () => {
    // The retired store wrote most-recent-first, but nothing enforced it. A
    // payload written out of order must not report an old open as the newest.
    const shuffled = [
      { agentId: 'agent-alpha', timestamps: [NOW - 90 * HOUR, NOW], totalCount: 2 },
    ];
    expect(translateLegacyRecords(shuffled, AGENTS)[0]?.lastUsedAt).toBe(NOW);
  });

  it('drops a record whose agent this cockpit no longer knows', () => {
    const gone = [{ agentId: 'agent-vanished', timestamps: [NOW], totalCount: 3 }];
    expect(translateLegacyRecords(gone, AGENTS)).toEqual([]);
  });

  it('drops a record with no timestamps at all rather than inventing one', () => {
    const empty = [{ agentId: 'agent-alpha', timestamps: [], totalCount: 5 }];
    expect(translateLegacyRecords(empty, AGENTS)).toEqual([]);
  });
});

describe('P3 AC-4 — no loss of ranking for agents the user already uses', () => {
  /**
   * The frecency order the retired store produced for this payload, by hand.
   *
   * `beta` opened 63 times and an hour ago; `alpha` 14 times and 30 hours ago;
   * `gamma` once, ninety days ago. Every ranking either store computes has to
   * agree on that order, and this is the claim AC-4 is written in terms of.
   */
  const EXPECTED_ORDER = ['agent:/repos/beta', 'agent:/repos/alpha', 'agent:/repos/gamma'];

  it('migrates a realistic payload with the agent order unchanged', () => {
    seedLegacy(realisticPayload());
    renderHook(() => useLegacyFrecencyMigration(AGENTS));

    const { opened, counts } = useInteractionStore.getState();
    const ranked = Object.keys(counts).sort((a, b) => {
      // The same two facts the palette's own scorer blends, in the same
      // direction — how often, then how recently.
      const byCount = (counts[b] ?? 0) - (counts[a] ?? 0);
      if (byCount !== 0) return byCount;
      return Date.parse(opened[b] ?? '') - Date.parse(opened[a] ?? '');
    });
    expect(ranked).toEqual(EXPECTED_ORDER);
  });

  it('carries the counts across, so a habit is still a habit', () => {
    seedLegacy(realisticPayload());
    renderHook(() => useLegacyFrecencyMigration(AGENTS));

    // The number, not merely "some count": the retired store counted past the
    // ten timestamps it kept, and reading the count off `timestamps.length`
    // would have turned 63 opens into 10 and levelled beta with alpha.
    expect(useInteractionStore.getState().counts['agent:/repos/beta']).toBe(63);
  });

  it('does not overwrite an open this store already recorded more recently', () => {
    useInteractionStore.getState().recordOpened('agent', '/repos/gamma', NOW);
    seedLegacy(realisticPayload());
    renderHook(() => useLegacyFrecencyMigration(AGENTS));

    expect(Date.parse(useInteractionStore.getState().opened['agent:/repos/gamma'] ?? '')).toBe(NOW);
  });
});

describe('the key is retired, not abandoned', () => {
  it('removes the old key once it has been read', () => {
    seedLegacy(realisticPayload());
    renderHook(() => useLegacyFrecencyMigration(AGENTS));

    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it('sweeps the even older key it superseded', () => {
    localStorage.setItem(OLDER_KEY, JSON.stringify([{ agentId: 'old', useCount: 10 }]));
    localStorage.setItem('dorkos:ui:theme', 'dark');
    renderHook(() => useLegacyFrecencyMigration(AGENTS));

    expect(localStorage.getItem(OLDER_KEY)).toBeNull();
    // The negative control: it sweeps two named keys, not everything it finds.
    expect(localStorage.getItem('dorkos:ui:theme')).toBe('dark');
  });

  it('does not run a second time, even when the effect is asked to re-run', () => {
    seedLegacy(realisticPayload());
    // A FRESH array each render, so the effect's dependency identity moves and
    // React re-runs it. Rerendering with the same array would leave the effect
    // dormant and this case would pass with the latch deleted — which is
    // exactly what it did before the mutation `M5` caught it.
    const { rerender } = renderHook(
      ({ agents }: { agents: MigratableAgent[] }) => useLegacyFrecencyMigration(agents),
      { initialProps: { agents: [...AGENTS] } }
    );
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();

    // A second tab writing the key again after this one migrated. The hook has
    // already done its one job and must not re-read it.
    seedLegacy([{ agentId: 'agent-alpha', timestamps: [NOW], totalCount: 999 }]);
    rerender({ agents: [...AGENTS] });

    expect(useInteractionStore.getState().counts['agent:/repos/alpha']).toBe(14);
    expect(localStorage.getItem(LEGACY_KEY)).not.toBeNull();
  });

  it('holds off while the roster has not answered, rather than deleting what it cannot read', () => {
    seedLegacy(realisticPayload());
    renderHook(() => useLegacyFrecencyMigration([]));

    // Nothing translated and nothing lost: a mesh id has no directory to land
    // on until the roster is in.
    expect(localStorage.getItem(LEGACY_KEY)).not.toBeNull();
    expect(useInteractionStore.getState().counts).toEqual({});
  });

  it('migrates on the render after the roster arrives', () => {
    seedLegacy(realisticPayload());
    const { rerender } = renderHook(
      ({ agents }: { agents: MigratableAgent[] }) => useLegacyFrecencyMigration(agents),
      { initialProps: { agents: [] as MigratableAgent[] } }
    );
    expect(localStorage.getItem(LEGACY_KEY)).not.toBeNull();

    rerender({ agents: AGENTS });

    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(useInteractionStore.getState().counts['agent:/repos/beta']).toBe(63);
  });
});

describe('two tabs, one migration', () => {
  it('converges when both tabs read the same payload before either deletes it', () => {
    // The half-written case. Tab A and tab B both mount with the key present;
    // A translates and merges, B was already holding the same payload and
    // merges it after. `mergeUsage` takes the larger of each field, so the
    // second application changes nothing — where a sum would have reported
    // this person as opening beta 126 times.
    const payload = realisticPayload();
    seedLegacy(payload);
    renderHook(() => useLegacyFrecencyMigration(AGENTS));
    const afterTabA = { ...useInteractionStore.getState().counts };

    // Tab B, which read before the delete and is now committing.
    useInteractionStore.getState().mergeUsage(translateLegacyRecords(payload, AGENTS));

    expect(useInteractionStore.getState().counts).toEqual(afterTabA);
    expect(useInteractionStore.getState().counts['agent:/repos/beta']).toBe(63);
  });

  it('leaves nothing behind when the second tab finds the key already gone', () => {
    seedLegacy(realisticPayload());
    renderHook(() => useLegacyFrecencyMigration(AGENTS));
    const afterTabA = { ...useInteractionStore.getState().counts };

    // Tab B mounts after the delete: it reads nothing and writes nothing.
    renderHook(() => useLegacyFrecencyMigration(AGENTS));

    expect(useInteractionStore.getState().counts).toEqual(afterTabA);
  });
});

describe('a payload written by something else', () => {
  it.each([
    ['not JSON at all', 'not-json{'],
    ['a JSON object rather than a list', '{"agentId":"agent-alpha"}'],
    ['a list of the wrong shape', '[{"agent":"agent-alpha","count":3}]'],
    ['a record with a non-numeric stamp', '[{"agentId":"a","timestamps":["x"],"totalCount":1}]'],
  ])('survives %s, and still retires the key', (_case, raw) => {
    localStorage.setItem(LEGACY_KEY, raw);

    expect(() => renderHook(() => useLegacyFrecencyMigration(AGENTS))).not.toThrow();
    expect(useInteractionStore.getState().counts).toEqual({});
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it('rejects a malformed record for an agent the roster DOES know', () => {
    // The case above is vacuous on its own, and that was measured: every id in
    // it (`a`, `agent-alpha` inside a non-list) is one `translateLegacyRecords`
    // drops at the roster lookup, so deleting `isLegacyRecord` entirely left all
    // four green. This one names a real agent, so the roster gate cannot absorb
    // it and the shape guard is the only thing standing between a `"x"`
    // timestamp and a persisted `NaN`.
    localStorage.setItem(
      LEGACY_KEY,
      JSON.stringify([
        { agentId: 'agent-alpha', timestamps: ['x'], totalCount: 4 },
        { agentId: 'agent-beta', timestamps: [NOW], totalCount: 'lots' },
      ])
    );

    expect(() => renderHook(() => useLegacyFrecencyMigration(AGENTS))).not.toThrow();

    // Nothing was written for either — not a `NaN` count, not an "Invalid Date"
    // stamp, which is what the unguarded path produces.
    expect(useInteractionStore.getState().counts).toEqual({});
    expect(useInteractionStore.getState().opened).toEqual({});
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it('keeps the good records in a payload that also holds a bad one', () => {
    // Rejecting the whole file because one record rotted would be the same data
    // loss the migration exists to avoid.
    localStorage.setItem(
      LEGACY_KEY,
      JSON.stringify([
        { agentId: 'agent-alpha', timestamps: ['x'], totalCount: 4 },
        { agentId: 'agent-beta', timestamps: [NOW - HOUR], totalCount: 63 },
      ])
    );

    renderHook(() => useLegacyFrecencyMigration(AGENTS));

    expect(useInteractionStore.getState().counts).toEqual({ 'agent:/repos/beta': 63 });
  });
});
