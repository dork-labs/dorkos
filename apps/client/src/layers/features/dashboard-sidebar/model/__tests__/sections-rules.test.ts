/**
 * The list — what it holds, in what order, and what it never holds: a session
 * or a thread. An agent is a row once, as its direct message.
 *
 * @module features/dashboard-sidebar/model/__tests__/sections-rules
 */
import { describe, expect, it } from 'vitest';
import type { SidebarGroup } from '@dorkos/shared/config-schema';
import {
  buildSidebarModel,
  persistedSectionId,
  SIDEBAR_SECTION_IDS,
  type SidebarSectionModel,
} from '../build-sidebar-model';
import {
  addOn,
  agent,
  agentDm,
  agentMember,
  busyFixture,
  emptyState,
  firstRunFixture,
  hoursAgo,
  person,
  powerFixture,
  prefs,
  quietFixture,
  room,
} from '../fixtures';
import { offersGroupAffordances } from '../rules/build-sections';
import { rollUpCollapsedSection } from '../rules/roll-up-collapsed-section';
import type { SidebarState } from '../sidebar-state';

const TANGERINE = '/Users/dev/code/tangerine';
const CARDAMOM = '/Users/dev/code/cardamom';
const SAFFRON = '/Users/dev/code/saffron';
const JUNIPER = '/Users/dev/code/juniper';

/** Every section of one state. */
function sections(state: SidebarState): SidebarSectionModel[] {
  return buildSidebarModel(state).sections;
}

/** One section of one state. */
function section(state: SidebarState, id: string): SidebarSectionModel | undefined {
  return sections(state).find((entry) => entry.id === id);
}

/** The row keys of one section. */
function keys(state: SidebarState, id: string): string[] {
  return section(state, id)?.rows.map((row) => row.key) ?? [];
}

describe('the order, top to bottom', () => {
  it('reads the top items, Channels, Direct messages', () => {
    expect(sections(busyFixture).map((entry) => entry.id)).toEqual(['top', 'channels', 'dms']);
  });

  it('puts the operator’s own sections right under the top items, as peers', () => {
    expect(sections(powerFixture).map((entry) => entry.id)).toEqual([
      'top',
      'group:group-frontend',
      'group:group-codex',
      'channels',
      'dms',
    ]);
  });

  it('keeps the operator’s stored section order', () => {
    const reordered: SidebarState = {
      ...powerFixture,
      prefs: prefs({ ...powerFixture.prefs, groups: [...powerFixture.prefs.groups].reverse() }),
    };
    expect(
      sections(reordered)
        .map((entry) => entry.id)
        .slice(1, 3)
    ).toEqual(['group:group-codex', 'group:group-frontend']);
  });

  it('ends with Add-ons, once a mini app has added a page', () => {
    const state: SidebarState = { ...quietFixture, addOns: [addOn('crm', '', 'Clients')] };
    expect(sections(state).map((entry) => entry.id)).toEqual(['top', 'channels', 'dms', 'addons']);
  });

  it('emits the fixed sections in the tuple’s order', () => {
    const fixed = sections({ ...busyFixture, addOns: [addOn('crm', '', 'Clients')] })
      .map((entry) => entry.id)
      .filter((id) => persistedSectionId(id) !== null);
    expect(fixed).toEqual([...SIDEBAR_SECTION_IDS]);
  });
});

describe('the top items', () => {
  it('are Threads and Directory, headerless, and nothing else', () => {
    const top = section(busyFixture, 'top');
    expect(top?.label).toBeNull();
    expect(top?.collapsible).toBe(false);
    expect(top?.rows.map((row) => [row.primary, row.target])).toEqual([
      ['Threads', { kind: 'command', commandId: 'open-threads' }],
      ['Directory', { kind: 'command', commandId: 'open-directory' }],
    ]);
  });

  it('are doors: never dragged, never unread, never muted', () => {
    for (const row of section(busyFixture, 'top')?.rows ?? []) {
      expect(row.draggable).toBe(false);
      expect(row.unread).toEqual({ tier: 'none' });
      expect(row.muted).toBe(false);
    }
  });

  it('never fold, so the fold-all gesture has nowhere to keep one', () => {
    expect(persistedSectionId('top')).toBeNull();
  });
});

