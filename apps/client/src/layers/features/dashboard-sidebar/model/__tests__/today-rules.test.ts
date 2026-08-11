/**
 * Today — the order that agent activity may not touch, the overnight boundary,
 * the anchor, the cap, the automated reveal, the digest, mute and the project
 * chip (BC-16 → BC-22, BC-38, BC-40).
 *
 * @module features/dashboard-sidebar/model/__tests__/today-rules
 */
import type { SessionLifecycle } from '@dorkos/shared/session-stream';
import type { Session } from '@dorkos/shared/types';
import { describe, expect, it } from 'vitest';
import { buildSidebarModel, type SidebarRowModel } from '../build-sidebar-model';
import { HOUR, busyFixture, hoursAgo, prefs, quietFixture, room, session } from '../fixtures';
import { archiveOvernight, overnightBoundary } from '../rules/archive-overnight';
import { buildDigestRow, localDateKey } from '../rules/build-digest-row';
import { deriveProjectLabel } from '../rules/derive-project-label';
import { TODAY_SOFT_CAP, lastInteractionAt, orderToday } from '../rules/order-today';
import { selectTodayItems, sessionOriginMark } from '../rules/select-today-items';
import type { SidebarState } from '../sidebar-state';

/** Today's rows, as the model finally emits them. */
function todayRows(state: SidebarState): SidebarRowModel[] {
  const zone = buildSidebarModel(state).zones.find((entry) => entry.id === 'today');
  return zone?.sections.flatMap((section) => section.rows) ?? [];
}

/** Today's row keys, in order. */
function todayKeys(state: SidebarState): string[] {
  return todayRows(state).map((row) => row.key);
}

describe('BC-16 — order is the operator’s attention, never the agent’s', () => {
  it('survives 100 activity and session_status events unchanged', () => {
    const before = todayKeys(busyFixture);
    // The anchor, eight capped rows, the exempt directed-unread DM, and the
    // automated reveal. Asserted exactly, because a churn test over a list that
    // silently shrank to two rows would still pass.
    expect(before).toHaveLength(11);

    const lifecycles: SessionLifecycle[] = ['streaming', 'idle', 'blocked', 'error', 'interrupted'];
    let state: SidebarState = busyFixture;

    for (let event = 0; event < 100; event += 1) {
      const session = state.sessions[event % state.sessions.length];
      if (!session) continue;
      const lifecycle = lifecycles[event % lifecycles.length] ?? 'idle';
      const working = new Set(state.workingSessionIds);
      if (lifecycle === 'streaming') working.add(session.id);
      else working.delete(session.id);
      const roomIndex = event % state.rooms.length;
      state = {
        ...state,
        // A tool call: the session's own timestamps and preview move.
        sessions: state.sessions.map(
          (entry): Session =>
            entry.id === session.id
              ? {
                  ...entry,
                  updatedAt: new Date(busyFixture.now - (100 - event) * 1000).toISOString(),
                  lastMessagePreview: `tool call ${event}`,
                }
              : entry
        ),
        sessionStatuses: { ...state.sessionStatuses, [session.id]: lifecycle },
        workingSessionIds: [...working],
        // An agent posting in a room: the room's activity moves too.
        rooms: state.rooms.map((entry, index) =>
          index === roomIndex
            ? {
                ...entry,
                lastActivityAt: new Date(busyFixture.now - (100 - event) * 1000).toISOString(),
                working: event % 3,
              }
            : entry
        ),
      };
    }

    expect(todayKeys(state)).toEqual(before);
  });

  it('proves the check can fail — the operator opening something DOES reorder', () => {
    const before = todayKeys(busyFixture);
    const moved = todayKeys({
      ...busyFixture,
      interactions: { ...busyFixture.interactions, 'room:dm-kai': hoursAgo(0.05) },
    });
    expect(moved).not.toEqual(before);
    expect(moved[1]).toBe('room:dm-kai');
  });

  it('takes the later of the two halves of the order key', () => {
    const row = todayRows(busyFixture).find((entry) => entry.key === 'room:room-releases');
    expect(row).toBeDefined();
    // Opened 2.8h ago, written in 0.3h ago — the write is what orders it, so it
    // sits above every session touched longer ago than that.
    expect(todayKeys(busyFixture)[1]).toBe('room:room-releases');
  });

  it('governs by the interaction alone when the server cannot say', () => {
    const state = { ...busyFixture, userLastMessageAt: {} };
    const row = todayRows(state).find((entry) => entry.key === 'room:room-releases');
    expect(row).toBeDefined();
    expect(lastInteractionAt(row as SidebarRowModel, state)).toBe(
      Date.parse(busyFixture.interactions['room:room-releases'] ?? '')
    );
  });

  it('orders rollup rows last whatever their timestamps', () => {
    expect(todayKeys(busyFixture).at(-1)).toBe('rollup:automated');
  });
});

