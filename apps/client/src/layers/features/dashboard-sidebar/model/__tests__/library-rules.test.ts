/**
 * Library — section order, one indent level, rollups that survive folding, and
 * chrome that appears by data volume (BC-28 → BC-33).
 *
 * @module features/dashboard-sidebar/model/__tests__/library-rules
 */
import { describe, expect, it } from 'vitest';
import {
  buildSidebarModel,
  librarySectionId,
  SIDEBAR_LIBRARY_SECTION_IDS,
  type SidebarSectionModel,
} from '../build-sidebar-model';
import {
  agent,
  busyFixture,
  firstRunFixture,
  powerFixture,
  prefs,
  quietFixture,
} from '../fixtures';
import { buildLibrarySections, offersGroupAffordances } from '../rules/build-library-sections';
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

  it('nests groups inside Agents, never beside them', () => {
    const agents = library(powerFixture).find((section) => section.id === 'agents');
    expect(agents?.subsections?.map((sub) => sub.label)).toEqual(['Frontend', 'Codex fleet']);
    expect(library(powerFixture).map((section) => section.id)).not.toContain(
      'group:group-frontend'
    );
  });

  it('never nests a subsection inside a subsection', () => {
    for (const section of library(powerFixture)) {
      for (const sub of section.subsections ?? []) {
        expect(sub.subsections).toBeUndefined();
      }
    }
  });

  it('evaluates a smart group’s membership live', () => {
    const codex = library(powerFixture)
      .find((section) => section.id === 'agents')
      ?.subsections?.find((sub) => sub.id === 'group:group-codex');
    expect(codex?.rows.length).toBeGreaterThan(0);
    for (const row of codex?.rows ?? []) {
      const path = row.target.kind === 'agent' ? row.target.path : '';
      expect(powerFixture.agents.find((entry) => entry.path === path)?.runtime).toBe('codex');
    }
  });

  it('takes a manual group’s members out of the ungrouped list', () => {
    const agents = library(powerFixture).find((section) => section.id === 'agents');
    const ungrouped = agents?.rows.map((row) => row.key) ?? [];
    expect(ungrouped).not.toContain('agent:/Users/dev/code/agent-01');
  });

  it('leaves a smart group’s members in the ungrouped list', () => {
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

  it('says nothing at all when there is nothing to say', () => {
    expect(rollUpCollapsedSection([])).toBeUndefined();
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
      // while Now read "1 working" three inches above it.
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
      expect(agents?.rows.find((row) => row.key === `agent:${SAFFRON}`)?.status).toBe('working');
    });

    it('agrees with Now, which counted the same session all along', () => {
      const state = folded({ liveSessionCwds: { 'ses-brand-new': SAFFRON } });
      const agents = library(state).find((section) => section.id === 'agents');
      expect(buildWorkingRollup(state)?.primary).toBe('1 working');
      expect(agents?.rollup?.workingCount).toBe(1);
    });

    it('counts no automated run, folded or not (§18)', () => {
      // `ses-auto-1` is a scheduled task in tangerine's directory, and it IS in
      // the recent window — so the row can see it perfectly well and still must
      // not call itself working. Rolling it up would put automated activity on
      // a header, which §18's table renders as nothing at all.
      const TANGERINE = '/Users/dev/code/tangerine';
      const state = folded({ workingSessionIds: ['ses-auto-1'] });
      expect(library(state).find((section) => section.id === 'agents')?.rollup).toBeUndefined();

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
    const rosterOrder = busyFixture.agents
      .filter((entry) => entry.attention !== 'inactive')
      .map((entry) => `agent:${entry.path}`);
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

  it('tucks never-active agents behind a reveal row under the default filter', () => {
    const agents = library(busyFixture).find((section) => section.id === 'agents');
    const reveal = agents?.rows.find((row) => row.reason === 'library:reveal');
    expect(reveal?.primary).toBe('1 inactive');
    expect(agents?.rows.map((row) => row.key)).not.toContain('agent:/Users/dev/code/juniper');
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
    expect(agents?.rows.find((row) => row.reason === 'library:reveal')?.primary).toBe('4 hidden');
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
        if (row.target.kind === 'rollup') continue;
        expect(row.draggable).toBe(true);
      }
    }
  });

  it('are NOT draggable inside a smart group — its membership is rule-owned', () => {
    // The subsections, which the assertion above does not reach: a smart
    // group's rows sit one level in, so a check that only walked `section.rows`
    // would pass with every one of them a drag source.
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
    const smart = library(state)
      .find((section) => section.id === 'agents')
      ?.subsections?.find((sub) => sub.id === 'group:sg');
    expect(smart?.rows.length).toBeGreaterThan(0);
    for (const row of smart?.rows ?? []) expect(row.draggable).toBe(false);
  });

  it('ARE draggable inside a manual group — that is the one you reorder by hand', () => {
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
    const manual = library(state)
      .find((section) => section.id === 'agents')
      ?.subsections?.find((sub) => sub.id === 'group:mg');
    expect(manual?.rows.length).toBeGreaterThan(0);
    for (const row of manual?.rows ?? []) expect(row.draggable).toBe(true);
  });

  it('offer unmute rather than mute once something is muted', () => {
    const noise = library(busyFixture)
      .find((section) => section.id === 'channels')
      ?.rows.find((row) => row.key === 'room:room-noise');
    expect(noise?.actions).toContain('unmute');
    expect(noise?.actions).not.toContain('mute');
  });

  it('name what the filter hid, singular and plural', () => {
    const oneHidden = library(busyFixture)
      .find((section) => section.id === 'agents')
      ?.rows.find((row) => row.reason === 'library:reveal');
    expect(oneHidden?.primary).toBe('1 inactive');

    const manyHidden = library(powerFixture)
      .find((section) => section.id === 'agents')
      ?.rows.find((row) => row.reason === 'library:reveal');
    // The `power` fixture is the one with a fleet big enough to hide several.
    if (manyHidden !== undefined) expect(manyHidden.primary).toMatch(/^\d+ inactive$/);

    // And nothing at all when the filter hid nothing.
    const nothingHidden: SidebarState = {
      ...quietFixture,
      agents: quietFixture.agents.map((entry) => ({ ...entry, attention: 'active' as const })),
    };
    expect(
      library(nothingHidden)
        .find((section) => section.id === 'agents')
        ?.rows.some((row) => row.reason === 'library:reveal')
    ).toBe(false);
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
    // `buildLibrarySections` now walks it, so this is that claim, asserted.
    for (const state of [busyFixture, powerFixture, quietFixture]) {
      const ids = library(state).map((section) => section.id);
      const expected = SIDEBAR_LIBRARY_SECTION_IDS.filter((id) => ids.includes(id));
      expect(ids).toEqual(expected);
    }
  });

  it('narrows only the four ids that have somewhere to store a fold', () => {
    for (const id of SIDEBAR_LIBRARY_SECTION_IDS) expect(librarySectionId(id)).toBe(id);
    // Now, Today and Getting started cannot fold; a group\u2019s fold lives on the
    // group. None of them has a slot in `prefs.sections`.
    expect(librarySectionId('now')).toBeNull();
    expect(librarySectionId('today')).toBeNull();
    expect(librarySectionId('getting-started')).toBeNull();
    expect(librarySectionId('group:anything')).toBeNull();
  });
});