describe('places, never sessions or threads', () => {
  it('draws no session row anywhere, in any journey', () => {
    for (const state of [firstRunFixture, quietFixture, busyFixture, powerFixture]) {
      const rows = sections(state).flatMap((entry) => entry.rows);
      expect(rows.some((row) => row.target.kind === 'session')).toBe(false);
    }
  });

  it('draws no thread, however many the operator is in', () => {
    // Threads live on their own page now; `SidebarState` does not even carry
    // them, so the list cannot draw one by accident.
    expect(Object.keys(busyFixture)).not.toContain('threads');
  });
});

describe('Direct messages — an agent is its direct message', () => {
  it('draws an agent’s direct message as the agent, opening its Direct chat', () => {
    const rows = section(busyFixture, 'dms')?.rows ?? [];
    const cardamom = rows.find((row) => row.key === `agent:${CARDAMOM}`);
    expect(cardamom?.target).toEqual({ kind: 'agent', path: CARDAMOM });
    expect(cardamom?.primary).toBe('cardamom');
    // …and the room itself draws no second row.
    expect(rows.some((row) => row.key === 'room:dm-cardamom')).toBe(false);
  });

  it('carries the conversation’s unread on the agent row, as a count', () => {
    const cardamom = section(busyFixture, 'dms')?.rows.find(
      (row) => row.key === `agent:${CARDAMOM}`
    );
    expect(cardamom?.unread).toEqual({ tier: 'directed', count: 2 });
  });

  it('keeps a conversation with people as a room row', () => {
    expect(keys(busyFixture, 'dms')).toEqual(
      expect.arrayContaining(['room:dm-priya', 'room:dm-kai'])
    );
  });

  it('keeps a group message as a room row — no one agent stands for it', () => {
    const state: SidebarState = {
      ...busyFixture,
      rooms: [
        room({
          id: 'dm-group',
          kind: 'dm',
          title: 'cardamom, saffron',
          participants: [
            person('person:dorian', 'Dorian'),
            agentMember(CARDAMOM, 'cardamom'),
            agentMember(SAFFRON, 'saffron'),
          ],
        }),
      ],
    };
    expect(keys(state, 'dms')).toContain('room:dm-group');
  });

  it('keeps a direct message whose agent has left the fleet, as a room row', () => {
    const state: SidebarState = {
      ...busyFixture,
      rooms: [agentDm('dm-gone', '/Users/dev/code/retired', 'retired')],
    };
    expect(keys(state, 'dms')).toContain('room:dm-gone');
  });

  it('draws a pinned agent with no direct message yet', () => {
    // Tangerine is pinned in the busy journey and nobody has written to it.
    expect(keys(busyFixture, 'dms')).toContain(`agent:${TANGERINE}`);
    expect(
      section(busyFixture, 'dms')?.rows.find((row) => row.key === `agent:${TANGERINE}`)?.reason
    ).toBe('dms:pinned-agent');
  });

  it('leaves every other agent in the Directory', () => {
    // Juniper and DorkBot have no direct message and no pin.
    const all = sections(busyFixture).flatMap((entry) => entry.rows.map((row) => row.key));
    expect(all).not.toContain(`agent:${JUNIPER}`);
    expect(all).not.toContain('agent:/Users/dev/.dork/agents/dorkbot');
  });

  it('draws an agent once, even when it is pinned AND has a direct message', () => {
    const state: SidebarState = {
      ...busyFixture,
      prefs: prefs({ ...busyFixture.prefs, pinned: [{ kind: 'agent', path: CARDAMOM }] }),
    };
    expect(keys(state, 'dms').filter((key) => key === `agent:${CARDAMOM}`)).toHaveLength(1);
  });

  it('draws an agent filed into a section there, and not in Direct messages', () => {
    const state: SidebarState = {
      ...busyFixture,
      prefs: prefs({
        ...busyFixture.prefs,
        groups: [manualGroup('g1', 'Ops', [{ kind: 'agent', path: CARDAMOM }])],
      }),
    };
    expect(keys(state, 'dms')).not.toContain(`agent:${CARDAMOM}`);
    const ops = section(state, 'group:g1');
    expect(ops?.rows.map((row) => row.key)).toEqual([`agent:${CARDAMOM}`]);
    // Wherever it is filed, the row still says its conversation has something.
    expect(ops?.rows[0]?.unread).toEqual({ tier: 'directed', count: 2 });
  });

  it('draws an agent a smart section matches there, and not in Direct messages', () => {
    const smart: SidebarGroup = {
      ...manualGroup('codex', 'Codex', []),
      kind: 'smart',
      rules: { runtimes: ['codex'] },
    };
    // Pinned, so without the smart section it would be a Direct messages row.
    const state: SidebarState = {
      ...busyFixture,
      prefs: prefs({
        ...busyFixture.prefs,
        pinned: [{ kind: 'agent', path: SAFFRON }],
        groups: [smart],
      }),
    };
    expect(keys(state, 'group:codex')).toEqual([`agent:${SAFFRON}`]);
    expect(keys(state, 'dms')).not.toContain(`agent:${SAFFRON}`);
    const everyRow = sections(state).flatMap((entry) => entry.rows.map((row) => row.key));
    expect(everyRow.filter((key) => key === `agent:${SAFFRON}`)).toHaveLength(1);

    // A match the section's own filter hides is still drawn, in Direct messages.
    const filtered: SidebarState = {
      ...state,
      prefs: prefs({ ...state.prefs, groups: [{ ...smart, displayFilter: 'attention' }] }),
    };
    expect(keys(filtered, 'group:codex')).toEqual([]);
    expect(keys(filtered, 'dms')).toContain(`agent:${SAFFRON}`);
  });

  it('silences the agent row when its conversation is muted, an @mention still piercing', () => {
    const muted: SidebarState = {
      ...busyFixture,
      prefs: prefs({ ...busyFixture.prefs, muted: [{ kind: 'room', roomId: 'dm-cardamom' }] }),
    };
    const row = section(muted, 'dms')?.rows.find((entry) => entry.key === `agent:${CARDAMOM}`);
    expect(row?.muted).toBe(true);
    expect(row?.unread).toEqual({ tier: 'none' });

    const pierced = section({ ...muted, mentions: { 'dm-cardamom': 1 } }, 'dms')?.rows.find(
      (entry) => entry.key === `agent:${CARDAMOM}`
    );
    expect(pierced?.unread).toEqual({ tier: 'directed', count: 1 });
  });

  it('ends with the way to start a conversation with anybody', () => {
    const rows = section(busyFixture, 'dms')?.rows ?? [];
    expect(rows.at(-1)).toMatchObject({
      primary: 'Message an agent or person',
      target: { kind: 'command', commandId: 'message-someone' },
      draggable: false,
    });
  });

  it('stands even when empty, its one row the way to message an agent', () => {
    // Day one: agents, and no direct message with any of them.
    const dms = section(firstRunFixture, 'dms');
    expect(dms?.rows.map((row) => [row.primary, row.target])).toEqual([
      ['Message an agent', { kind: 'command', commandId: 'message-agent' }],
    ]);
  });

  it('sorts by name by default, and by the conversation’s own time when asked', () => {
    const state: SidebarState = {
      ...busyFixture,
      rooms: [
        agentDm('dm-saffron', SAFFRON, 'saffron', { lastActivityAt: hoursAgo(1) }),
        agentDm('dm-cardamom', CARDAMOM, 'cardamom', { lastActivityAt: hoursAgo(5) }),
      ],
      prefs: prefs(),
    };
    expect(keys(state, 'dms').slice(0, 2)).toEqual([`agent:${CARDAMOM}`, `agent:${SAFFRON}`]);

    const recent = {
      ...state,
      prefs: prefs({ sections: { dms: { collapsed: false, sortMode: 'recent' } } }),
    };
    expect(keys(recent, 'dms').slice(0, 2)).toEqual([`agent:${SAFFRON}`, `agent:${CARDAMOM}`]);
    expect(section(recent, 'dms')?.options).toEqual({ sortMode: 'recent' });
  });

  it('makes every conversation a drag source, and no door', () => {
    for (const row of section(busyFixture, 'dms')?.rows ?? []) {
      expect(row.draggable).toBe(row.target.kind !== 'command');
    }
  });
});

