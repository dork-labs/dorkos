/**
 * Heads up and Getting started — membership, priority, the cap, the working rollup,
 * and the one slot the two zones share (BC-4 → BC-14).
 *
 * @module features/dashboard-sidebar/model/__tests__/now-rules
 */
import { describe, expect, it } from 'vitest';
import { buildSidebarModel, type SidebarRowModel } from '../build-sidebar-model';
import { busyFixture, firstRunFixture, hoursAgo, powerFixture, quietFixture } from '../fixtures';
import { buildWorkingRollup } from '../rules/build-working-rollup';
import { NOW_OVERFLOW_HREF, capNowItems } from '../rules/cap-now-items';
import { rankNowItems } from '../rules/rank-now-items';
import { selectNowItems } from '../rules/select-now-items';
import type { SidebarAttentionSignal, SidebarState } from '../sidebar-state';

/** A signal of one kind, raised `hours` ago. */
function signal(
  id: string,
  kind: SidebarAttentionSignal['kind'],
  hours: number
): SidebarAttentionSignal {
  return {
    id,
    kind,
    primary: id,
    since: hoursAgo(hours),
    deepLink: `/session?sessionId=${id}`,
  };
}

/** The rows of one zone, or `[]` when the zone is absent. */
function zoneRows(state: SidebarState, id: string): SidebarRowModel[] {
  const zone = buildSidebarModel(state).zones.find((entry) => entry.id === id);
  return zone?.sections.flatMap((section) => section.rows) ?? [];
}

describe('BC-5 — only four things enter Heads up', () => {
  it('admits the four blockages', () => {
    const state: SidebarState = {
      ...busyFixture,
      attention: [
        signal('a', 'permission-prompt', 1),
        signal('b', 'question', 1),
        signal('c', 'error', 1),
        signal('d', 'schedule-approval', 1),
      ],
    };
    expect(selectNowItems(state).map((row) => row.reason)).toEqual([
      'now:permission-prompt',
      'now:question',
      'now:error',
      'now:schedule-approval',
    ]);
  });

  it('draws a parked schedule with the calendar glyph, not an agent face', () => {
    // A schedule belongs to nobody's face — `deriveAttentionSignals` gives it no
    // `agentPath` — so the glyph slot carries the semantic icon instead.
    const rows = selectNowItems({
      ...busyFixture,
      attention: [signal('tsk', 'schedule-approval', 0.3)],
    });
    expect(rows[0]?.glyph).toEqual({ kind: 'icon', icon: 'schedule' });
  });

  it('has no branch that admits a mention, a DM or an unread channel', () => {
    // The signals below are the ones §18 forbids, spelled the way a caller
    // might try to smuggle them in. The allowlist drops them.
    const smuggled = [
      { ...signal('m', 'question', 1), kind: 'mention' },
      { ...signal('n', 'question', 1), kind: 'dm' },
      { ...signal('o', 'question', 1), kind: 'unread' },
      { ...signal('p', 'question', 1), kind: 'update-ready' },
      { ...signal('q', 'question', 1), kind: 'automated-activity' },
    ] as unknown as SidebarAttentionSignal[];
    expect(selectNowItems({ ...busyFixture, attention: smuggled })).toEqual([]);
  });

  it('BC-39 — an agent question inside a DM is a question, not a DM row', () => {
    const rows = selectNowItems({
      ...busyFixture,
      attention: [{ ...signal('dm-question', 'question', 0.5), deepLink: '/rooms/dm-priya' }],
    });
    expect(rows[0]?.target.kind).toBe('attention');
    expect(rows[0]?.reason).toBe('now:question');
  });
});