describe('BC-18 — the overnight boundary', () => {
  it('is the most recent 04:00 local that has passed', () => {
    const morning = new Date(2026, 7, 9, 9, 15).getTime();
    expect(new Date(overnightBoundary(morning)).getHours()).toBe(4);
    expect(new Date(overnightBoundary(morning)).getDate()).toBe(9);
  });

  it('is yesterday’s 04:00 for somebody still up at 01:00', () => {
    const lateNight = new Date(2026, 7, 9, 1, 0).getTime();
    expect(new Date(overnightBoundary(lateNight)).getDate()).toBe(8);
    expect(new Date(overnightBoundary(lateNight)).getHours()).toBe(4);
  });

  it('takes a row last touched yesterday afternoon out of Today', () => {
    expect(todayKeys(quietFixture)).not.toContain('session:ses-lastnight');
    expect(todayKeys(quietFixture)).toContain('session:ses-morning');
  });

  it('keeps that row when the clock has not crossed the boundary yet', () => {
    // 02:00 the same night: the boundary is yesterday 04:00, so nothing has
    // aged out. The row that was archived at 09:15 is present.
    const beforeBoundary = new Date(2026, 7, 8, 23, 0).getTime();
    expect(todayKeys({ ...quietFixture, now: beforeBoundary })).toContain('session:ses-lastnight');
  });

  it('exempts the anchor', () => {
    const state: SidebarState = {
      ...quietFixture,
      activeTarget: {
        kind: 'session',
        sessionId: 'ses-lastnight',
        agentPath: '/Users/dev/code/tangerine',
        cwd: '/Users/dev/code/tangerine',
      },
    };
    expect(todayKeys(state)[0]).toBe('session:ses-lastnight');
  });

  it('exempts a row carrying a directed unread', () => {
    const state: SidebarState = {
      ...quietFixture,
      rooms: [
        ...quietFixture.rooms,
        room({ id: 'dm-old', kind: 'dm', title: 'Priya', unreadCount: 3, participants: [] }),
      ],
      interactions: { ...quietFixture.interactions, 'room:dm-old': hoursAgo(20) },
    };
    expect(todayKeys(state)).toContain('room:dm-old');
  });

  it('leaves alone a row it has no interaction time for', () => {
    const rows = archiveOvernight(
      [
        {
          key: 'rollup:automated',
          target: { kind: 'rollup', rollup: 'automated' },
          glyph: { kind: 'icon', icon: 'automated' },
          primary: '+ 1 automated',
          status: 'idle',
          reservesVerbLine: false,
          unread: { tier: 'none' },
          muted: false,
          draggable: false,
          actions: ['open'],
          reason: 'rollup:automated',
        },
      ],
      quietFixture
    );
    expect(rows).toHaveLength(1);
  });
});

