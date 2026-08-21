/**
 * Library — section order, one indent level, rollups that survive folding, and
 * chrome that appears by data volume (BC-28 → BC-33).
 *
 * @module features/dashboard-sidebar/model/__tests__/library-rules
 */
import { describe, expect, it } from 'vitest';
import type { SidebarGroup } from '@dorkos/shared/config-schema';
import { agentAuthorRef } from '@dorkos/shared/room-schemas';
import {
  buildSidebarModel,
  persistedSectionId,
  SIDEBAR_FOLDING_SECTION_IDS,
  SIDEBAR_LIBRARY_SECTION_IDS,
  type SidebarRowModel,
  type SidebarSectionModel,
} from '../build-sidebar-model';
import {
  agent,
  busyFixture,
  firstRunFixture,
  hoursAgo,
  person,
  powerFixture,
  prefs,
  quietFixture,
  room,
} from '../fixtures';
import {
  AGENT_ROW_FLOOR,
  buildLibrarySections,
  offersGroupAffordances,
} from '../rules/build-library-sections';
import { TODAY_SOFT_CAP } from '../rules/order-today';
import { buildWorkingRollup } from '../rules/build-working-rollup';
import { rollUpCollapsedSection } from '../rules/roll-up-collapsed-section';
import type { SidebarState } from '../sidebar-state';

/** The Library sections of one state. */
function library(state: SidebarState): SidebarSectionModel[] {
  return buildSidebarModel(state).zones.find((zone) => zone.id === 'library')?.sections ?? [];
}

describe('BC-28 — sections and their order', () => {
  it('reads Pins, Channels, Direct messages, Agents', () => {
    expect(library(busyFixture).map((section) => section.id)).toEqual([
      'pins',
      'channels',
      'dms',
      'agents',
    ]);
  });

  it('puts the operator’s own sections FIRST, as peers of the fixed four', () => {
    // What this catches: a regression to the pre-D3 shape, where a hand-made
    // section rendered as a sub-header inside Agents — below every fixed
    // section, and labelled as though it were about agents.
    expect(library(powerFixture).map((section) => section.id)).toEqual([
      'group:group-frontend',
      'group:group-codex',
      'pins',
      'channels',
      'dms',
      'agents',
    ]);
  });

  it('keeps the operator’s stored section order', () => {
    const reordered: SidebarState = {
      ...powerFixture,
      prefs: prefs({
        ...powerFixture.prefs,
        groups: [...powerFixture.prefs.groups].reverse(),
      }),
    };
    expect(
      library(reordered)
        .map((section) => section.id)
        .slice(0, 2)
    ).toEqual(['group:group-codex', 'group:group-frontend']);
  });

  it('evaluates a smart section’s membership live', () => {
    const codex = library(powerFixture).find((section) => section.id === 'group:group-codex');
    expect(codex?.rows.length).toBeGreaterThan(0);
    for (const row of codex?.rows ?? []) {
      const path = row.target.kind === 'agent' ? row.target.path : '';
      expect(powerFixture.agents.find((entry) => entry.path === path)?.runtime).toBe('codex');
    }
  });

  it('takes a manual section’s members out of the ungrouped list', () => {
    const agents = library(powerFixture).find((section) => section.id === 'agents');
    const ungrouped = agents?.rows.map((row) => row.key) ?? [];
    expect(ungrouped).not.toContain('agent:/Users/dev/code/agent-01');
  });

  it('leaves a smart section’s members in the ungrouped list', () => {
    const agents = library(powerFixture).find((section) => section.id === 'agents');
    // A codex agent that is NOT also in the manual Frontend group (agents 0-3),
    // whose membership would remove it for a different reason entirely.
    const codexPath =
      powerFixture.agents.slice(4).find((entry) => entry.runtime === 'codex')?.path ?? '';
    expect(agents?.rows.map((row) => row.key)).toContain(`agent:${codexPath}`);
  });
});

describe('BC-32 — chrome appears by data volume', () => {
  it('has no Direct messages section until a DM exists', () => {
    expect(library(quietFixture).map((section) => section.id)).not.toContain('dms');
    expect(library(busyFixture).map((section) => section.id)).toContain('dms');
  });

  it('has no Pins section until something is pinned', () => {
    expect(library(quietFixture).map((section) => section.id)).not.toContain('pins');
    expect(library(busyFixture).map((section) => section.id)).toContain('pins');
  });

  it('keeps a pinned item in its home section too', () => {
    const pins = library(busyFixture).find((section) => section.id === 'pins');
    const agents = library(busyFixture).find((section) => section.id === 'agents');
    expect(pins?.rows[0]?.key).toBe('agent:/Users/dev/code/tangerine');
    expect(agents?.rows.map((row) => row.key)).toContain('agent:/Users/dev/code/tangerine');
  });

  it('offers grouping at eight agents', () => {
    const seven = Array.from({ length: 7 }, (_, index) => agent(`/a/${index}`));
    expect(offersGroupAffordances(seven)).toBe(false);
    expect(offersGroupAffordances([...seven, agent('/a/8')])).toBe(true);
  });

  it('offers grouping at two runtimes, however few agents', () => {
    expect(
      offersGroupAffordances([
        agent('/a', { runtime: 'claude-code' }),
        agent('/b', { runtime: 'codex' }),
      ])
    ).toBe(true);
  });

  it('offers nothing to an operator with one agent on one runtime', () => {
    expect(offersGroupAffordances([agent('/a')])).toBe(false);
  });
});