describe('Channels', () => {
  it('orders by name by default, and by recent activity when the section says so', () => {
    expect(keys(busyFixture, 'channels')).toEqual([
      'room:room-design',
      'room:room-noise',
      'room:room-releases',
      'room:room-team',
    ]);
    const recent: SidebarState = {
      ...busyFixture,
      rooms: [
        room({ id: 'a', kind: 'channel', title: 'alpha', lastActivityAt: hoursAgo(5) }),
        room({ id: 'b', kind: 'channel', title: 'beta', lastActivityAt: hoursAgo(1) }),
      ],
      prefs: prefs({ sections: { channels: { collapsed: false, sortMode: 'recent' } } }),
    };
    expect(keys(recent, 'channels')).toEqual(['room:b', 'room:a']);
  });

  it('is absent with no channel to show', () => {
    expect(section(emptyState(), 'channels')).toBeUndefined();
  });

  it('bolds a channel with activity and counts only what was aimed at you', () => {
    const rows = section(busyFixture, 'channels')?.rows ?? [];
    expect(rows.find((row) => row.key === 'room:room-releases')?.unread).toEqual({
      tier: 'activity',
    });
    // Muted, with a mention in it: the mention pierces.
    expect(rows.find((row) => row.key === 'room:room-noise')?.unread).toEqual({
      tier: 'directed',
      count: 1,
    });
  });
});