describe('BC-6 — priority order', () => {
  it('sorts by tier, whatever order the signals arrive in', () => {
    const rows = rankNowItems(
      selectNowItems({
        ...busyFixture,
        attention: [
          signal('err', 'error', 1),
          signal('tsk', 'schedule-approval', 1),
          signal('q', 'question', 1),
          signal('perm', 'permission-prompt', 1),
        ],
      })
    );
    // A parked schedule sits above the error and below the two prompts: it is
    // blocked, and it is the one blockage with no clock on it (DOR-1391).
    expect(rows.map((row) => row.attention?.kind)).toEqual([
      'permission-prompt',
      'question',
      'schedule-approval',
      'error',
    ]);
  });

  it('puts the oldest first inside a tier', () => {
    const rows = rankNowItems(
      selectNowItems({
        ...busyFixture,
        attention: [
          signal('recent', 'question', 0.1),
          signal('oldest', 'question', 4),
          signal('middle', 'question', 2),
        ],
      })
    );
    expect(rows.map((row) => row.target.kind === 'attention' && row.target.signalId)).toEqual([
      'oldest',
      'middle',
      'recent',
    ]);
  });

  it('the busy fixture reads permission, question, error', () => {
    expect(zoneRows(busyFixture, 'now').map((row) => row.reason)).toEqual([
      'now:permission-prompt',
      'now:question',
      'now:error',
      'rollup:working',
    ]);
  });
});

describe('BC-7 / BC-8 — the cap and the overflow row', () => {
  it('shows three and folds the rest into "+ 4 more"', () => {
    const seven = Array.from({ length: 7 }, (_, index) =>
      signal(`s${index}`, 'question', index + 1)
    );
    const rows = capNowItems(rankNowItems(selectNowItems({ ...busyFixture, attention: seven })));
    expect(rows).toHaveLength(4);
    expect(rows[3]?.target).toEqual({ kind: 'rollup', rollup: 'now-overflow' });
    expect(rows[3]?.primary).toBe('+ 4 more');
  });

  it('the overflow row leads to the home triage header', () => {
    expect(NOW_OVERFLOW_HREF).toBe('/');
  });

  it('emits no overflow row at exactly three', () => {
    const three = Array.from({ length: 3 }, (_, index) => signal(`s${index}`, 'question', index));
    const rows = capNowItems(selectNowItems({ ...busyFixture, attention: three }));
    expect(rows.every((row) => row.target.kind === 'attention')).toBe(true);
  });

  it('the power fixture caps at five rows including both rollups', () => {
    const rows = zoneRows(powerFixture, 'now');
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => row.reason).slice(3)).toEqual([
      'rollup:now-overflow',
      'rollup:working',
    ]);
  });

  it('never exceeds five however many signals arrive', () => {
    const fifty = Array.from({ length: 50 }, (_, index) => signal(`s${index}`, 'error', index));
    expect(zoneRows({ ...powerFixture, attention: fifty }, 'now').length).toBeLessThanOrEqual(5);
  });
});