describe('BC-31 — a folded section keeps its signal', () => {
  it('sums the directed counts and nothing else', () => {
    const state: SidebarState = {
      ...busyFixture,
      prefs: prefs({ ...busyFixture.prefs, sections: { dms: { collapsed: true } } }),
    };
    const dms = library(state).find((section) => section.id === 'dms');
    expect(dms?.collapsed).toBe(true);
    // Priya's two, and not the 31 unread messages sitting in #noise.
    expect(dms?.rollup?.unread).toEqual({ tier: 'directed', count: 2 });
  });

  it('falls back to activity when a member is unread but nobody was addressed', () => {
    const state: SidebarState = {
      ...busyFixture,
      mentions: {},
      prefs: prefs({ ...busyFixture.prefs, sections: { channels: { collapsed: true } } }),
    };
    const channels = library(state).find((section) => section.id === 'channels');
    expect(channels?.rollup?.unread).toEqual({ tier: 'activity' });
  });

  it('counts the working members', () => {
    expect(
      library(powerFixture).find((section) => section.id === 'channels')?.rollup?.workingCount
    ).toBeGreaterThan(0);
  });

  it('still reports a size when there is no signal, because the size IS the signal', () => {
    // It used to answer `undefined` for a quiet section, so a folded header said
    // nothing about what was behind it. Now that every header in the panel folds
    // (D1), "12" is the minimum a fold owes the person who made it.
    expect(rollUpCollapsedSection([], () => false)).toEqual({
      count: 0,
      unread: { tier: 'none' },
      workingCount: 0,
    });
  });

  describe('a member that starts working while the section is folded', () => {
    // The case no fixture paired until now — a COLLAPSED section whose member
    // is streaming — which is why the defect shipped (DOR-1137, audit D5).
    // Everything BC-31's arithmetic was tested against was a room's `working`
    // field, and rooms carry their count on the summary. Agents do not.
    const SAFFRON = '/Users/dev/code/saffron';

    /** `busyFixture` with Agents folded and one session running in `cwd`. */
    function folded(overrides: Partial<SidebarState>): SidebarState {
      return {
        ...busyFixture,
        // Exactly one working session, so "1" can only come from it.
        workingSessionIds: ['ses-brand-new'],
        prefs: prefs({ ...busyFixture.prefs, sections: { agents: { collapsed: true } } }),
        ...overrides,
      };
    }

    it('carries the count even though the recent window has never seen the session', () => {
      // The reproduction: collapse Agents, then start a turn. The status event
      // arrives at once and carries the directory; `GET /api/sessions/recent`
      // is up to 30s behind, and for those 30s the header read plain "Agents"
      // while Heads up read "1 working" three inches above it.
      const state = folded({ liveSessionCwds: { 'ses-brand-new': SAFFRON } });
      expect(state.sessions.some((entry) => entry.id === 'ses-brand-new')).toBe(false);

      const agents = library(state).find((section) => section.id === 'agents');
      expect(agents?.collapsed).toBe(true);
      expect(agents?.rollup?.workingCount).toBe(1);
    });

    it('draws the same session as a working row when the section is open', () => {
      // The "did it happen at all" half. Without it the assertion above could
      // be satisfied by a rollup that counts something else entirely.
      const state = folded({
        liveSessionCwds: { 'ses-brand-new': SAFFRON },
        prefs: prefs({ ...busyFixture.prefs, sections: { agents: { collapsed: false } } }),
      });
      const agents = library(state).find((section) => section.id === 'agents');
      expect(agents?.rollup).toBeUndefined();
      expect(agents?.rows.find((row) => row.key === `agent:${SAFFRON}`)?.reservesVerbLine).toBe(
        true
      );
    });

    it('agrees with Heads up, which counted the same session all along', () => {
      const state = folded({ liveSessionCwds: { 'ses-brand-new': SAFFRON } });
      const agents = library(state).find((section) => section.id === 'agents');
      expect(buildWorkingRollup(state)?.primary).toBe('1 working');
      expect(agents?.rollup?.workingCount).toBe(1);
    });

    it('keeps counting a member that is blocked AND working (BC-31)', () => {
      // The reviewer's pair, and the sharper half of the defect: a row draws one
      // dot, and needs-you outranks streaming there, so counting dots did not
      // merely undercount — with nothing else set in the section the rollup went
      // to `undefined` and the folded header lost its signal ALTOGETHER, which
      // is the one thing BC-31 says folding never does. The rollup is asked
      // directly for exactly that reason.
      const state = folded({ liveSessionCwds: { 'ses-brand-new': SAFFRON } });
      const control = library(state).find((section) => section.id === 'agents');
      // The control: saffron is streaming and not blocked, and is counted.
      expect(control?.rollup?.workingCount).toBe(1);

      // The probe: the same streaming session, and saffron now also needs you.
      const probe = library({
        ...state,
        agents: state.agents.map((entry) =>
          entry.path === SAFFRON ? { ...entry, attention: 'needs-attention' as const } : entry
        ),
      }).find((section) => section.id === 'agents');

      // The folded header still says somebody is working, because they are —
      // even though the row's own dot has gone to needs-you.
      expect(probe?.rollup).toBeDefined();
      expect(probe?.rollup?.workingCount).toBe(1);
    });

    it('counts no automated run, folded or not (§18)', () => {
      // `ses-auto-1` is a scheduled task in tangerine's directory, and it IS in
      // the recent window — so the row can see it perfectly well and still must
      // not call itself working. Rolling it up would put automated activity on
      // a header, which §18's table renders as nothing at all.
      const TANGERINE = '/Users/dev/code/tangerine';
      const state = folded({ workingSessionIds: ['ses-auto-1'] });
      expect(library(state).find((section) => section.id === 'agents')?.rollup?.workingCount).toBe(
        0
      );

      // And a human session in the very same directory does produce one, so the
      // `undefined` above is the origin filter rather than a dead path.
      const human = folded({
        workingSessionIds: ['ses-brand-new'],
        liveSessionCwds: { 'ses-brand-new': TANGERINE },
      });
      expect(library(human).find((section) => section.id === 'agents')?.rollup?.workingCount).toBe(
        1
      );
    });
  });

  it('is absent while the section is open', () => {
    expect(
      library(busyFixture).find((section) => section.id === 'channels')?.rollup
    ).toBeUndefined();
  });
});