describe('BC-19 / BC-20 — automated sessions and the soft cap', () => {
  it('gives an automated session no top-level row', () => {
    const keys = todayKeys(busyFixture);
    expect(keys).not.toContain('session:ses-auto-1');
    expect(keys).not.toContain('session:ses-auto-2');
    expect(keys).toContain('rollup:automated');
  });

  it('counts them on the reveal row', () => {
    const row = todayRows(busyFixture).find((entry) => entry.key === 'rollup:automated');
    expect(row?.primary).toBe('+ 2 automated');
  });

  it('unfolds the runs underneath the reveal when the operator opens it', () => {
    const rows = todayRows({ ...busyFixture, todayAutomatedExpanded: true });
    const keys = rows.map((row) => row.key);
    expect(keys).toContain('session:ses-auto-1');
    expect(keys).toContain('session:ses-auto-2');
    // Underneath, never above: the reveal is the thing they hang off.
    expect(keys.indexOf('session:ses-auto-1')).toBeGreaterThan(keys.indexOf('rollup:automated'));
    expect(keys.indexOf('session:ses-auto-2')).toBeGreaterThan(keys.indexOf('rollup:automated'));
    // Origin-marked (BC-19), which is the whole reason they are legible as runs
    // rather than as conversations somebody had.
    expect(rows.find((row) => row.key === 'session:ses-auto-1')?.origin).toBeDefined();
    expect(rows.find((row) => row.key === 'session:ses-auto-1')?.reason).toBe('today:automated');
  });

  it('draws a revealed run ONCE when the operator has that very run open', () => {
    // The ordinary flow, and the collision it used to produce: press the
    // reveal, click a run. The anchor branch draws it at the top because the
    // conversations loop filtered it out, and the reveal used to append it
    // again — two rows keyed `session:ses-auto-1` inside one section, which is
    // a duplicate React key rather than a cosmetic repeat.
    const state: SidebarState = {
      ...busyFixture,
      todayAutomatedExpanded: true,
      activeTarget: {
        kind: 'session',
        sessionId: 'ses-auto-1',
        agentPath: '/Users/dev/code/tangerine',
        cwd: '/Users/dev/code/tangerine',
      },
    };
    const keys = todayKeys(state);
    expect(keys.filter((key) => key === 'session:ses-auto-1')).toHaveLength(1);
    expect(new Set(keys).size).toBe(keys.length);
    // Still at the top, and still revealed beside its sibling — the dedupe
    // keeps the anchor, not the copy underneath.
    expect(keys[0]).toBe('session:ses-auto-1');
    expect(keys).toContain('session:ses-auto-2');
  });

  it('says how to put them away again once they are open', () => {
    const row = todayRows({ ...busyFixture, todayAutomatedExpanded: true }).find(
      (entry) => entry.key === 'rollup:automated'
    );
    expect(row?.primary).toBe('Hide automated');
  });

  it('spends none of the soft cap on the unfolded runs', () => {
    const capped = (state: SidebarState) =>
      todayRows(state).filter((row) => row.reason === 'today:interaction-recency').length;
    expect(capped({ ...busyFixture, todayAutomatedExpanded: true })).toBe(capped(busyFixture));
  });

  it('unfolds nothing when there is no reveal row to unfold from', () => {
    const state: SidebarState = {
      ...busyFixture,
      sessions: busyFixture.sessions.filter((session) => session.origin === undefined),
      todayAutomatedExpanded: true,
    };
    expect(todayKeys(state)).not.toContain('rollup:automated');
    expect(todayKeys(state).filter((key) => key.startsWith('session:ses-auto'))).toEqual([]);
  });

  it('keeps a muted agent’s runs folded away even when the reveal is open', () => {
    const automated = busyFixture.sessions.find((entry) => entry.id === 'ses-auto-1');
    expect(automated?.cwd).toBeDefined();
    const state: SidebarState = {
      ...busyFixture,
      todayAutomatedExpanded: true,
      prefs: prefs({ muted: [{ kind: 'agent', path: automated?.cwd ?? '' }] }),
    };
    expect(todayKeys(state)).not.toContain('session:ses-auto-1');
  });

  it('emits no reveal row when nothing is automated', () => {
    const state = {
      ...busyFixture,
      sessions: busyFixture.sessions.filter((session) => session.origin === undefined),
    };
    expect(todayKeys(state)).not.toContain('rollup:automated');
  });

  it('shows eight non-exempt rows and no more', () => {
    const rows = todayRows(busyFixture).filter(
      (row) =>
        row.target.kind !== 'rollup' &&
        row.reason !== 'anchor:active-session' &&
        row.unread.tier !== 'directed'
    );
    expect(rows).toHaveLength(TODAY_SOFT_CAP);
  });

  it('exempts the anchor and every directed unread from the cap', () => {
    const keys = todayKeys(busyFixture);
    expect(keys[0]).toBe('session:ses-1');
    // dm-priya was touched longer ago than eight other rows and survives anyway.
    expect(keys).toContain('room:dm-priya');
  });
});

