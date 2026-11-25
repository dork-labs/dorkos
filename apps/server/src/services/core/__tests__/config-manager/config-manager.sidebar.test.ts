import { describe, it, expect } from 'vitest';
import { UserConfigSchema } from '@dorkos/shared/config-schema';
import {
  migrateSidebarMembersToItemRefs,
  migrateSidebarSectionPrefs,
  GROUPS_HINT_SUGGESTION_ID,
  CONFIG_MIGRATIONS,
} from '../../config-manager.js';
import { createMockStore } from './config-manager.fixtures.js';

describe('migrateSidebarMembersToItemRefs migration (sidebar-groups, DOR-579)', () => {
  /** The exact `ui.sidebar` shape on disk before DOR-579: three lists of paths. */
  function priorShapeUi() {
    return {
      theme: 'dark',
      sidebar: {
        pinned: ['/projects/alpha', '/projects/beta'],
        groups: [
          {
            id: 'g1',
            name: 'Clients',
            agentPaths: ['/projects/alpha', '/projects/gamma'],
            sortMode: 'manual',
            collapsed: false,
            displayFilter: 'all',
            muted: false,
            kind: 'manual',
          },
          {
            id: 'g2',
            name: 'Active now',
            agentPaths: [],
            sortMode: 'recent',
            collapsed: false,
            displayFilter: 'all',
            muted: false,
            kind: 'smart',
            rules: { statuses: ['active'] },
          },
        ],
        ungroupedSortMode: 'name',
        ungroupedCollapsed: false,
        recentsCollapsed: false,
        channelsCollapsed: false,
        dmsCollapsed: false,
        threadsCollapsed: false,
        groupsHintDismissed: false,
        muted: ['/projects/beta'],
        ungroupedDisplayFilter: 'all',
      },
    };
  }

  /** The same config after conversion — every string wrapped as an agent ref. */
  const CONVERTED_SIDEBAR = {
    pinned: [
      { kind: 'agent', path: '/projects/alpha' },
      { kind: 'agent', path: '/projects/beta' },
    ],
    groups: [
      {
        id: 'g1',
        name: 'Clients',
        items: [
          { kind: 'agent', path: '/projects/alpha' },
          { kind: 'agent', path: '/projects/gamma' },
        ],
        sortMode: 'manual',
        collapsed: false,
        displayFilter: 'all',
        muted: false,
        kind: 'manual',
      },
      {
        id: 'g2',
        name: 'Active now',
        items: [],
        sortMode: 'recent',
        collapsed: false,
        displayFilter: 'all',
        muted: false,
        kind: 'smart',
        rules: { statuses: ['active'] },
      },
    ],
    ungroupedSortMode: 'name',
    ungroupedCollapsed: false,
    recentsCollapsed: false,
    channelsCollapsed: false,
    dmsCollapsed: false,
    threadsCollapsed: false,
    groupsHintDismissed: false,
    muted: [{ kind: 'agent', path: '/projects/beta' }],
    ungroupedDisplayFilter: 'all',
  };

  it('converts all three lists and renames agentPaths -> members', () => {
    const store = createMockStore({ ui: priorShapeUi() });
    migrateSidebarMembersToItemRefs(store);
    expect(store.data.ui).toEqual({ theme: 'dark', sidebar: CONVERTED_SIDEBAR });
  });

  it('leaves no agentPaths key behind on any group', () => {
    // Not cosmetic: the generated JSON Schema closes each group object
    // (`additionalProperties: false`), so a leftover key fails conf's
    // post-migration validation and hard-fails startup.
    const store = createMockStore({ ui: priorShapeUi() });
    migrateSidebarMembersToItemRefs(store);
    const groups = (store.data.ui as { sidebar: { groups: Record<string, unknown>[] } }).sidebar
      .groups;
    expect(groups.map((g) => 'agentPaths' in g)).toEqual([false, false]);
  });

  it('produces a shape the schema accepts', () => {
    const store = createMockStore({ ui: priorShapeUi() });
    migrateSidebarMembersToItemRefs(store);
    const parsed = UserConfigSchema.parse({ version: 1, ui: store.data.ui });
    // Not `toEqual(CONVERTED_SIDEBAR)`: this migration predates the sidebar
    // redesign, so its output still carries the eight per-section keys that
    // release retired, and Zod strips them here. What this test is about — the
    // three converted membership lists — is unaffected either way.
    expect(parsed.ui.sidebar.pinned).toEqual(CONVERTED_SIDEBAR.pinned);
    expect(parsed.ui.sidebar.groups).toEqual(CONVERTED_SIDEBAR.groups);
    expect(parsed.ui.sidebar.muted).toEqual(CONVERTED_SIDEBAR.muted);
  });

  it('a second run is a no-op — same value, and no write at all', () => {
    const store = createMockStore({ ui: priorShapeUi() });
    migrateSidebarMembersToItemRefs(store);
    const afterFirst = store.data.ui;

    migrateSidebarMembersToItemRefs(store);
    expect(store.data.ui).toEqual({ theme: 'dark', sidebar: CONVERTED_SIDEBAR });
    // `store.set` replaces `data.ui` wholesale, so an unchanged object identity
    // is proof the second run never wrote.
    expect(store.data.ui).toBe(afterFirst);
  });

  it('is a no-op on a fresh install (no ui, or a ui with no sidebar)', () => {
    const noUi = createMockStore({ server: { port: 4242 } });
    migrateSidebarMembersToItemRefs(noUi);
    expect(noUi.data.ui).toBeUndefined();

    const noSidebar = createMockStore({ ui: { theme: 'dark' } });
    const before = noSidebar.data.ui;
    migrateSidebarMembersToItemRefs(noSidebar);
    expect(noSidebar.data.ui).toBe(before);
  });

  it('is a no-op on an empty-but-present sidebar', () => {
    const store = createMockStore({
      ui: { theme: 'dark', sidebar: { pinned: [], groups: [], muted: [] } },
    });
    const before = store.data.ui;
    migrateSidebarMembersToItemRefs(store);
    expect(store.data.ui).toBe(before);
  });

  it('still renames an EMPTY agentPaths list (the key itself must go)', () => {
    const store = createMockStore({
      ui: {
        sidebar: {
          pinned: [],
          groups: [{ id: 'g1', name: 'Empty', agentPaths: [] }],
          muted: [],
        },
      },
    });
    migrateSidebarMembersToItemRefs(store);
    expect((store.data.ui as { sidebar: { groups: unknown[] } }).sidebar.groups).toEqual([
      { id: 'g1', name: 'Empty', items: [] },
    ]);
  });

  it('keeps an existing members list and drops a residual agentPaths beside it', () => {
    const store = createMockStore({
      ui: {
        sidebar: {
          pinned: [],
          groups: [
            {
              id: 'g1',
              name: 'Clients',
              items: [{ kind: 'room', roomId: 'room-1' }],
              agentPaths: ['/projects/stale'],
            },
          ],
          muted: [],
        },
      },
    });
    migrateSidebarMembersToItemRefs(store);
    expect((store.data.ui as { sidebar: { groups: unknown[] } }).sidebar.groups).toEqual([
      { id: 'g1', name: 'Clients', items: [{ kind: 'room', roomId: 'room-1' }] },
    ]);
  });

  it('converts a half-migrated list without duplicating the refs already in it', () => {
    const store = createMockStore({
      ui: {
        sidebar: {
          pinned: [{ kind: 'agent', path: '/projects/alpha' }, '/projects/beta'],
          groups: [],
          muted: [],
        },
      },
    });
    migrateSidebarMembersToItemRefs(store);
    expect((store.data.ui as { sidebar: { pinned: unknown[] } }).sidebar.pinned).toEqual([
      { kind: 'agent', path: '/projects/alpha' },
      { kind: 'agent', path: '/projects/beta' },
    ]);
  });

  it('runs from the 0.57.0 composite — the release that ships this schema', () => {
    // The whole point of composing into 0.57.0 rather than opening 0.58.0:
    // `conf` only runs keys in `(storedVersion, projectVersion]`, so a 0.58.0
    // body would not run on the 0.57.0 release carrying `items`, and every
    // upgraded install would read the Zod default `[]` and lose its groups.
    const store = createMockStore({ ui: priorShapeUi() });
    CONFIG_MIGRATIONS['0.57.0'](store);
    expect((store.data.ui as { sidebar: unknown }).sidebar).toMatchObject({
      pinned: CONVERTED_SIDEBAR.pinned,
      muted: CONVERTED_SIDEBAR.muted,
      groups: CONVERTED_SIDEBAR.groups,
    });
  });
});