describe('the "N live" chip is decided once, in the model', () => {
  const SAFFRON = '/Users/dev/code/saffron';

  /** `busy` with `count` live human sessions on saffron. */
  function withLiveSessions(count: number): SidebarState {
    const ids = Array.from({ length: count }, (_, i) => `ses-live-${i}`);
    return {
      ...busyFixture,
      workingSessionIds: ids,
      liveSessionCwds: Object.fromEntries(ids.map((id) => [id, SAFFRON])),
    };
  }

  /** Saffron's Agents row. */
  function saffronRow(state: SidebarState) {
    return library(state)
      .find((section) => section.id === 'agents')
      ?.rows.find((row) => row.key === `agent:${SAFFRON}`);
  }

  it('says nothing at one live session', () => {
    // **Absence is the contract, not a zero or a one.** `AgentListItem` draws the
    // chip whenever `liveCount` is present, so an agent with a single live
    // session must reach it with the field missing — the row has no threshold of
    // its own left to filter with. Emitting `liveCount: 1` here puts a "1 live"
    // chip beside a dot that already said the same thing (BC-35).
    const row = saffronRow(withLiveSessions(1));
    expect(row?.reservesVerbLine).toBe(true);
    expect(row?.liveCount).toBeUndefined();
  });

  it('carries the count from two upwards', () => {
    expect(saffronRow(withLiveSessions(2))?.liveCount).toBe(2);
    expect(saffronRow(withLiveSessions(3))?.liveCount).toBe(3);
  });

  it('says nothing at all when nothing is running', () => {
    const row = saffronRow(withLiveSessions(0));
    expect(row?.reservesVerbLine).toBe(false);
    expect(row?.liveCount).toBeUndefined();
  });
});

describe('BC-33 — dual presence', () => {
  it('renders the anchor in Today and in Library at once', () => {
    const today = buildSidebarModel(busyFixture).zones.find((zone) => zone.id === 'today');
    const todayKeys =
      today?.sections.flatMap((section) => section.rows.map((row) => row.key)) ?? [];
    const libraryKeys = library(busyFixture).flatMap((section) =>
      section.rows.map((row) => row.key)
    );
    expect(todayKeys).toContain('room:room-team');
    expect(libraryKeys).toContain('room:room-team');
  });
});

describe('Library ordering and filtering', () => {
  it('leaves manual order alone', () => {
    const state: SidebarState = {
      ...busyFixture,
      prefs: prefs({
        ...busyFixture.prefs,
        sections: { agents: { collapsed: false, sortMode: 'manual' } },
      }),
    };
    const agents = library(state).find((section) => section.id === 'agents');
    // The whole roster: five agents is under the floor of eight, so the
    // recent-and-pinned rule hides nobody and manual order IS roster order.
    const rosterOrder = busyFixture.agents.map((entry) => `agent:${entry.path}`);
    expect(agents?.rows.filter((row) => row.target.kind === 'agent').map((row) => row.key)).toEqual(
      rosterOrder
    );
  });

  it('sorts by name when asked', () => {
    const state: SidebarState = {
      ...busyFixture,
      prefs: prefs({
        ...busyFixture.prefs,
        sections: { agents: { collapsed: false, sortMode: 'name' } },
      }),
    };
    const names = library(state)
      .find((section) => section.id === 'agents')
      ?.rows.filter((row) => row.target.kind === 'agent')
      .map((row) => row.primary);
    expect(names).toEqual([...(names ?? [])].sort((a, b) => a.localeCompare(b)));
  });

  it('shows everything under the default filter, quiet agents included', () => {
    // "All" means all (D3). It used to mean "all except what has been quiet for
    // a week", with the rest behind a reveal row — a filter named for showing
    // everything that hid things.
    const agents = library(busyFixture).find((section) => section.id === 'agents');
    expect(agents?.rows.map((row) => row.key)).toContain('agent:/Users/dev/code/juniper');
  });

  it('hides everything below the bar under the attention filter', () => {
    const state: SidebarState = {
      ...busyFixture,
      prefs: prefs({
        ...busyFixture.prefs,
        sections: { agents: { collapsed: false, displayFilter: 'attention' } },
      }),
    };
    const agents = library(state).find((section) => section.id === 'agents');
    const shown = agents?.rows.filter((row) => row.target.kind === 'agent').map((row) => row.key);
    expect(shown).toEqual(['agent:/Users/dev/code/cardamom']);
  });

  it('carries the section options through to the model', () => {
    const state: SidebarState = {
      ...busyFixture,
      prefs: prefs({
        ...busyFixture.prefs,
        sections: { agents: { collapsed: false, sortMode: 'name', displayFilter: 'active' } },
      }),
    };
    expect(library(state).find((section) => section.id === 'agents')?.options).toEqual({
      sortMode: 'name',
      displayFilter: 'active',
    });
  });
});