describe('BC-21 — the active-conversation anchor', () => {
  it('is Today’s first row and says why', () => {
    const rows = todayRows(busyFixture);
    expect(rows[0]?.key).toBe('session:ses-1');
    expect(rows[0]?.reason).toBe('anchor:active-session');
  });

  it('is present even before anything has been recorded about it', () => {
    const state: SidebarState = {
      ...busyFixture,
      interactions: {},
      userLastMessageAt: {},
    };
    expect(todayKeys(state)[0]).toBe('session:ses-1');
  });

  it('never appears in Now', () => {
    const now = buildSidebarModel(busyFixture).zones.find((zone) => zone.id === 'now');
    const keys = now?.sections.flatMap((section) => section.rows.map((row) => row.key)) ?? [];
    expect(keys).not.toContain('session:ses-1');
  });

  it('anchors a room as readily as a session', () => {
    const state: SidebarState = {
      ...busyFixture,
      activeTarget: { kind: 'room', roomId: 'room-design', roomKind: 'channel' },
    };
    expect(todayKeys(state)[0]).toBe('room:room-design');
  });

  it('anchors nothing for an agent route', () => {
    const state: SidebarState = {
      ...busyFixture,
      activeTarget: { kind: 'agent', path: '/Users/dev/code/tangerine' },
    };
    expect(todayRows(state)[0]?.reason).toBe('today:interaction-recency');
  });
});

describe('BC-22 — the morning digest', () => {
  it('appears once when the date has turned and there is content', () => {
    expect(buildDigestRow(quietFixture)?.reason).toBe('today:digest');
    expect(todayKeys(quietFixture)[0]).toBe('digest:today');
  });

  it('is absent once it has been shown today', () => {
    const state = {
      ...quietFixture,
      prefs: prefs({
        ...quietFixture.prefs,
        digest: { lastShownDate: localDateKey(quietFixture.now) },
      }),
    };
    expect(buildDigestRow(state)).toBeNull();
  });

  it('is absent when nothing finished while they were away', () => {
    expect(buildDigestRow({ ...quietFixture, digest: { finishedWhileAwayCount: 0 } })).toBeNull();
  });

  it('sits below the anchor, never above it', () => {
    const state: SidebarState = {
      ...quietFixture,
      activeTarget: {
        kind: 'session',
        sessionId: 'ses-morning',
        agentPath: '/Users/dev/code/tangerine',
        cwd: '/Users/dev/code/tangerine',
      },
    };
    expect(todayKeys(state).slice(0, 2)).toEqual(['session:ses-morning', 'digest:today']);
  });

  it('reads the local calendar day, not UTC', () => {
    expect(localDateKey(new Date(2026, 7, 9, 23, 30).getTime())).toBe('2026-08-09');
    expect(localDateKey(new Date(2026, 7, 10, 0, 30).getTime())).toBe('2026-08-10');
  });
});

