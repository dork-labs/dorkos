/**
 * The single mapping from stored sidebar prefs to the model's view of them.
 *
 * Two properties matter and neither is "it copies the fields": the result is
 * TOTAL whatever the input was missing (an install whose conf migration has not
 * run hands back an object with whole blocks absent), and membership lists come
 * out canonical so the model never meets the pre-DOR-579 bare-path encoding.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { SIDEBAR_PREFS_DEFAULTS } from '@dorkos/shared/config-schema';
import type { SidebarPrefs } from '@dorkos/shared/config-schema';
import { toSidebarModelPrefs } from '../model/sidebar-model-prefs';
import type { SidebarModelPrefs } from '../model/sidebar-model-prefs';

/** Prefs as the schema guarantees them, with the given overrides applied. */
function prefs(overrides: Partial<SidebarPrefs> = {}): SidebarPrefs {
  return { ...structuredClone(SIDEBAR_PREFS_DEFAULTS), ...overrides };
}

describe('toSidebarModelPrefs', () => {
  it('maps a fully-populated prefs object field for field', () => {
    const stored = prefs({
      pinned: [{ kind: 'agent', path: '/a' }],
      groups: [
        {
          id: 'g1',
          name: 'Clients',
          items: [{ kind: 'room', roomId: '01JROOM' }],
          sortMode: 'manual',
          collapsed: false,
          displayFilter: 'all',
          muted: false,
          kind: 'manual',
        },
      ],
      muted: [{ kind: 'room', roomId: '01JNOISY' }],
      sections: { agents: { collapsed: true, sortMode: 'recent', displayFilter: 'active' } },
      gettingStarted: { retired: ['suggestion:groups-hint'] },
      digest: { lastShownDate: '2026-08-09' },
    });

    expect(toSidebarModelPrefs(stored)).toEqual({
      pinned: [{ kind: 'agent', path: '/a' }],
      groups: stored.groups,
      muted: [{ kind: 'room', roomId: '01JNOISY' }],
      sections: { agents: { collapsed: true, sortMode: 'recent', displayFilter: 'active' } },
      gettingStarted: { retired: ['suggestion:groups-hint'] },
      digest: { lastShownDate: '2026-08-09' },
    } satisfies SidebarModelPrefs);
  });

  it('maps the shipped defaults to an empty view, not to undefined blocks', () => {
    expect(toSidebarModelPrefs(SIDEBAR_PREFS_DEFAULTS)).toEqual({
      pinned: [],
      groups: [],
      muted: [],
      sections: {},
      gettingStarted: { retired: [] },
      digest: { lastShownDate: undefined },
    });
  });

  // The table below is the whole point of the function: each row is a block a
  // pre-migration install can hand back absent, and the model must never have to
  // check for it. `as unknown as SidebarPrefs` is deliberate — the TYPE says
  // these are present and the WIRE says otherwise, which is exactly the gap.
  const missingBlocks: { name: string; stored: unknown; expected: Partial<SidebarModelPrefs> }[] = [
    {
      name: 'no sections',
      stored: { ...SIDEBAR_PREFS_DEFAULTS, sections: undefined },
      expected: { sections: {} },
    },
    {
      name: 'no gettingStarted',
      stored: { ...SIDEBAR_PREFS_DEFAULTS, gettingStarted: undefined },
      expected: { gettingStarted: { retired: [] } },
    },
    {
      name: 'gettingStarted with no retired list',
      stored: { ...SIDEBAR_PREFS_DEFAULTS, gettingStarted: {} },
      expected: { gettingStarted: { retired: [] } },
    },
    {
      name: 'no digest',
      stored: { ...SIDEBAR_PREFS_DEFAULTS, digest: undefined },
      expected: { digest: {} },
    },
    {
      name: 'no pinned',
      stored: { ...SIDEBAR_PREFS_DEFAULTS, pinned: undefined },
      expected: { pinned: [] },
    },
    {
      name: 'no groups',
      stored: { ...SIDEBAR_PREFS_DEFAULTS, groups: undefined },
      expected: { groups: [] },
    },
    {
      name: 'no muted',
      stored: { ...SIDEBAR_PREFS_DEFAULTS, muted: undefined },
      expected: { muted: [] },
    },
  ];

  it.each(missingBlocks)('fills in a view for a config with $name', ({ stored, expected }) => {
    const view = toSidebarModelPrefs(stored as SidebarPrefs);
    expect(view).toMatchObject(expected);
    // Totality, asserted as a whole rather than one key at a time.
    for (const key of [
      'pinned',
      'groups',
      'muted',
      'sections',
      'gettingStarted',
      'digest',
    ] as const) {
      expect(view[key]).toBeDefined();
    }
  });

  it('never mutates what it was given', () => {
    const stored = prefs({ sections: { channels: { collapsed: true } } });
    const snapshot = structuredClone(stored);
    toSidebarModelPrefs(stored);
    expect(stored).toEqual(snapshot);
  });
});