describe('Library rows', () => {
  it('are the only draggable rows in the model', () => {
    for (const section of library(busyFixture)) {
      for (const row of section.rows) {
        if (row.target.kind === 'rollup' || row.target.kind === 'command') continue;
        expect(row.draggable).toBe(true);
      }
    }
  });

  it('are NOT draggable inside a smart section — its membership is rule-owned', () => {
    const state: SidebarState = {
      ...busyFixture,
      prefs: prefs({
        ...busyFixture.prefs,
        groups: [
          {
            id: 'sg',
            name: 'Live now',
            kind: 'smart',
            items: [],
            sortMode: 'recent',
            collapsed: false,
            displayFilter: 'all',
            muted: false,
            rules: { statuses: ['active', 'needs-attention'] },
          },
        ],
      }),
    };
    const smart = library(state).find((section) => section.id === 'group:sg');
    expect(smart?.rows.length).toBeGreaterThan(0);
    for (const row of smart?.rows ?? []) expect(row.draggable).toBe(false);
  });

  it('ARE draggable inside a manual section — that is the one you reorder by hand', () => {
    const state: SidebarState = {
      ...busyFixture,
      prefs: prefs({
        ...busyFixture.prefs,
        groups: [
          {
            id: 'mg',
            name: 'Clients',
            kind: 'manual',
            items: [agent('/Users/dev/code/cardamom').path].map((path) => ({
              kind: 'agent' as const,
              path,
            })),
            sortMode: 'manual',
            collapsed: false,
            displayFilter: 'all',
            muted: false,
          },
        ],
      }),
    };
    const manual = library(state).find((section) => section.id === 'group:mg');
    expect(manual?.rows.length).toBeGreaterThan(0);
    for (const row of manual?.rows ?? []) expect(row.draggable).toBe(true);
  });

  it('mark a muted member muted, which is what turns its menu item into Unmute', () => {
    const noise = library(busyFixture)
      .find((section) => section.id === 'channels')
      ?.rows.find((row) => row.key === 'room:room-noise');
    expect(noise?.muted).toBe(true);
  });

  it('emit no zone at all when there is nothing structural to show', () => {
    const bare: SidebarState = { ...firstRunFixture, agents: [], rooms: [] };
    expect(buildLibrarySections(bare)).toEqual([]);
    expect(buildSidebarModel(bare).zones.map((zone) => zone.id)).not.toContain('library');
  });
});

describe('SIDEBAR_LIBRARY_SECTION_IDS is the order', () => {
  it('emits the sections in the tuple\u2019s order, skipping the empty ones', () => {
    // The tuple\u2019s docblock says changing Library\u2019s shape is an edit there.
    // `buildLibrarySections` walks it, so this is that claim, asserted. The
    // operator\u2019s own sections sit above them and are filtered out here: their
    // order is theirs, and the tuple says nothing about it.
    for (const state of [busyFixture, powerFixture, quietFixture]) {
      const ids = library(state)
        .map((section) => section.id)
        .filter((id) => !id.startsWith('group:'));
      const expected = SIDEBAR_LIBRARY_SECTION_IDS.filter((id) => ids.includes(id));
      expect(ids).toEqual(expected);
    }
  });

  it('narrows every id that has somewhere to store a fold, computed zones included', () => {
    // Catches the half-landed widening: if `now`/`today` gained a header and a
    // toggle but not a persisted key, `useSectionChrome.toggleCollapsed` would
    // return early and the fold would look like a dead control.
    for (const id of SIDEBAR_FOLDING_SECTION_IDS) expect(persistedSectionId(id)).toBe(id);
    for (const id of ['now', 'today', 'getting-started'] as const) {
      expect(persistedSectionId(id), `"${id}" has nowhere to store its fold`).toBe(id);
    }
    // A group\u2019s fold lives on the group itself, not in `prefs.sections`.
    expect(persistedSectionId('group:anything')).toBeNull();
  });
});