describe('BC-38 — the project chip', () => {
  it('is absent for a single-project operator', () => {
    expect(deriveProjectLabel('/repos/dorkos', { activeCount: 1, byCwd: {} })).toBeUndefined();
  });

  it('is the basename of the cwd once there is more than one', () => {
    expect(deriveProjectLabel('/repos/dorkos', { activeCount: 2, byCwd: {} })).toBe('dorkos');
    expect(deriveProjectLabel('/repos/dorkos/', { activeCount: 2, byCwd: {} })).toBe('dorkos');
  });

  it('is absent for a session with no cwd', () => {
    expect(deriveProjectLabel(undefined, { activeCount: 3, byCwd: {} })).toBeUndefined();
  });

  it('lands on session rows only', () => {
    for (const row of todayRows(busyFixture)) {
      if (row.target.kind !== 'session') expect(row.projectLabel).toBeUndefined();
    }
    const session = todayRows(busyFixture).find((row) => row.target.kind === 'session');
    expect(session?.projectLabel).toBe('tangerine');
  });

  it('disappears entirely when the operator drops to one project', () => {
    const state = { ...busyFixture, projects: { activeCount: 1, byCwd: {} } };
    expect(todayRows(state).every((row) => row.projectLabel === undefined)).toBe(true);
  });
});

describe('BC-40 — mute, and the one thing that pierces it', () => {
  it('takes a muted room out of Today', () => {
    expect(todayKeys(busyFixture)).not.toContain('room:room-noise');
  });

  it('keeps the muted room in Library, marked and quiet', () => {
    const library = buildSidebarModel(busyFixture).zones.find((zone) => zone.id === 'library');
    const rows = library?.sections.flatMap((section) => section.rows) ?? [];
    const noise = rows.find((row) => row.key === 'room:room-noise');
    expect(noise?.muted).toBe(true);
    // 31 unread messages, and the badge shows the ONE mention, not the volume.
    expect(noise?.unread).toEqual({ tier: 'directed', count: 1 });
  });

  it('shows nothing at all on a muted room with no mention', () => {
    const state: SidebarState = { ...busyFixture, mentions: {} };
    const library = buildSidebarModel(state).zones.find((zone) => zone.id === 'library');
    const rows = library?.sections.flatMap((section) => section.rows) ?? [];
    expect(rows.find((row) => row.key === 'room:room-noise')?.unread).toEqual({ tier: 'none' });
  });

  it('keeps the anchor visible even when the operator muted it', () => {
    const state: SidebarState = {
      ...busyFixture,
      activeTarget: { kind: 'room', roomId: 'room-noise', roomKind: 'channel' },
    };
    expect(todayKeys(state)[0]).toBe('room:room-noise');
  });

  it('kills the badge on a muted conversation you have open', () => {
    // The anchor is the ONE muted row Today still shows, so it is the one place
    // mute's quietening half can leak. Priya has two unread DMs and no mention
    // of the operator, so BC-40's @mention exception does not apply: a muted DM
    // you are standing in shows no badge at all.
    const state: SidebarState = {
      ...busyFixture,
      prefs: prefs({
        ...busyFixture.prefs,
        muted: [...busyFixture.prefs.muted, { kind: 'room', roomId: 'dm-priya' }],
      }),
      activeTarget: { kind: 'room', roomId: 'dm-priya', roomKind: 'dm' },
    };
    const anchor = todayRows(state)[0];
    expect(anchor?.key).toBe('room:dm-priya');
    expect(anchor?.muted).toBe(true);
    expect(anchor?.unread).toEqual({ tier: 'none' });
  });

  it('still lets an @mention pierce mute on the conversation you have open', () => {
    const state: SidebarState = {
      ...busyFixture,
      mentions: { ...busyFixture.mentions, 'dm-priya': 1 },
      prefs: prefs({
        ...busyFixture.prefs,
        muted: [...busyFixture.prefs.muted, { kind: 'room', roomId: 'dm-priya' }],
      }),
      activeTarget: { kind: 'room', roomId: 'dm-priya', roomKind: 'dm' },
    };
    expect(todayRows(state)[0]?.unread).toEqual({ tier: 'directed', count: 1 });
  });

  it('kills the badge on a muted room row that survives on a directed unread', () => {
    // The second leak path: a muted room stays in Today when it carries a
    // directed unread (BC-18 exempts it from archival), so the quietening has
    // to have happened before the row was ever considered.
    const state: SidebarState = {
      ...busyFixture,
      prefs: prefs({
        ...busyFixture.prefs,
        muted: [...busyFixture.prefs.muted, { kind: 'room', roomId: 'dm-priya' }],
      }),
    };
    expect(todayKeys(state)).not.toContain('room:dm-priya');
  });

  it('mutes a session through the agent it belongs to', () => {
    const state: SidebarState = {
      ...busyFixture,
      prefs: prefs({
        ...busyFixture.prefs,
        muted: [{ kind: 'agent', path: '/Users/dev/code/tangerine' }],
      }),
    };
    // ses-1 is the anchor and stays; it renders muted, and its menu offers
    // unmute rather than mute.
    const anchor = todayRows(state)[0];
    expect(anchor?.key).toBe('session:ses-1');
    expect(anchor?.muted).toBe(true);
    expect(anchor?.actions).toContain('unmute');
    // Its non-anchor sibling on the same agent is gone.
    expect(todayKeys(state)).not.toContain('session:ses-2');
  });
});

