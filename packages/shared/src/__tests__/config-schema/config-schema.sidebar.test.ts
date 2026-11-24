import { describe, it, expect } from 'vitest';
import {
  UserConfigSchema,
  SidebarGroupSchema,
  SidebarPrefsSchema,
  SidebarItemRefSchema,
  sameSidebarItem,
  toSidebarItemRef,
} from '../../config-schema.js';
import type {} from '../../config-schema.js';

describe('SidebarItemRefSchema + sameSidebarItem (sidebar-groups, DOR-579)', () => {
  it('keeps an agent path containing a colon intact', () => {
    // The reason this is a union and not an "agent:<path>" string: a colon is
    // legal in a POSIX path, so a prefixed string would need a
    // parse-on-first-colon rule that breaks on exactly this input.
    const ref = SidebarItemRefSchema.parse({ kind: 'agent', path: '/projects/a:b' });
    expect(ref).toEqual({ kind: 'agent', path: '/projects/a:b' });
  });

  it('rejects a missing discriminator, an unknown kind, and a mismatched payload', () => {
    expect(() => SidebarItemRefSchema.parse({ path: '/a' })).toThrow();
    expect(() => SidebarItemRefSchema.parse({ kind: 'session', id: 's1' })).toThrow();
    expect(() => SidebarItemRefSchema.parse({ kind: 'agent', roomId: '01JXYZ' })).toThrow();
    expect(() => SidebarItemRefSchema.parse({ kind: 'room', path: '/a' })).toThrow();
  });

  it('sameSidebarItem is false across kinds and across payloads', () => {
    expect(sameSidebarItem({ kind: 'agent', path: '/a' }, { kind: 'agent', path: '/b' })).toBe(
      false
    );
    expect(sameSidebarItem({ kind: 'room', roomId: 'r1' }, { kind: 'room', roomId: 'r2' })).toBe(
      false
    );
    expect(sameSidebarItem({ kind: 'agent', path: 'r1' }, { kind: 'room', roomId: 'r1' })).toBe(
      false
    );
  });
});

describe('toSidebarItemRef — what a stored membership string means', () => {
  const agent = (path: string) => ({ kind: 'agent' as const, path });

  it('wraps a legacy path and passes a reference through', () => {
    // The migration is the only caller left: the read-time conversion beside it
    // was removed a release on (DOR-588). What this still pins is the mapping —
    // every pre-DOR-579 string IS an agent path, and a reference is untouched.
    expect(toSidebarItemRef('/projects/alpha')).toEqual(agent('/projects/alpha'));
    const ref = agent('/projects/alpha');
    expect(toSidebarItemRef(ref)).toBe(ref);
    const room = { kind: 'room' as const, roomId: '01JROOM' };
    expect(toSidebarItemRef(room)).toBe(room);
  });
});

