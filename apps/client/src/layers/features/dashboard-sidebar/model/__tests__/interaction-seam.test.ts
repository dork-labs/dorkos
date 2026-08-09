/**
 * The seam between the interaction store and the model — driven end to end,
 * because a unit mismatch here fails silently and nowhere else.
 *
 * `SidebarState.interactions` is parsed with `Date.parse`. Epoch milliseconds
 * satisfy the `string` type, parse to `NaN`, and are read as "never interacted
 * with" — which does not throw, does not red a unit test on either side, and
 * quietly collapses Today to alphabetical-by-key. Only a test that carries real
 * store output all the way into `buildSidebarModel` can see it.
 *
 * @module features/dashboard-sidebar/model/__tests__/interaction-seam
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useInteractionStore } from '@/layers/entities/interactions';
import { buildSidebarModel } from '../build-sidebar-model';
import { busyFixture, emptyState, session } from '../fixtures';
import { lastInteractionAt } from '../rules/order-today';
import { selectTodayItems } from '../rules/select-today-items';
import type { SidebarState } from '../sidebar-state';

const AGENT = '/Users/dev/code/tangerine';

/** Today's rows for one state. */
function todayRows(state: SidebarState) {
  const zone = buildSidebarModel(state).zones.find((entry) => entry.id === 'today');
  return zone?.sections.flatMap((sectionEntry) => sectionEntry.rows) ?? [];
}

describe('the store feeds the model', () => {
  beforeEach(() => {
    useInteractionStore.getState().reset();
  });

  it('produces an order key the model can actually read', () => {
    const { recordOpened } = useInteractionStore.getState();
    recordOpened('session', 'ses-a', busyFixture.now - 3 * 60 * 60 * 1000);

    const state: SidebarState = emptyState({
      now: busyFixture.now,
      sessions: [session({ id: 'ses-a', title: 'Something', cwd: AGENT })],
      displayNames: { [AGENT]: 'tangerine' },
      // The whole point: the store's own output, unconverted.
      interactions: useInteractionStore.getState().opened,
    });

    const row = selectTodayItems(state)[0];
    expect(row).toBeDefined();
    expect(lastInteractionAt(row as NonNullable<typeof row>, state)).not.toBeNull();
  });

  it('orders three rows by what the operator opened last', () => {
    const { recordOpened } = useInteractionStore.getState();
    const base = busyFixture.now;
    // Recorded out of order on purpose — the ORDER of recording must not matter,
    // only the instants.
    recordOpened('session', 'middle', base - 2 * 60 * 60 * 1000);
    recordOpened('session', 'oldest', base - 5 * 60 * 60 * 1000);
    recordOpened('session', 'newest', base - 1 * 60 * 60 * 1000);

    const state: SidebarState = emptyState({
      now: base,
      sessions: [
        session({ id: 'oldest', title: 'Oldest', cwd: AGENT }),
        session({ id: 'middle', title: 'Middle', cwd: AGENT }),
        session({ id: 'newest', title: 'Newest', cwd: AGENT }),
      ],
      displayNames: { [AGENT]: 'tangerine' },
      interactions: useInteractionStore.getState().opened,
    });

    expect(todayRows(state).map((row) => row.key)).toEqual([
      'session:newest',
      'session:middle',
      'session:oldest',
    ]);
  });

  it('proves the seam test can fail — epoch milliseconds collapse the order', () => {
    const base = busyFixture.now;
    // Exactly what a P2.1 mapping would produce if the store handed out numbers
    // and somebody stringified them. Every key parses to NaN, every row loses
    // its order key, and the list falls back to alphabetical-by-key.
    const state: SidebarState = emptyState({
      now: base,
      sessions: [
        session({ id: 'oldest', title: 'Oldest', cwd: AGENT }),
        session({ id: 'middle', title: 'Middle', cwd: AGENT }),
        session({ id: 'newest', title: 'Newest', cwd: AGENT }),
      ],
      displayNames: { [AGENT]: 'tangerine' },
      interactions: {
        'session:oldest': String(base - 5 * 60 * 60 * 1000),
        'session:middle': String(base - 2 * 60 * 60 * 1000),
        'session:newest': String(base - 1 * 60 * 60 * 1000),
      },
    });

    expect(todayRows(state).map((row) => row.key)).toEqual([
      'session:middle',
      'session:newest',
      'session:oldest',
    ]);
  });
});