describe('BC-9 — the working rollup', () => {
  it('is one row for many working sessions', () => {
    const row = buildWorkingRollup(busyFixture);
    expect(row?.primary).toBe('3 working');
    expect(row?.reason).toBe('rollup:working');
  });

  it('is suppressed when the only working session is the one you are in', () => {
    expect(
      buildWorkingRollup({
        ...busyFixture,
        workingSessionIds: ['ses-1'],
        activeTarget: {
          kind: 'session',
          sessionId: 'ses-1',
          agentPath: '/Users/dev/code/tangerine',
          cwd: '/Users/dev/code/tangerine',
        },
      })
    ).toBeNull();
  });

  it('returns when a second session starts working beside the active one', () => {
    expect(
      buildWorkingRollup({ ...busyFixture, workingSessionIds: ['ses-1', 'ses-2'] })?.primary
    ).toBe('2 working');
  });

  it('is absent when nothing is working', () => {
    expect(buildWorkingRollup({ ...busyFixture, workingSessionIds: [] })).toBeNull();
  });

  it('counts no automated session — a scheduled run does not need you', () => {
    // The ruling of 2026-08-10 (see `build-working-rollup.ts`): §18's automated
    // row reads "Automated session activity → Nothing", and Heads up holds only what
    // needs the operator. `busyFixture` already carries two automated sessions
    // — a `task` and a `room` — so this is the real shape rather than a
    // constructed one.
    const automatedIds = busyFixture.sessions
      .filter((session) => session.origin !== undefined && session.origin !== 'user')
      .map((session) => session.id);
    // Both halves of the pair are non-empty first, so neither assertion below
    // can pass by looking at nothing.
    expect(automatedIds).toEqual(['ses-auto-1', 'ses-auto-2']);

    expect(buildWorkingRollup({ ...busyFixture, workingSessionIds: automatedIds })).toBeNull();
    // And the same count of HUMAN sessions does produce one, so the `null` above
    // is the origin filter rather than an inert path.
    expect(
      buildWorkingRollup({ ...busyFixture, workingSessionIds: ['ses-1', 'ses-2'] })?.primary
    ).toBe('2 working');
  });

  it('counts the human ones out of a mixed set', () => {
    expect(
      buildWorkingRollup({
        ...busyFixture,
        workingSessionIds: ['ses-1', 'ses-auto-1', 'ses-3', 'ses-auto-2'],
      })?.primary
    ).toBe('2 working');
  });

  it('counts a working session the snapshot cannot see at all', () => {
    // Origin lives on the session record, so an id with no record is one whose
    // origin is UNKNOWN — not one known to be automated. Counting it is the
    // deliberate direction: hiding a human turn is the worse error.
    expect(
      buildWorkingRollup({ ...busyFixture, workingSessionIds: ['ses-not-in-recents'] })?.primary
    ).toBe('1 working');
  });

  it('still lets an automated session that is BLOCKED into Heads up (§18’s carve-out)', () => {
    // The other half of the ruling, and the half a reader will look for: only
    // the liveness COUNT excludes automation. A blocked automated session
    // arrives as an ATTENTION signal — `entities/attention` reads no origin,
    // asserted in `entities/attention/__tests__/derive-attention-signals.test.ts`
    // ("puts an automated session that IS blocked in like anything else") — and
    // Heads up draws it like anything else.
    const state: SidebarState = {
      ...busyFixture,
      workingSessionIds: ['ses-auto-1'],
      attention: [signal('sig-auto', 'permission-prompt', 0.2)],
    };
    const rows = zoneRows(state, 'now');
    // The automated session contributed no working row, and the blocked one it
    // raised is present — one state proving both halves at once.
    expect(rows.map((row) => row.reason)).toEqual(['now:permission-prompt']);
  });
});