describe('D3 — a section is honest about what it is showing', () => {
  /** `busyFixture` with one manual section holding two agents and a channel. */
  function withSection(overrides: Partial<SidebarGroup>): SidebarState {
    return {
      ...busyFixture,
      prefs: prefs({
        ...busyFixture.prefs,
        groups: [
          {
            id: 'mix',
            name: 'Clients',
            kind: 'manual',
            items: [
              { kind: 'agent', path: '/Users/dev/code/cardamom' },
              { kind: 'agent', path: '/Users/dev/code/juniper' },
              { kind: 'room', roomId: 'room-team' },
            ],
            sortMode: 'manual',
            collapsed: false,
            displayFilter: 'all',
            muted: false,
            ...overrides,
          },
        ],
      }),
    };
  }

  it('APPLIES a section’s display filter to its agent rows', () => {
    // What this catches: the filter being stored, offered and ticked while
    // `groupSection` never reads it — which is what shipped for three releases
    // (research §3.4 defect 1). Re-seed by dropping the `passesDisplayFilter`
    // call in `groupSection` and this goes red; nothing else does.
    const shown = library(withSection({ displayFilter: 'attention' }))
      .find((section) => section.id === 'group:mix')
      ?.rows.filter((row) => row.target.kind === 'agent')
      .map((row) => row.key);
    expect(shown).toEqual(['agent:/Users/dev/code/cardamom']);
  });

  it('never filters a room out of a section — a room has no attention state', () => {
    const rows = library(withSection({ displayFilter: 'attention' })).find(
      (section) => section.id === 'group:mix'
    )?.rows;
    expect(rows?.map((row) => row.key)).toContain('room:room-team');
  });

  it('publishes no `options` — a hand-made section’s header reads the section', () => {
    // The fixed sections publish theirs because their headers have nowhere else
    // to look. This one's header holds the whole stored `SidebarGroup` — sort,
    // filter, mute, rules — so a second copy on the model would be one more
    // place for the two to disagree about what was actually drawn.
    expect(
      library(withSection({ displayFilter: 'active', sortMode: 'name' })).find(
        (section) => section.id === 'group:mix'
      )?.options
    ).toBeUndefined();
  });

  it('sorts a mixed section by recency using the ROOM’s own timestamp', () => {
    // What this catches: the recency resolver answering `null` for a room, which
    // `orderLibraryRows` reads as -Infinity — every channel sank below every
    // agent whatever its activity said (research §3.4 defect 3).
    const state = withSection({ sortMode: 'recent' });
    const fresh: SidebarState = {
      ...state,
      rooms: state.rooms.map((room) =>
        room.id === 'room-team'
          ? { ...room, lastActivityAt: new Date(state.now).toISOString() }
          : room
      ),
      agents: state.agents.map((entry) => ({ ...entry, lastActivityAt: state.now - 90_000_000 })),
    };
    const first = library(fresh).find((section) => section.id === 'group:mix')?.rows[0];
    expect(first?.key).toBe('room:room-team');
  });

  it('renders an empty section rather than dropping it (BC-32’s one exception)', () => {
    const empty = library(withSection({ items: [] })).find((section) => section.id === 'group:mix');
    expect(empty).toBeDefined();
    expect(empty?.rows).toEqual([]);
  });
});