describe('the operator’s own sections', () => {
  it('evaluates a smart section’s membership live', () => {
    const codex = section(powerFixture, 'group:group-codex');
    expect(codex?.rows.length).toBeGreaterThan(0);
    for (const row of codex?.rows ?? []) {
      const path = row.target.kind === 'agent' ? row.target.path : '';
      expect(powerFixture.agents.find((entry) => entry.path === path)?.runtime).toBe('codex');
      // Rule-owned membership is not something to drag out.
      expect(row.draggable).toBe(false);
    }
  });

  it('renders an empty section rather than dropping it', () => {
    const state: SidebarState = {
      ...quietFixture,
      prefs: prefs({ groups: [manualGroup('empty', 'Later', [])] }),
    };
    expect(section(state, 'group:empty')?.rows).toEqual([]);
  });

  it('applies a section’s display filter to its agents, never to its rooms', () => {
    const state: SidebarState = {
      ...busyFixture,
      prefs: prefs({
        groups: [
          {
            ...manualGroup('g', 'Mixed', [
              { kind: 'agent', path: CARDAMOM },
              { kind: 'agent', path: JUNIPER },
              { kind: 'room', roomId: 'room-design' },
            ]),
            displayFilter: 'attention',
          },
        ],
      }),
    };
    expect(keys(state, 'group:g')).toEqual([`agent:${CARDAMOM}`, 'room:room-design']);
  });

  it('takes a filed room out of its home section', () => {
    const state: SidebarState = {
      ...busyFixture,
      prefs: prefs({
        groups: [manualGroup('g', 'Design', [{ kind: 'room', roomId: 'room-design' }])],
      }),
    };
    expect(keys(state, 'channels')).not.toContain('room:room-design');
    expect(keys(state, 'group:g')).toEqual(['room:room-design']);
  });

  it('offers SMART sections at eight agents or two runtimes', () => {
    const seven = Array.from({ length: 7 }, (_, index) => agent(`/a/${index}`));
    expect(offersGroupAffordances(seven)).toBe(false);
    expect(offersGroupAffordances([...seven, agent('/a/8')])).toBe(true);
    expect(offersGroupAffordances([agent('/a'), agent('/b', { runtime: 'codex' })])).toBe(true);
  });
});

