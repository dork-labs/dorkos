/**
 * The boot gate's truth table (spec `sidebar-simplification` D6).
 *
 * What a failure here would mean: the panel either paints before it knows what
 * it is painting — which is the eight-beat pop-in and the face flip this whole
 * design exists to remove — or it waits on a source that will never answer and
 * shows bones forever.
 */
import { describe, it, expect } from 'vitest';
import { bootGateOpen, fleetKnown, type BootQueryFacts } from '../boot-gate';

/** Every source answered, on an install that has agents. */
function allAnswered(overrides: Partial<BootQueryFacts> = {}): BootQueryFacts {
  return {
    config: true,
    rooms: true,
    threads: true,
    mesh: true,
    manifests: true,
    hasAgentPaths: true,
    recents: true,
    roster: true,
    approvals: true,
    interactions: true,
    scheduleApprovals: true,
    ...overrides,
  };
}

describe('bootGateOpen — what the panel waits for', () => {
  it('opens when every source has answered', () => {
    expect(bootGateOpen(allAnswered())).toBe(true);
  });

  // One case per member. Each fails if that source is dropped from the gate,
  // which is the regression that puts an unpainted zone on screen.
  const members = [
    'config',
    'rooms',
    'threads',
    'mesh',
    'manifests',
    'recents',
    'roster',
    'approvals',
    'interactions',
    'scheduleApprovals',
  ] as const;
  for (const member of members) {
    it(`stays shut while ${member} is pending`, () => {
      expect(bootGateOpen(allAnswered({ [member]: false }))).toBe(false);
    });
  }

  it('counts Heads up’s three sources among them', () => {
    // Named explicitly because they were added after the first cut of D6: a
    // panel that painted before its approvals landed grew a whole zone at the
    // top a beat later and pushed every row below it down.
    expect(members).toContain('approvals');
    expect(members).toContain('interactions');
    expect(members).toContain('scheduleApprovals');
    expect(members).toHaveLength(10);
  });

  it('does not wait for manifests on an install with no agent directories', () => {
    // `useResolvedAgents` disables itself when there is nothing to resolve, so
    // its query is pending forever — a gate that waited on it would hold the
    // skeleton up permanently for a brand-new install.
    expect(bootGateOpen(allAnswered({ manifests: false, hasAgentPaths: false }))).toBe(true);
  });

  it('waits for manifests as soon as there is one directory to name', () => {
    expect(bootGateOpen(allAnswered({ manifests: false, hasAgentPaths: true }))).toBe(false);
  });
});

describe('fleetKnown — the one source that may not degrade (DOR-1143)', () => {
  it('is false while manifests are pending and there are directories to name', () => {
    // The panel may still paint on the 1500 ms ceiling; what it may not do is
    // draw a face hashed from a directory and change it when the manifest
    // lands. The other nine sources degrade to "empty"; this one degrades to
    // "withhold the rows".
    expect(fleetKnown(allAnswered({ manifests: false, hasAgentPaths: true }))).toBe(false);
  });

  it('is true once manifests answer', () => {
    expect(fleetKnown(allAnswered({ manifests: true, hasAgentPaths: true }))).toBe(true);
  });

  it('is true on an install with no agent directories at all', () => {
    // Nothing to be wrong about, and the manifests query never runs — so a rule
    // that waited here would withhold the fleet forever from an install that
    // has none.
    expect(fleetKnown(allAnswered({ manifests: false, hasAgentPaths: false }))).toBe(true);
  });

  it('is false before the MESH has answered, however empty the paths look', () => {
    // The hole a browser probe found in the first cut of this rule. Before the
    // mesh answers there are no paths, so `hasAgentPaths` is false — which is
    // indistinguishable from "an install with no agents", the one case where
    // there is nothing to wait for. Reading that as "known" let the consumer
    // latch it, and the agent rows painted from the path hash after all.
    //
    // Red when: the `facts.mesh` guard is dropped.
    expect(fleetKnown(allAnswered({ mesh: false, manifests: false, hasAgentPaths: false }))).toBe(
      false
    );
  });

  it('does not care about any source but the mesh and its manifests', () => {
    // It is specifically about identity, not about readiness: a panel with no
    // rooms and no roster still knows its fleet.
    const noneElse = allAnswered({
      config: false,
      rooms: false,
      threads: false,
      recents: false,
      roster: false,
      approvals: false,
      interactions: false,
      scheduleApprovals: false,
    });
    expect(fleetKnown(noneElse)).toBe(true);
    expect(bootGateOpen(noneElse)).toBe(false);
  });
});