describe('selectTodayItems — membership', () => {
  it('admits only what the operator has interacted with', () => {
    const state: SidebarState = { ...busyFixture, interactions: {}, userLastMessageAt: {} };
    const keys = selectTodayItems(state).map((row) => row.key);
    // Only the anchor and the automated rollup survive an empty interaction map.
    expect(keys.filter((key) => key !== 'rollup:automated')).toEqual(['session:ses-1']);
  });

  it('renders a thread as a conversation with a thread origin mark', () => {
    const thread = selectTodayItems(busyFixture).find((row) => row.key.startsWith('thread:'));
    expect(thread?.origin).toBe('thread');
    // The root entry rides along so the row can open the thread PANEL rather
    // than only the room it lives in — `/channels?thread=` is its address.
    expect(thread?.target).toEqual({
      kind: 'room',
      roomId: 'room-design',
      roomKind: 'thread',
      rootEntryId: 'entry-77',
    });
  });

  it('BC-15 — that thread actually reaches Today, not just the selection rule', () => {
    const thread = todayRows(busyFixture).find((row) => row.key.startsWith('thread:'));
    expect(thread).toBeDefined();
    expect(thread?.origin).toBe('thread');
  });

  it('draws no agent face for a session that belongs to no agent (DOR-203)', () => {
    const state: SidebarState = {
      ...busyFixture,
      sessions: [session({ id: 'ses-orphan', title: 'No cwd', cwd: undefined })],
      interactions: { 'session:ses-orphan': hoursAgo(0.1) },
      activeTarget: null,
    };
    const row = selectTodayItems(state).find((entry) => entry.key === 'session:ses-orphan');
    expect(row?.glyph).toEqual({ kind: 'icon', icon: 'session' });
    expect(row?.primary).toBe('Session');
  });

  it('reserves a verb line for a streaming session and nothing else', () => {
    const rows = selectTodayItems(busyFixture);
    expect(rows.find((row) => row.key === 'session:ses-1')?.reservesVerbLine).toBe(true);
    expect(rows.find((row) => row.key === 'session:ses-2')?.reservesVerbLine).toBe(false);
  });

  it('drops an archived room', () => {
    const state: SidebarState = {
      ...busyFixture,
      rooms: busyFixture.rooms.map((entry) =>
        entry.id === 'room-design' ? { ...entry, archived: true } : entry
      ),
    };
    expect(selectTodayItems(state).map((row) => row.key)).not.toContain('room:room-design');
  });
});