describe('BC-31 — a folded section keeps its signal', () => {
  /** `busy` with one section folded. */
  function folded(id: 'dms' | 'channels', overrides: Partial<SidebarState> = {}): SidebarState {
    return {
      ...busyFixture,
      prefs: prefs({ ...busyFixture.prefs, sections: { [id]: { collapsed: true } } }),
      ...overrides,
    };
  }

  it('keeps the rows with unread on screen, and only those, as no drag source', () => {
    const dms = section(folded('dms'), 'dms');
    expect(dms?.collapsed).toBe(true);
    expect(dms?.rollup?.keptRows.map((row) => row.key)).toEqual([
      `agent:${CARDAMOM}`,
      'room:dm-priya',
    ]);
    expect(dms?.rollup?.keptRows.some((row) => row.draggable)).toBe(false);
  });

  it('keeps the way to message an agent when an empty Direct messages is folded', () => {
    const state: SidebarState = {
      ...firstRunFixture,
      prefs: prefs({ ...firstRunFixture.prefs, sections: { dms: { collapsed: true } } }),
    };
    const dms = section(state, 'dms');
    expect(dms?.collapsed).toBe(true);
    expect(dms?.rollup?.keptRows.map((row) => row.primary)).toEqual(['Message an agent']);
  });

  it('counts a working agent even before the recent window has seen its turn', () => {
    const state = folded('dms', {
      workingSessionIds: ['ses-brand-new'],
      liveSessionCwds: { 'ses-brand-new': SAFFRON },
    });
    expect(state.sessions.some((entry) => entry.id === 'ses-brand-new')).toBe(false);
    expect(section(state, 'dms')?.rollup?.workingCount).toBe(1);
  });

  it('counts no automated run', () => {
    const state = folded('dms', { workingSessionIds: ['ses-auto-1'] });
    expect(section(state, 'dms')?.rollup?.workingCount).toBe(0);
  });

  it('is absent while the section is open', () => {
    expect(section(busyFixture, 'channels')?.rollup).toBeUndefined();
  });

  it('keeps nothing and counts nothing for a quiet section', () => {
    expect(
      rollUpCollapsedSection(
        [],
        () => false,
        () => false
      )
    ).toEqual({
      keptRows: [],
      workingCount: 0,
      hiddenCount: 0,
    });
  });
});

describe('DOR-3200 — a folded section says how many rows it hides', () => {
  /** `busy` with Direct messages folded. */
  const foldedDms: SidebarState = {
    ...busyFixture,
    prefs: prefs({ ...busyFixture.prefs, sections: { dms: { collapsed: true } } }),
  };

  it('counts every conversation the fold hides, and none it keeps', () => {
    const dms = section(foldedDms, 'dms');
    const kept = dms?.rollup?.keptRows.length ?? 0;
    const conversations = dms?.rows.filter((row) => row.target.kind !== 'command') ?? [];
    expect(kept).toBe(2);
    expect(conversations.length).toBeGreaterThan(kept);
    expect(dms?.rollup?.hiddenCount).toBe(conversations.length - kept);
  });

  /** Direct messages, folded, with `count` agent conversations, `unread` of them unread. */
  function foldedDmsWith(count: number, unread: number): SidebarState {
    const rooms = Array.from({ length: count }, (_, index) => {
      const path = `/Users/dev/code/dm-${index}`;
      return agentDm(`dm-${index}`, path, `dm-${index}`, index < unread ? { unreadCount: 2 } : {});
    });
    return emptyState({
      agents: rooms.map((_, index) => agent(`/Users/dev/code/dm-${index}`)),
      rooms,
      prefs: prefs({ sections: { dms: { collapsed: true } } }),
    });
  }

  it('never counts the "Message an agent or person" door (QA: "· 8 more" hid 7)', () => {
    const dms = section(foldedDmsWith(9, 2), 'dms');
    expect(dms?.rows).toHaveLength(10); // nine conversations and the door
    expect(dms?.rollup?.keptRows).toHaveLength(2);
    expect(dms?.rollup?.hiddenCount).toBe(7);
  });

  it('hides nothing when folded with no conversations, and keeps the door', () => {
    const dms = section(foldedDmsWith(0, 0), 'dms');
    expect(dms?.rollup?.hiddenCount).toBe(0);
    expect(dms?.rollup?.keptRows.map((row) => row.primary)).toEqual(['Message an agent']);
  });

  it('counts only conversations in every folded section of every journey', () => {
    // The guard for the next door: whatever section gains a non-conversation
    // row, its fold must still count conversations only.
    for (const state of [firstRunFixture, quietFixture, busyFixture, powerFixture]) {
      const folded: SidebarState = {
        ...state,
        prefs: prefs({
          ...state.prefs,
          sections: Object.fromEntries(SIDEBAR_SECTION_IDS.map((id) => [id, { collapsed: true }])),
          groups: state.prefs.groups.map((group) => ({ ...group, collapsed: true })),
        }),
      };
      for (const entry of sections(folded)) {
        if (entry.rollup === undefined) continue;
        const conversations = entry.rows.filter((row) => row.target.kind !== 'command');
        const keptConversations = entry.rollup.keptRows.filter(
          (row) => row.target.kind !== 'command'
        );
        expect(entry.rollup.hiddenCount, entry.id).toBe(
          conversations.length - keptConversations.length
        );
      }
    }
  });

  it('counts zero when every row stays on screen', () => {
    const kept = section(foldedDms, 'dms')?.rollup?.keptRows ?? [];
    expect(kept.length).toBeGreaterThan(0);
    expect(
      rollUpCollapsedSection(
        kept,
        () => false,
        () => false
      ).hiddenCount
    ).toBe(0);
  });

  it('counts nothing while the section is open', () => {
    const dms = section(busyFixture, 'dms');
    expect(dms?.collapsed).toBe(false);
    expect(dms?.rollup).toBeUndefined();
  });
});

