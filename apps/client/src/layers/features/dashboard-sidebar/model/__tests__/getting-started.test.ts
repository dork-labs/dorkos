/**
 * Getting started — computed suggestions, permanent retirement, and a zone that
 * leaves for good (BC-12 → BC-14).
 *
 * @module features/dashboard-sidebar/model/__tests__/getting-started
 */
import { describe, expect, it } from 'vitest';
import { buildSidebarModel } from '../build-sidebar-model';
import { firstRunFixture, prefs } from '../fixtures';
import { buildGettingStarted } from '../rules/build-getting-started';
import type { JourneyFacts, SidebarState } from '../sidebar-state';

/** The first-run journey with one fact changed. */
function withJourney(overrides: Partial<JourneyFacts>): SidebarState {
  return { ...firstRunFixture, journey: { ...firstRunFixture.journey, ...overrides } };
}

/** The first-run journey with some suggestions already retired. */
function withRetired(retired: string[]): SidebarState {
  return {
    ...firstRunFixture,
    prefs: prefs({ ...firstRunFixture.prefs, gettingStarted: { retired } }),
  };
}

describe('BC-12 — the suggestion table', () => {
  it('offers "meet the agents we found" when discovery found some', () => {
    const rows = buildGettingStarted(firstRunFixture);
    expect(rows[0]?.primary).toBe('Meet the 4 agents we found');
    expect(rows[0]?.reason).toBe('suggestion:agents-found');
  });

  it('counts in the singular for one found agent', () => {
    const rows = buildGettingStarted(withJourney({ discoveredUnregisteredPaths: ['/one'] }));
    expect(rows[0]?.primary).toBe('Meet the agent we found');
  });

  it('falls back to "add your first agent" only when discovery found none', () => {
    const rows = buildGettingStarted(withJourney({ discoveredUnregisteredPaths: [] }));
    expect(rows.map((row) => row.reason)).toContain('suggestion:add-agent');
  });

  it('never offers both agent suggestions at once', () => {
    for (const found of [[], ['/a'], ['/a', '/b']]) {
      for (const roster of [0, 1, 9]) {
        const ids = buildGettingStarted(
          withJourney({ discoveredUnregisteredPaths: found, nonSystemAgentCount: roster })
        ).map((row) => row.reason);
        const both =
          ids.includes('suggestion:agents-found') && ids.includes('suggestion:add-agent');
        expect(both, `found=${found.length} roster=${roster}`).toBe(false);
      }
    }
  });

  it('retires "agents found" once an agent is registered', () => {
    const ids = buildGettingStarted(
      withJourney({ discoveredUnregisteredPaths: [], nonSystemAgentCount: 1 })
    ).map((row) => row.reason);
    expect(ids).not.toContain('suggestion:agents-found');
    expect(ids).not.toContain('suggestion:add-agent');
  });

  it('offers the first session once there is an agent that never ran', () => {
    const ids = buildGettingStarted(
      withJourney({ discoveredUnregisteredPaths: [], nonSystemAgentCount: 2 })
    ).map((row) => row.reason);
    expect(ids).toContain('suggestion:first-session');
  });

  it('drops the first-session suggestion once a session exists', () => {
    const ids = buildGettingStarted(
      withJourney({ nonSystemAgentCount: 2, hasEverStartedSession: true })
    ).map((row) => row.reason);
    expect(ids).not.toContain('suggestion:first-session');
  });

  it('drops "say hi" once the operator has posted in #team', () => {
    expect(
      buildGettingStarted(withJourney({ hasPostedInTeam: true })).map((row) => row.reason)
    ).not.toContain('suggestion:say-hi-team');
  });

  it('drops "ask DorkBot" once a DorkBot session exists', () => {
    expect(
      buildGettingStarted(withJourney({ hasDorkBotSession: true })).map((row) => row.reason)
    ).not.toContain('suggestion:ask-dorkbot');
  });
});