describe('DOR-1391 — one blockage, one place (the phone lead slot)', () => {
  /** Three blockages, one of which the phone's cards would also draw. */
  const three: SidebarAttentionSignal[] = [
    signal('approval:apr-1', 'permission-prompt', 1),
    signal('blocked:q-1', 'question', 0.5),
    signal('error:ses-9', 'error', 0.2),
  ];

  it('leaves every row alone when nothing above the zone draws a card', () => {
    // Desktop, which passes no covered ids at all. The half that proves the
    // suppression below is the phone's and not everyone's.
    const rows = zoneRows({ ...busyFixture, attention: three, workingSessionIds: [] }, 'now');
    expect(rows.map((row) => row.target.kind === 'attention' && row.target.signalId)).toEqual([
      'approval:apr-1',
      'blocked:q-1',
      'error:ses-9',
    ]);
  });

  it('drops the rows whose signal the lead slot already draws', () => {
    const rows = zoneRows(
      {
        ...busyFixture,
        attention: three,
        workingSessionIds: [],
        coveredSignalIds: ['approval:apr-1', 'blocked:q-1'],
      },
      'now'
    );
    // The wedged session is left: no card covers it, and the row is the only
    // thing on the phone that says so.
    expect(rows.map((row) => row.target.kind === 'attention' && row.target.signalId)).toEqual([
      'error:ses-9',
    ]);
  });

  it('still counts what it stopped drawing — the badge does not lie', () => {
    // A card on screen is still something waiting on a person, so BC-11's
    // count and the phone's tab badge report all three.
    const zone = buildSidebarModel({
      ...busyFixture,
      attention: three,
      workingSessionIds: [],
      coveredSignalIds: ['approval:apr-1', 'blocked:q-1'],
    }).zones.find((entry) => entry.id === 'now');
    expect(zone?.needsYouCount).toBe(3);
    expect(zone?.liveRegionText).toBe('3 agents need you');
  });

  it('suppresses BEFORE the cap, so no "+ N more" survives its own rows', () => {
    // Seven asks on a phone: the cards draw all seven, and a fold saying
    // "+ 4 more" underneath them would be summarizing what is already on
    // screen. Applied before the cap, there is simply nothing left to fold.
    const seven = Array.from({ length: 7 }, (_, index) =>
      signal(`blocked:q-${index}`, 'question', index + 1)
    );
    const covered = seven.map((s) => s.id);
    const rows = zoneRows(
      { ...busyFixture, attention: seven, workingSessionIds: [], coveredSignalIds: covered },
      'now'
    );
    expect(rows).toEqual([]);

    // And the discriminating half: the same seven WITHOUT the cards keep their
    // three rows and the fold.
    const uncovered = zoneRows({ ...busyFixture, attention: seven, workingSessionIds: [] }, 'now');
    expect(uncovered.map((row) => row.reason).at(-1)).toBe('rollup:now-overflow');
  });

  it('leaves the working rollup standing — a card is not a turn', () => {
    const rows = zoneRows(
      {
        ...busyFixture,
        attention: three,
        coveredSignalIds: three.map((s) => s.id),
      },
      'now'
    );
    expect(rows.map((row) => row.reason)).toEqual(['rollup:working']);
  });
});

describe('BC-11 — the live region announces counts only', () => {
  it('says how many need you', () => {
    const zone = buildSidebarModel(busyFixture).zones.find((entry) => entry.id === 'now');
    expect(zone?.liveRegionText).toBe('3 agents need you');
  });

  it('is singular for one', () => {
    const state = { ...busyFixture, attention: [signal('one', 'question', 1)] };
    const zone = buildSidebarModel(state).zones.find((entry) => entry.id === 'now');
    expect(zone?.liveRegionText).toBe('1 agent needs you');
  });

  it('does not change when activity does', () => {
    const before = buildSidebarModel(busyFixture).zones.find((zone) => zone.id === 'now');
    const after = buildSidebarModel({
      ...busyFixture,
      workingSessionIds: ['ses-1', 'ses-2', 'ses-3', 'ses-4'],
    }).zones.find((zone) => zone.id === 'now');
    expect(after?.liveRegionText).toBe(before?.liveRegionText);
  });
});

describe('BC-4 — Heads up and Getting started share one slot', () => {
  it('suppresses Getting started while anything needs you', () => {
    const ids = buildSidebarModel({
      ...firstRunFixture,
      attention: [signal('perm', 'permission-prompt', 1)],
    }).zones.map((zone) => zone.id);
    expect(ids).toContain('now');
    expect(ids).not.toContain('getting-started');
  });

  it('shows Getting started when nothing needs you and suggestions remain', () => {
    const ids = buildSidebarModel(firstRunFixture).zones.map((zone) => zone.id);
    expect(ids).toContain('getting-started');
    expect(ids).not.toContain('now');
  });

  it('shows neither when nothing needs you and nothing is left to suggest', () => {
    expect(buildSidebarModel(quietFixture).zones.map((zone) => zone.id)).not.toContain(
      'getting-started'
    );
    expect(buildSidebarModel(quietFixture).zones.map((zone) => zone.id)).not.toContain('now');
  });

  it('still shows the working rollup when there is nothing left to suggest', () => {
    const state = { ...quietFixture, workingSessionIds: ['ses-morning'] };
    expect(zoneRows(state, 'now').map((row) => row.reason)).toEqual(['rollup:working']);
  });
});