describe('DOR-3224 — a folded section keeps an agent waiting on you', () => {
  const OPS = manualGroup('ops', 'Ops', [
    { kind: 'agent', path: TANGERINE },
    { kind: 'agent', path: CARDAMOM },
    { kind: 'agent', path: SAFFRON },
  ]);

  /** Three read, idle agents in a folded hand-made section. */
  function foldedOps(overrides: Partial<SidebarState> = {}): SidebarState {
    return emptyState({
      agents: [agent(TANGERINE), agent(CARDAMOM), agent(SAFFRON)],
      prefs: prefs({ groups: [{ ...OPS, collapsed: true }] }),
      ...overrides,
    });
  }

  /** Cardamom has a session waiting on an approval, and nothing unread. */
  const cardamomBlocked: Partial<SidebarState> = {
    blockedSessionIds: ['ses-approval'],
    liveSessionCwds: { 'ses-approval': CARDAMOM },
  };

  it('keeps a needs-you row with 0 unread, and leaves it out of the count', () => {
    const ops = section(foldedOps(cardamomBlocked), 'group:ops');
    expect(ops?.rollup?.keptRows.map((row) => row.key)).toEqual([`agent:${CARDAMOM}`]);
    expect(ops?.rollup?.keptRows[0]?.unread).toEqual({ tier: 'none' });
    expect(ops?.rollup?.hiddenCount).toBe(2);
  });

  it('draws the kept row as the open section does, in the same order', () => {
    const state = foldedOps(cardamomBlocked);
    const open: SidebarState = { ...state, prefs: prefs({ groups: [OPS] }) };
    const openRows = section(open, 'group:ops')?.rows ?? [];
    const kept = section(state, 'group:ops')?.rollup?.keptRows[0];
    expect(kept).toEqual({
      ...openRows.find((row) => row.key === `agent:${CARDAMOM}`),
      draggable: false,
    });
    expect(section(state, 'group:ops')?.rows.map((row) => row.key)).toEqual(
      openRows.map((row) => row.key)
    );
  });

  it('still hides and counts a read, idle row', () => {
    const ops = section(foldedOps(), 'group:ops');
    expect(ops?.rollup?.keptRows).toEqual([]);
    expect(ops?.rollup?.hiddenCount).toBe(3);
  });

  it('keeps a needs-you row in a folded Direct messages', () => {
    const state = emptyState({
      agents: [agent(TANGERINE), agent(CARDAMOM)],
      rooms: [
        agentDm('dm-tangerine', TANGERINE, 'tangerine'),
        agentDm('dm-cardamom', CARDAMOM, 'cardamom'),
      ],
      prefs: prefs({ sections: { dms: { collapsed: true } } }),
      ...cardamomBlocked,
    });
    const dms = section(state, 'dms');
    expect(dms?.rollup?.keptRows.map((row) => row.key)).toEqual([`agent:${CARDAMOM}`]);
    expect(dms?.rollup?.hiddenCount).toBe(1);
  });

  it('keeps a muted agent waiting on you, and leaves it out of the count (DOR-3236)', () => {
    // Mute silences chatter, never a request.
    const state = foldedOps({
      ...cardamomBlocked,
      prefs: prefs({
        groups: [{ ...OPS, collapsed: true }],
        muted: [{ kind: 'agent', path: CARDAMOM }],
      }),
    });
    const ops = section(state, 'group:ops');
    expect(ops?.rollup?.keptRows.map((row) => row.key)).toEqual([`agent:${CARDAMOM}`]);
    // Still drawn muted: the dimmed name and mute icon stay.
    expect(ops?.rollup?.keptRows[0]?.muted).toBe(true);
    expect(ops?.rollup?.hiddenCount).toBe(2);
  });

  it('hides a muted agent again once nothing is waiting', () => {
    const state = foldedOps({
      prefs: prefs({
        groups: [{ ...OPS, collapsed: true }],
        muted: [{ kind: 'agent', path: CARDAMOM }],
      }),
    });
    expect(section(state, 'group:ops')?.rollup?.keptRows).toEqual([]);
    expect(section(state, 'group:ops')?.rollup?.hiddenCount).toBe(3);
  });
});