describe('UserConfigSchema ui.sidebar (DOR-329)', () => {
  it('drops the eight fields the sidebar redesign retired', () => {
    // Zod strips unknown keys, so a stored config carrying the pre-redesign
    // shape parses — and comes back WITHOUT it. The conf migration is the only
    // thing that carries the values across; nothing here reads them.
    const parsed = SidebarPrefsSchema.parse({
      ungroupedSortMode: 'recent',
      ungroupedCollapsed: true,
      recentsCollapsed: true,
      channelsCollapsed: true,
      dmsCollapsed: true,
      threadsCollapsed: true,
      groupsHintDismissed: true,
      ungroupedDisplayFilter: 'active',
    }) as Record<string, unknown>;
    for (const retired of [
      'ungroupedSortMode',
      'ungroupedCollapsed',
      'recentsCollapsed',
      'channelsCollapsed',
      'dmsCollapsed',
      'threadsCollapsed',
      'groupsHintDismissed',
      'ungroupedDisplayFilter',
    ]) {
      expect(retired in parsed).toBe(false);
    }
  });

  it('DROPS a section id it has never heard of, rather than refusing the config', () => {
    // The whole forward-compatibility story. An unknown key must not be an
    // error, because `applyConfigPatch` re-validates the WHOLE config on every
    // write: refusing here would make a config that merely LOADS unwritable
    // forever. This is what lets P2 retire `threads`/`recents` from the enum
    // with no second migration and no user-visible failure.
    const prefs = SidebarPrefsSchema.parse({
      sections: { channels: { collapsed: true }, nowhere: { collapsed: true } },
    });
    expect(prefs.sections).toEqual({ channels: { collapsed: true } });
  });

  it('needs no migration to accept them, in either direction', () => {
    // **Why this widening ships without a conf migration.** Nothing on disk
    // changes shape: a config written before D1 simply has no key for these
    // three, and an absent section is already "not folded". Forward, the record
    // now accepts them; backward, `dropUnknownSectionIds` strips a key an older
    // build has never heard of, so a downgrade loses a fold flag rather than
    // producing a config that loads and then refuses every subsequent write.
    //
    // Both halves asserted, because it is the PAIR that makes a migration
    // unnecessary — one alone would leave the other direction to chance.
    const untouched = SidebarPrefsSchema.parse({ sections: { channels: { collapsed: true } } });
    expect(untouched.sections.channels).toEqual({ collapsed: true });
    expect(untouched.sections.now).toBeUndefined();

    const fromNewerBuild = SidebarPrefsSchema.parse({
      sections: { 'getting-started': { collapsed: true }, aZoneFromTheFuture: { collapsed: true } },
    });
    expect(fromNewerBuild.sections).toEqual({ 'getting-started': { collapsed: true } });
  });

  it('keeps what it was given when there is nothing to drop', () => {
    const stored = { channels: { collapsed: true } };
    expect(SidebarPrefsSchema.parse({ sections: stored }).sections).toEqual(stored);
  });

  it('keeps a retired suggestion id that no longer names a live suggestion', () => {
    // `suggestion:groups-hint` is the card the groups hint became. The list is
    // a history, so a narrowed suggestion set must never invalidate it.
    const prefs = SidebarPrefsSchema.parse({
      gettingStarted: { retired: ['suggestion:groups-hint'] },
    });
    expect(prefs.gettingStarted.retired).toEqual(['suggestion:groups-hint']);
  });
});

describe('SidebarDisplayFilterSchema + display filter / mute fields (DOR-339)', () => {
  it('an existing (pre-DOR-339) legacy sidebar object still parses, picking up the new defaults', () => {
    const legacy = {
      pinned: [{ kind: 'agent', path: '/a' }],
      groups: [
        {
          id: 'g1',
          name: 'Clients',
          items: [{ kind: 'agent', path: '/a' }],
          sortMode: 'manual',
        },
      ],
    };
    const result = UserConfigSchema.parse({ version: 1, ui: { sidebar: legacy } });
    expect(result.ui.sidebar.muted).toEqual([]);
    expect(result.ui.sidebar.sections).toEqual({});
    expect(result.ui.sidebar.groups[0]).toEqual({
      id: 'g1',
      name: 'Clients',
      items: [{ kind: 'agent', path: '/a' }],
      sortMode: 'manual',
      collapsed: false,
      displayFilter: 'all',
      muted: false,
      kind: 'manual',
    });
  });
});

describe('SmartGroupRulesSchema + SidebarGroupSchema kind/rules (smart-agent-groups, DOR-338)', () => {
  it('rejects a smart group with an empty rules object', () => {
    expect(() =>
      SidebarGroupSchema.parse({
        id: 'g1',
        name: 'Empty',
        kind: 'smart',
        sortMode: 'recent',
        rules: {},
      })
    ).toThrow(/at least one rule constraint/);
  });

  it('a legacy (pre-DOR-338) stored group without kind/rules still parses, defaulting to manual', () => {
    const legacy = {
      id: 'g1',
      name: 'Clients',
      items: [{ kind: 'agent', path: '/a' }],
      sortMode: 'manual',
      collapsed: false,
      displayFilter: 'all',
      muted: false,
    };
    const result = UserConfigSchema.parse({
      version: 1,
      ui: { sidebar: { groups: [legacy] } },
    });
    expect(result.ui.sidebar.groups[0]?.kind).toBe('manual');
  });
});