describe('BC-26 — origin marks', () => {
  it('gives a bridged chat the paper plane, never the room mark', () => {
    // `channel` is a BRIDGED chat — Telegram, Slack, a webhook — and `room` is
    // one of this machine's own rooms. `SessionOriginSchema` says so in as many
    // words. Drawing them alike tells the operator Telegram was a cockpit
    // channel, which is the exact collapse the schema exists to prevent.
    expect(sessionOriginMark('channel')).toBe('bridged');
    expect(sessionOriginMark('external')).toBe('bridged');
  });

  it('keeps the room mark for this machine’s own rooms', () => {
    expect(sessionOriginMark('room')).toBe('room');
  });

  it('marks the remaining origins per the table', () => {
    expect(sessionOriginMark('task')).toBe('timer');
    expect(sessionOriginMark('agent')).toBe('agent');
  });

  it('draws nothing for the unmarked default — a human talking to an agent', () => {
    expect(sessionOriginMark(undefined)).toBeUndefined();
    expect(sessionOriginMark('user')).toBeUndefined();
  });

  it('is not reachable through Today’s own session rows, and that is why it is tested here', () => {
    // Every origin the table maps is one `partitionSessionsByOrigin` classes as
    // automated, and BC-19 keeps those off Today's top level. If this ever
    // stops being true, delete this test and assert through the rows instead.
    const automatedOnly: SidebarState = {
      ...busyFixture,
      sessions: [session({ id: 'ses-tg', title: 'From Telegram', origin: 'channel' })],
      interactions: { 'session:ses-tg': hoursAgo(0.05) },
      userLastMessageAt: {},
      activeTarget: null,
    };
    // No session row — which is the point — and no reveal either: the reveal
    // stands FOR a list, so on its own it would be a heading and one inert row
    // on a fresh install (BC-19, BC-1's blind spot).
    expect(selectTodayItems(automatedOnly)).toEqual([]);

    // With something to stand beside, it appears — and still draws no session
    // row of its own, so the origin mark remains unreachable from here.
    const withCompany: SidebarState = {
      ...automatedOnly,
      sessions: [
        ...automatedOnly.sessions,
        session({ id: 'ses-mine', title: 'Ship the parser', cwd: '/Users/dev/code/tangerine' }),
      ],
      interactions: {
        'session:ses-tg': hoursAgo(0.05),
        'session:ses-mine': hoursAgo(0.05),
      },
    };
    const keys = selectTodayItems(withCompany).map((row) => row.key);
    expect(keys).toContain('rollup:automated');
    expect(keys).not.toContain('session:ses-tg');
  });
});

describe('orderToday — determinism', () => {
  it('breaks a tie the same way every time', () => {
    const state: SidebarState = {
      ...busyFixture,
      interactions: Object.fromEntries(
        Object.keys(busyFixture.interactions).map((key) => [key, hoursAgo(1)])
      ),
    };
    const first = orderToday(selectTodayItems(state), state).map((row) => row.key);
    const second = orderToday([...selectTodayItems(state)].reverse(), state).map((row) => row.key);
    expect(second).toEqual(first);
  });

  it('sorts a row it has no interaction time for below every row it does', () => {
    const state: SidebarState = {
      ...quietFixture,
      interactions: { 'session:ses-morning': hoursAgo(3) },
      userLastMessageAt: {},
      activeTarget: null,
    };
    const rows = orderToday(selectTodayItems(quietFixture), state).map((row) => row.key);
    expect(rows[0]).toBe('session:ses-morning');
    expect(rows.slice(1)).toContain('room:room-releases');
  });

  it('holds its order as the clock moves', () => {
    const later: SidebarState = { ...quietFixture, now: quietFixture.now + HOUR };
    expect(orderToday(selectTodayItems(later), later).map((row) => row.key)).toEqual(
      orderToday(selectTodayItems(quietFixture), quietFixture).map((row) => row.key)
    );
  });
});