describe('DOR-3236 — a folded Channels keeps a room waiting on you', () => {
  /** Three read channels, Channels folded; `awaiting` sets each one's waiting turns. */
  function foldedChannels(awaiting: [number, number, number], muted = false): SidebarState {
    const rooms = ['ops', 'design', 'ship'].map((slug, index) =>
      room({ id: `room-${slug}`, kind: 'channel', title: slug, awaiting: awaiting[index] })
    );
    return emptyState({
      rooms,
      prefs: prefs({
        sections: { channels: { collapsed: true } },
        ...(muted ? { muted: [{ kind: 'room', roomId: 'room-design' }] } : {}),
      }),
    });
  }

  it('keeps a room with a turn waiting on you, and leaves it out of the count', () => {
    const channels = section(foldedChannels([0, 1, 0]), 'channels');
    expect(channels?.rollup?.keptRows.map((row) => row.key)).toEqual(['room:room-design']);
    expect(channels?.rollup?.hiddenCount).toBe(2);
  });

  it('keeps a muted room waiting on you too, still drawn muted', () => {
    const channels = section(foldedChannels([0, 1, 0], true), 'channels');
    expect(channels?.rollup?.keptRows.map((row) => row.key)).toEqual(['room:room-design']);
    expect(channels?.rollup?.keptRows[0]?.muted).toBe(true);
  });

  it('still hides and counts a read, idle room', () => {
    const channels = section(foldedChannels([0, 0, 0]), 'channels');
    expect(channels?.rollup?.keptRows).toEqual([]);
    expect(channels?.rollup?.hiddenCount).toBe(3);
  });
});

describe('the "N live" chip is decided once, in the model', () => {
  /** Saffron's row in Direct messages with `count` live human sessions. */
  function saffronRow(count: number) {
    const ids = Array.from({ length: count }, (_, index) => `ses-live-${index}`);
    const state: SidebarState = {
      ...busyFixture,
      workingSessionIds: ids,
      liveSessionCwds: Object.fromEntries(ids.map((id) => [id, SAFFRON])),
    };
    return section(state, 'dms')?.rows.find((row) => row.key === `agent:${SAFFRON}`);
  }

  it('says nothing at one live session, and the count from two upwards', () => {
    expect(saffronRow(1)?.reservesVerbLine).toBe(true);
    expect(saffronRow(1)?.liveCount).toBeUndefined();
    expect(saffronRow(2)?.liveCount).toBe(2);
  });

  it('says nothing at all when nothing is running', () => {
    expect(saffronRow(0)?.reservesVerbLine).toBe(false);
    expect(saffronRow(0)?.liveCount).toBeUndefined();
  });
});

/**
 * A hand-made section holding `items`.
 *
 * @param id - Its id.
 * @param name - Its name.
 * @param items - What was filed into it.
 */
function manualGroup(id: string, name: string, items: SidebarGroup['items']): SidebarGroup {
  return {
    id,
    name,
    kind: 'manual',
    items,
    collapsed: false,
    sortMode: 'manual',
    displayFilter: 'all',
    muted: false,
  };
}