describe('D3 — Agents lists what is recent and pinned, then the door to the rest', () => {
  /** The path of the nth agent in {@link fleet}. */
  const fleetPath = (index: number) => `/fleet/agent-${String(index).padStart(2, '0')}`;

  /** A fleet of `count` agents, `activeCount` of them live and the rest long quiet. */
  function fleet(count: number, activeCount: number): SidebarState {
    return {
      ...quietFixture,
      agents: Array.from({ length: count }, (_, index) =>
        agent(fleetPath(index), {
          attention: index < activeCount ? 'active' : 'inactive',
          lastActivityAt: quietFixture.now - (index + 1) * 60_000,
        })
      ),
      displayNames: Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          fleetPath(index),
          `agent-${String(index).padStart(2, '0')}`,
        ])
      ),
      prefs: prefs({ ...quietFixture.prefs, groups: [], pinned: [] }),
    };
  }

  /** The agent rows of the Agents section. */
  function agentRows(state: SidebarState) {
    return (
      library(state)
        .find((section) => section.id === 'agents')
        ?.rows.filter((row) => row.target.kind === 'agent') ?? []
    );
  }

  it('trims a fleet nobody has ever run, down to the floor (day one)', () => {
    // **The blocker this rule was written for and missed.** `attention` answers
    // `'fresh'` for an agent that has never run — deliberately, so a brand-new
    // DorkBot reads as new rather than dormant — and `'fresh'` is not
    // `'inactive'`. A rule that asked only that question kept fifteen
    // registered-and-never-run agents in the list, the floor never bit, and
    // `All N agents →` never appeared: measured in a browser on a seeded
    // fifteen-agent install. Re-seed by dropping the `lastActivityAt === null`
    // arm of `isQuiet` and this is the case that goes red.
    const fleet: SidebarState = {
      ...quietFixture,
      agents: Array.from({ length: 15 }, (_, index) =>
        agent(fleetPath(index), { attention: 'fresh', lastActivityAt: null })
      ),
      displayNames: Object.fromEntries(
        Array.from({ length: 15 }, (_, index) => [fleetPath(index), `agent-${index}`])
      ),
      prefs: prefs({ ...quietFixture.prefs, groups: [], pinned: [] }),
    };
    expect(agentRows(fleet)).toHaveLength(AGENT_ROW_FLOOR);
    const rows = library(fleet).find((section) => section.id === 'agents')?.rows ?? [];
    expect(rows[rows.length - 1]?.primary).toBe('All 15 agents');
  });

  it('still shows a whole day-one cockpit that is under the floor', () => {
    // The other half of the same rule: three never-run agents is not a list
    // worth trimming, and the floor is what says so.
    const fleet: SidebarState = {
      ...quietFixture,
      agents: Array.from({ length: 3 }, (_, index) =>
        agent(fleetPath(index), { attention: 'fresh', lastActivityAt: null })
      ),
      displayNames: Object.fromEntries(
        Array.from({ length: 3 }, (_, index) => [fleetPath(index), `agent-${index}`])
      ),
      prefs: prefs({ ...quietFixture.prefs, groups: [], pinned: [] }),
    };
    expect(agentRows(fleet)).toHaveLength(3);
    expect(
      library(fleet)
        .find((section) => section.id === 'agents')
        ?.rows.some((row) => row.reason === 'library:all-agents')
    ).toBe(false);
  });

  it('keeps a never-run agent you have opened this week', () => {
    // The viewer's own visit is the other half of "recent" (D3): a project you
    // opened on Tuesday to read is not an empty row, whatever it has run.
    const fleet: SidebarState = {
      ...quietFixture,
      agents: Array.from({ length: 15 }, (_, index) =>
        agent(fleetPath(index), {
          attention: 'fresh',
          lastActivityAt: null,
          ...(index === 14 ? { lastInteractionAt: quietFixture.now - 60_000 } : {}),
        })
      ),
      displayNames: Object.fromEntries(
        Array.from({ length: 15 }, (_, index) => [fleetPath(index), `agent-${index}`])
      ),
      prefs: prefs({ ...quietFixture.prefs, groups: [], pinned: [] }),
    };
    expect(agentRows(fleet).map((row) => row.key)).toContain(`agent:${fleetPath(14)}`);
  });

  it('fills up to a floor of eight with the most recently active quiet agents', () => {
    // What this catches: a recent-and-pinned rule with no floor, which empties
    // the Agents section on a quiet morning and leaves one link behind.
    const rows = agentRows(fleet(30, 2));
    expect(rows).toHaveLength(8);
    // The two live ones, then the six quiet ones closest to having run.
    expect(rows.map((row) => row.key)).toEqual(
      Array.from({ length: 8 }, (_, index) => `agent:${fleetPath(index)}`)
    );
  });

  it('lists every agent that is not quiet, however many that is', () => {
    expect(agentRows(fleet(30, 20))).toHaveLength(20);
  });

  it('keeps a pinned agent in the list even when it has been quiet for a month', () => {
    const base = fleet(30, 2);
    const pinnedPath = fleetPath(29);
    const state: SidebarState = {
      ...base,
      prefs: prefs({ ...base.prefs, pinned: [{ kind: 'agent', path: pinnedPath }] }),
    };
    expect(agentRows(state).map((row) => row.key)).toContain(`agent:${pinnedPath}`);
  });

  it('ends with "All N agents →", which opens the Team page', () => {
    const rows = library(fleet(30, 2)).find((section) => section.id === 'agents')?.rows ?? [];
    const last = rows[rows.length - 1];
    // The WORDS only. The arrow is drawn `aria-hidden` by the renderer, so a
    // screen reader is not read a direction as though it were a noun.
    expect(last?.primary).toBe('All 30 agents');
    expect(last?.target).toEqual({ kind: 'command', commandId: 'open-team' });
    expect(last?.draggable).toBe(false);
  });

  it('offers no such row when the section is already showing the whole fleet', () => {
    const rows = library(fleet(6, 6)).find((section) => section.id === 'agents')?.rows ?? [];
    expect(rows.some((row) => row.reason === 'library:all-agents')).toBe(false);
  });

  it('counts an agent filed into a section as drawn, not as hidden', () => {
    // What this catches: comparing the roster against the AGENTS section alone.
    // A section's members are on screen too, a few inches higher up — so
    // offering "All 3 agents →" to somebody looking at all three is a door to
    // nowhere new. Re-seed by dropping `+ drawnElsewhere` from the guard.
    const base = fleet(3, 3);
    const state: SidebarState = {
      ...base,
      prefs: prefs({
        ...base.prefs,
        groups: [
          {
            id: 'one',
            name: 'Client work',
            kind: 'manual',
            items: [{ kind: 'agent', path: fleetPath(0) }],
            sortMode: 'manual',
            collapsed: false,
            displayFilter: 'all',
            muted: false,
          },
        ],
      }),
    };
    const sections = library(state);
    expect(sections.find((section) => section.id === 'group:one')?.rows).toHaveLength(1);
    expect(agentRows(state)).toHaveLength(2);
    expect(
      sections
        .find((section) => section.id === 'agents')
        ?.rows.some((row) => row.reason === 'library:all-agents')
    ).toBe(false);
  });

  it('emits no `library:reveal` row anywhere — the dead rollup is gone (DOR-1105)', () => {
    for (const state of [busyFixture, powerFixture, quietFixture]) {
      for (const section of library(state)) {
        for (const row of section.rows) {
          expect(row.reason).not.toBe('library:reveal');
        }
      }
    }
  });
});