describe('migrateSidebarSectionPrefs migration (sidebar-now-today-library §D)', () => {
  /**
   * The exact `ui.sidebar` on disk before the redesign, with EVERY retired key
   * set to something the person chose — not to its default. A fixture of
   * defaults would pass a migration that dropped the lot on the floor.
   */
  function priorSidebar(): Record<string, unknown> {
    return {
      pinned: [{ kind: 'agent', path: '/projects/alpha' }],
      groups: [
        {
          id: 'g1',
          name: 'Clients',
          items: [{ kind: 'agent', path: '/projects/alpha' }],
          sortMode: 'manual',
          collapsed: true,
          displayFilter: 'attention',
          muted: true,
          kind: 'manual',
        },
      ],
      ungroupedSortMode: 'recent',
      ungroupedCollapsed: true,
      recentsCollapsed: true,
      channelsCollapsed: true,
      dmsCollapsed: true,
      threadsCollapsed: true,
      groupsHintDismissed: true,
      muted: [{ kind: 'agent', path: '/projects/beta' }],
      ungroupedDisplayFilter: 'active',
    };
  }

  /** A store holding {@link priorSidebar} under a realistic `ui` block. */
  function seeded() {
    return createMockStore({ ui: { theme: 'dark', sidebar: priorSidebar() } });
  }

  /** The `ui.sidebar` a store is holding right now. */
  const sidebarOf = (store: { data: Record<string, unknown> }): Record<string, unknown> =>
    (store.data.ui as { sidebar: Record<string, unknown> }).sidebar;

  it('carries every collapse, sort and filter choice into `sections`', () => {
    const store = seeded();
    migrateSidebarSectionPrefs(store);
    expect(sidebarOf(store).sections).toEqual({
      agents: { collapsed: true, sortMode: 'recent', displayFilter: 'active' },
      channels: { collapsed: true },
      dms: { collapsed: true },
      threads: { collapsed: true },
      recents: { collapsed: true },
    });
  });

  it('translates a dismissed groups hint into a retired suggestion', () => {
    const store = seeded();
    migrateSidebarSectionPrefs(store);
    expect(sidebarOf(store).gettingStarted).toEqual({ retired: [GROUPS_HINT_SUGGESTION_ID] });
  });

  it('leaves nothing of the eight retired keys behind', () => {
    const store = seeded();
    migrateSidebarSectionPrefs(store);
    const after = sidebarOf(store);
    for (const key of [
      'ungroupedCollapsed',
      'channelsCollapsed',
      'dmsCollapsed',
      'threadsCollapsed',
      'recentsCollapsed',
      'ungroupedSortMode',
      'ungroupedDisplayFilter',
      'groupsHintDismissed',
    ]) {
      expect(key in after).toBe(false);
    }
  });

  it('leaves pins, groups and mutes byte-identical', () => {
    // The person's own manual structure. The programme's promise is that it
    // never moves, so this is asserted rather than assumed.
    const store = seeded();
    const before = priorSidebar();
    migrateSidebarSectionPrefs(store);
    const after = sidebarOf(store);
    expect(after.pinned).toEqual(before.pinned);
    expect(after.groups).toEqual(before.groups);
    expect(after.muted).toEqual(before.muted);
  });

  it('is idempotent — a second run writes nothing at all', () => {
    const store = seeded();
    migrateSidebarSectionPrefs(store);
    const afterFirst = structuredClone(store.data);

    const writes: string[] = [];
    const watched = {
      ...store,
      set: (key: string, value: unknown) => {
        writes.push(key);
        store.set(key, value);
      },
    };
    migrateSidebarSectionPrefs(watched);

    expect(writes).toEqual([]);
    expect(store.data).toEqual(afterFirst);
  });

  it('does not clobber a `sections` record that is already there', () => {
    // Migrated, downgraded, upgraded again: `sections` holds choices made SINCE
    // the retired flags were last written, so a stale flag must not win.
    const store = createMockStore({
      ui: {
        sidebar: {
          ...priorSidebar(),
          sections: { channels: { collapsed: false }, agents: { collapsed: false } },
        },
      },
    });
    migrateSidebarSectionPrefs(store);
    const sections = sidebarOf(store).sections as Record<string, unknown>;
    expect(sections.channels).toEqual({ collapsed: false });
    // The existing entry wins on `collapsed`; the fields it did not answer for
    // still come across.
    expect(sections.agents).toEqual({
      collapsed: false,
      sortMode: 'recent',
      displayFilter: 'active',
    });
  });

  it('keeps a suggestion already retired, and never records it twice', () => {
    const store = createMockStore({
      ui: {
        sidebar: {
          ...priorSidebar(),
          gettingStarted: { retired: ['suggestion:ask-dorkbot', GROUPS_HINT_SUGGESTION_ID] },
        },
      },
    });
    migrateSidebarSectionPrefs(store);
    expect(sidebarOf(store).gettingStarted).toEqual({
      retired: ['suggestion:ask-dorkbot', GROUPS_HINT_SUGGESTION_ID],
    });
  });

  it('writes nothing for `groupsHintDismissed: false`', () => {
    const store = createMockStore({
      ui: { sidebar: { pinned: [], groups: [], muted: [], groupsHintDismissed: false } },
    });
    migrateSidebarSectionPrefs(store);
    expect(sidebarOf(store).gettingStarted).toEqual({ retired: [] });
  });

  it('does not carry a value that already equals its old default', () => {
    // A default and an absent key say the same thing on both sides, so copying
    // one would write a block of noise into every config on earth.
    const store = createMockStore({
      ui: {
        sidebar: {
          pinned: [],
          groups: [],
          muted: [],
          ungroupedSortMode: 'name',
          ungroupedCollapsed: false,
          recentsCollapsed: false,
          channelsCollapsed: false,
          dmsCollapsed: false,
          threadsCollapsed: false,
          groupsHintDismissed: false,
          ungroupedDisplayFilter: 'all',
        },
      },
    });
    migrateSidebarSectionPrefs(store);
    expect(sidebarOf(store).sections).toEqual({});
    expect('ungroupedCollapsed' in sidebarOf(store)).toBe(false);
  });

  it('produces a valid `sections` for a config missing some of the old flags', () => {
    // Prove the check can fail on absence rather than throwing: a config that
    // predates one of the flags (say, a pre-DOR-525 sidebar with no room
    // sections at all) still migrates.
    const store = createMockStore({
      ui: { sidebar: { pinned: [], groups: [], muted: [], ungroupedCollapsed: true } },
    });
    expect(() => migrateSidebarSectionPrefs(store)).not.toThrow();
    expect(sidebarOf(store).sections).toEqual({ agents: { collapsed: true } });
  });

  it('is a no-op on a store with no `ui` and on one with no `ui.sidebar`', () => {
    const noUi = createMockStore({});
    migrateSidebarSectionPrefs(noUi);
    expect(noUi.data).toEqual({});

    const noSidebar = createMockStore({ ui: { theme: 'dark' } });
    migrateSidebarSectionPrefs(noSidebar);
    expect(noSidebar.data).toEqual({ ui: { theme: 'dark' } });
  });

  it('leaves every other section of the config alone', () => {
    const store = createMockStore({
      ui: { theme: 'dark', sidebar: priorSidebar() },
      telemetry: { userHasDecided: true, install: false },
    });
    migrateSidebarSectionPrefs(store);
    expect(store.data.telemetry).toEqual({ userHasDecided: true, install: false });
    expect((store.data.ui as { theme: string }).theme).toBe('dark');
  });
});