describe('BC-13 — retirement is permanent', () => {
  it('never shows a retired suggestion again', () => {
    const ids = buildGettingStarted(withRetired(['suggestion:say-hi-team'])).map(
      (row) => row.reason
    );
    expect(ids).not.toContain('suggestion:say-hi-team');
  });

  it('keeps it retired even when its predicate becomes true again', () => {
    // The agents were found, registered (retiring the suggestion), then deleted.
    const state = {
      ...withRetired(['suggestion:agents-found']),
      journey: { ...firstRunFixture.journey, discoveredUnregisteredPaths: ['/a', '/b'] },
    };
    expect(buildGettingStarted(state).map((row) => row.reason)).not.toContain(
      'suggestion:agents-found'
    );
  });

  it('ignores a retirement token from an older release', () => {
    // `suggestion:groups-hint` is written by the P2.8 conf migration and has no
    // suggestion behind it any more. It must retire nothing else.
    const ids = buildGettingStarted(withRetired(['suggestion:groups-hint'])).map(
      (row) => row.reason
    );
    expect(ids).toEqual(buildGettingStarted(firstRunFixture).map((row) => row.reason));
  });
});

describe('BC-14 — the zone leaves when everything is retired', () => {
  it('emits nothing once all five are retired', () => {
    const all = [
      'suggestion:agents-found',
      'suggestion:add-agent',
      'suggestion:first-session',
      'suggestion:say-hi-team',
      'suggestion:ask-dorkbot',
    ];
    expect(buildGettingStarted(withRetired(all))).toEqual([]);
  });

  it('and the zone is absent from the model', () => {
    const all = [
      'suggestion:agents-found',
      'suggestion:add-agent',
      'suggestion:first-session',
      'suggestion:say-hi-team',
      'suggestion:ask-dorkbot',
    ];
    const ids = buildSidebarModel(withRetired(all)).zones.map((zone) => zone.id);
    expect(ids).not.toContain('getting-started');
  });
});

describe('BC-4 / BC-9 — the slot Getting started shares with Now', () => {
  /**
   * Day one, with a turn streaming.
   *
   * **The pairing no fixture covered**, and the reason the defect it names
   * shipped: `first-run` has unretired suggestions and no working session, and
   * `busy` has a working session and every suggestion retired, so the two
   * halves of the collision never met in one snapshot. Built with a spread, not
   * an edit to either file.
   */
  const dayOneAndWorking: SidebarState = {
    ...firstRunFixture,
    sessions: [
      {
        id: 'ses-first',
        title: 'First session',
        createdAt: new Date(firstRunFixture.now - 60_000).toISOString(),
        updatedAt: new Date(firstRunFixture.now).toISOString(),
        permissionMode: 'default',
        runtime: 'claude-code',
        cwd: '/Users/dev/.dork/agents/dorkbot',
      },
    ],
    workingSessionIds: ['ses-first'],
  };

  /** Every row of the zone occupying Now's slot. */
  function slotRows(state: SidebarState): string[] {
    const zone = buildSidebarModel(state).zones.find(
      (entry) => entry.id === 'now' || entry.id === 'getting-started'
    );
    return zone?.sections.flatMap((section) => section.rows.map((row) => row.reason)) ?? [];
  }

  it('tells the operator something is working, even on day one', () => {
    // BC-9 is unconditional: one session streaming means one row saying so.
    // Before this was fixed, an operator with any unretired suggestion could
    // never be told anything was working at all.
    expect(slotRows(dayOneAndWorking)).toContain('rollup:working');
  });

  it('gives the slot to Now, not to Getting started, while it is working', () => {
    const zones = buildSidebarModel(dayOneAndWorking).zones.map((zone) => zone.id);
    expect(zones).toContain('now');
    expect(zones).not.toContain('getting-started');
  });

  it('hands the slot straight back when the turn ends', () => {
    // The other half — without it, "Now wins" would also be satisfied by a
    // model that had simply deleted Getting started.
    const quiet: SidebarState = { ...dayOneAndWorking, workingSessionIds: [] };
    expect(buildSidebarModel(quiet).zones.map((zone) => zone.id)).toContain('getting-started');
  });

  it('does not announce a working rollup as something that needs you', () => {
    // BC-11: the live region carries the count of things NEEDING the operator.
    // A rollup is not one of them, and a zone that now renders for the rollup
    // alone must not start speaking.
    const zone = buildSidebarModel(dayOneAndWorking).zones.find((entry) => entry.id === 'now');
    expect(zone?.liveRegionText).toBeUndefined();
  });
});