describe('DOR-906 — Channels and Direct messages remember how they are sorted', () => {
  /** `busyFixture` with every room's activity spread an hour apart, newest first. */
  function spacedRooms(sections: SidebarState['prefs']['sections']): SidebarState {
    return {
      ...busyFixture,
      rooms: busyFixture.rooms.map((room, index) => ({
        ...room,
        lastActivityAt: new Date(busyFixture.now - index * 3_600_000).toISOString(),
      })),
      prefs: prefs({ ...busyFixture.prefs, sections }),
    };
  }

  it('orders channels by name by default', () => {
    const names = library(busyFixture)
      .find((section) => section.id === 'channels')
      ?.rows.map((row) => row.primary);
    expect(names).toEqual([...(names ?? [])].sort((a, b) => a.localeCompare(b)));
  });

  it('orders channels by recent activity when the section says so', () => {
    // What this catches: the section reading the stored `recent` and then
    // resolving every room's recency as `null`, which degrades to a key sort and
    // looks from the outside like the setting is simply ignored.
    const state = spacedRooms({ channels: { collapsed: false, sortMode: 'recent' } });
    const ordered = library(state).find((section) => section.id === 'channels')?.rows ?? [];
    expect(ordered.length).toBeGreaterThan(1);
    const at = (key: string) => {
      const room = state.rooms.find((entry) => `room:${entry.id}` === key);
      return room ? Date.parse(room.lastActivityAt) : 0;
    };
    for (let index = 1; index < ordered.length; index += 1) {
      expect(at(ordered[index - 1]!.key)).toBeGreaterThanOrEqual(at(ordered[index]!.key));
    }
  });

  it('publishes the sort it used on both room sections', () => {
    const state = spacedRooms({
      channels: { collapsed: false, sortMode: 'recent' },
      dms: { collapsed: false, sortMode: 'recent' },
    });
    for (const id of ['channels', 'dms'] as const) {
      expect(library(state).find((section) => section.id === id)?.options).toEqual({
        sortMode: 'recent',
      });
    }
  });
});

describe('D2 — one door to an agent', () => {
  const ANA = '/Users/dev/code/ana';
  const KAI = '/Users/dev/code/kai';
  const GONE = '/Users/dev/code/retired';

  /** One agent on a direct message's roster, as the wire carries it. */
  function agentAuthor(path: string, displayName: string) {
    return {
      id: `author-${displayName}`,
      kind: 'agent' as const,
      displayName,
      handle: null,
      agentRef: agentAuthorRef(path),
    };
  }

  /** The operator, who is on every direct message they can see. */
  const operator = person('person:me', 'You');

  /**
   * A cockpit with two agents and whatever rooms this case is about.
   *
   * @param rooms - The rooms on the wire.
   * @param overrides - Anything else this case needs.
   */
  function cockpit(
    rooms: SidebarState['rooms'],
    overrides: Partial<SidebarState> = {}
  ): SidebarState {
    return {
      ...quietFixture,
      agents: [agent(ANA), agent(KAI)],
      displayNames: { [ANA]: 'Ana', [KAI]: 'Kai' },
      rooms,
      ...overrides,
    };
  }

  /** The Direct messages section's row keys. */
  function dmKeys(state: SidebarState): string[] {
    return (
      library(state)
        .find((section) => section.id === 'dms')
        ?.rows.map((row) => row.key) ?? []
    );
  }

  /** Today's rows, as the model finally emits them. */
  function todayRowsOf(state: SidebarState): SidebarRowModel[] {
    return (
      buildSidebarModel(state)
        .zones.find((zone) => zone.id === 'today')
        ?.sections.flatMap((section) => section.rows) ?? []
    );
  }

  /** One agent's Library row, wherever it ended up. */
  function agentRowFor(state: SidebarState, path: string) {
    // Every section is a peer now (D3), so one flat walk reaches them all.
    return library(state)
      .flatMap((section) => section.rows)
      .find((row) => row.target.kind === 'agent' && row.target.path === path);
  }

  it('leaves a hand-made one-to-one out of Direct messages', () => {
    const state = cockpit([
      room({
        id: 'dm-ana',
        kind: 'dm',
        title: 'Ana',
        participants: [operator, agentAuthor(ANA, 'Ana')],
      }),
    ]);
    expect(dmKeys(state)).toEqual([]);
    // And the section goes with it, because a section exists when something is
    // in it (BC-32).
    expect(library(state).map((section) => section.id)).not.toContain('dms');
  });

  it('keeps a group message, which is a conversation no session holds', () => {
    const state = cockpit([
      room({
        id: 'dm-both',
        kind: 'dm',
        title: 'Ana and Kai',
        participants: [operator, agentAuthor(ANA, 'Ana'), agentAuthor(KAI, 'Kai')],
      }),
    ]);
    expect(dmKeys(state)).toEqual(['room:dm-both']);
  });

  it('keeps a bridged private chat, whose other end is a person somewhere else', () => {
    const state = cockpit([
      room({
        id: 'dm-telegram',
        kind: 'dm',
        title: 'Ana',
        bridge: { visibility: null, platformTitle: 'Ana' },
        participants: [operator, agentAuthor(ANA, 'Ana')],
      }),
    ]);
    expect(dmKeys(state)).toEqual(['room:dm-telegram']);
  });

  it('keeps a one-to-one whose agent has left the fleet', () => {
    // Nothing else would stand for it: the suppression trades a second list for
    // a dot on the agent's row, and a retired agent has no row to carry one.
    const state = cockpit([
      room({
        id: 'dm-gone',
        kind: 'dm',
        title: 'Retired',
        participants: [operator, agentAuthor(GONE, 'Retired')],
      }),
    ]);
    expect(dmKeys(state)).toEqual(['room:dm-gone']);
  });

  it('keeps a one-to-one the operator filed into a section by hand', () => {
    const state = cockpit(
      [
        room({
          id: 'dm-ana',
          kind: 'dm',
          title: 'Ana',
          participants: [operator, agentAuthor(ANA, 'Ana')],
        }),
      ],
      {
        prefs: prefs({
          groups: [
            {
              id: 'group-mine',
              name: 'Mine',
              kind: 'manual',
              items: [{ kind: 'room', roomId: 'dm-ana' }],
              sortMode: 'manual',
              collapsed: false,
              displayFilter: 'all',
              muted: false,
            },
          ],
        }),
      }
    );
    // Sections are peers of Agents now (D3), so the section is found beside it
    // rather than inside it.
    const group = library(state).find((section) => section.id === 'group:group-mine');
    expect(group?.rows.map((row) => row.key)).toEqual(['room:dm-ana']);
  });

  it('puts the unread on the agent’s own row instead', () => {
    const state = cockpit([
      room({
        id: 'dm-ana',
        kind: 'dm',
        title: 'Ana',
        unreadCount: 3,
        participants: [operator, agentAuthor(ANA, 'Ana')],
      }),
    ]);
    expect(agentRowFor(state, ANA)?.unread).toEqual({ tier: 'directed', count: 3 });
    // And says nothing about the agent that has nothing waiting.
    expect(agentRowFor(state, KAI)?.unread).toEqual({ tier: 'none' });
  });

  it('says nothing on the row when the conversation is muted', () => {
    const state = cockpit(
      [
        room({
          id: 'dm-ana',
          kind: 'dm',
          title: 'Ana',
          unreadCount: 3,
          participants: [operator, agentAuthor(ANA, 'Ana')],
        }),
      ],
      { prefs: prefs({ muted: [{ kind: 'room', roomId: 'dm-ana' }] }) }
    );
    expect(agentRowFor(state, ANA)?.unread).toEqual({ tier: 'none' });
  });

  it('still draws the conversation in Today once the operator has been in it', () => {
    // The suppression is Library's and Library's only: Today's membership is
    // "have they interacted with it", and it is untouched (BC-16).
    const state = cockpit(
      [
        room({
          id: 'dm-ana',
          kind: 'dm',
          title: 'Ana',
          unreadCount: 3,
          participants: [operator, agentAuthor(ANA, 'Ana')],
        }),
      ],
      { interactions: { 'room:dm-ana': hoursAgo(1) } }
    );
    expect(todayRowsOf(state).map((row) => row.key)).toContain('room:dm-ana');
  });

  it('is reachable when an agent opened it and the operator never has', () => {
    // The `notify-dm` shape, and the case that makes the suppression safe: the
    // operator has never opened this room, so the ordinary "have they
    // interacted with it" rule leaves it out — and with no Library row either
    // it would be on no surface at all. Its directed unread is what puts it in
    // Today, under its own reason and as the ROOM's row, so clicking it opens
    // the conversation rather than the agent's session.
    const state = cockpit([
      room({
        id: 'dm-ana',
        kind: 'dm',
        title: 'Ana',
        unreadCount: 1,
        participants: [operator, agentAuthor(ANA, 'Ana')],
      }),
    ]);
    const rows = todayRowsOf(state);
    const row = rows.find((entry) => entry.key === 'room:dm-ana');
    expect(row, 'a room nothing else draws has to be reachable from Today').toBeDefined();
    expect(row?.reason).toBe('today:dm-suppressed-unread');
    expect(row?.target).toMatchObject({ kind: 'room', roomId: 'dm-ana', roomKind: 'dm' });
    expect(row?.unread).toEqual({ tier: 'directed', count: 1 });
  });

  it('drops out of Today once it has been read', () => {
    // The clause is the unread and nothing else, so a room with nothing waiting
    // does not accumulate in Today on the strength of having once had something.
    const state = cockpit([
      room({
        id: 'dm-ana',
        kind: 'dm',
        title: 'Ana',
        unreadCount: 0,
        participants: [operator, agentAuthor(ANA, 'Ana')],
      }),
    ]);
    expect(todayRowsOf(state).map((entry) => entry.key)).not.toContain('room:dm-ana');
  });

  it('stays silent when the operator muted it', () => {
    // Mute kills Today eligibility (BC-40), and a reachability clause is not a
    // way around that. `roomRow` derives the unread, so muting the room makes
    // its tier `none` and this clause never fires.
    const state = cockpit(
      [
        room({
          id: 'dm-ana',
          kind: 'dm',
          title: 'Ana',
          unreadCount: 1,
          participants: [operator, agentAuthor(ANA, 'Ana')],
        }),
      ],
      { prefs: prefs({ muted: [{ kind: 'room', roomId: 'dm-ana' }] }) }
    );
    expect(todayRowsOf(state).map((entry) => entry.key)).not.toContain('room:dm-ana');
  });

  it('survives the cap and the overnight boundary it never had a timestamp for', () => {
    // Both exemptions already exist for a directed unread; this asserts they
    // actually cover a row that arrives with no interaction timestamp at all,
    // which is the shape this clause introduces. Nine touched channels push the
    // soft cap of eight past full.
    const noise = Array.from({ length: 9 }, (_, index) =>
      room({ id: `c${index}`, kind: 'channel', title: `noise-${index}` })
    );
    const state = cockpit(
      [
        ...noise,
        room({
          id: 'dm-ana',
          kind: 'dm',
          title: 'Ana',
          unreadCount: 1,
          participants: [operator, agentAuthor(ANA, 'Ana')],
        }),
      ],
      {
        interactions: Object.fromEntries(noise.map((entry) => [`room:${entry.id}`, hoursAgo(0.5)])),
      }
    );
    const keys = todayRowsOf(state).map((entry) => entry.key);
    expect(keys.length).toBeGreaterThan(TODAY_SOFT_CAP);
    expect(keys).toContain('room:dm-ana');
  });
});
