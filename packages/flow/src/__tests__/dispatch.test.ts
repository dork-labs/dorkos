/**
 * Unit suite for the dispatch policy (§4) — eligibility filter + 7-tier ranking
 * ladder. Imports from the relative module paths (NOT the `@dorkos/flow`
 * barrel), since the orchestrator wires barrel exports later.
 *
 * @see specs/unified-workflow-system/02-specification.md §4
 */

import { describe, expect, it } from 'vitest';
import { DispatchSchema, OwnershipSchema, WipCapSchema } from '../config-schema.js';
import {
  filterEligible,
  isClaimable,
  rankEligible,
  selectDispatch,
  type DispatchOptions,
} from '../dispatch.js';
import type { OwnershipClass, WorkItem, WorkItemPriority } from '../work-item.js';

const DISPATCH = DispatchSchema.parse({});
const OWNERSHIP = OwnershipSchema.parse({});
const WIP = WipCapSchema.parse({}); // { global: 2, perProject: 1 }
/** A wide cap, for tests that isolate non-WIP behavior from cap interference. */
const WIDE_WIP = WipCapSchema.parse({ global: 100, perProject: 100 });

/** Build a fully-formed, eligible WorkItem with overridable fields. */
function makeItem(overrides: Partial<WorkItem> & { identifier: string }): WorkItem {
  return {
    id: `node_${overrides.identifier}`,
    title: `Title ${overrides.identifier}`,
    description: '',
    type: 'task',
    stateCategory: 'unstarted',
    stateName: 'Todo',
    priority: 3,
    size: 'md',
    project: { id: 'proj_a', name: 'Project A', stateCategory: 'started' },
    parent: null,
    relations: { blocks: [], blockedBy: [], children: [], relatedTo: [] },
    labels: ['agent/ready'],
    assignee: 'agent-account',
    agentDisposition: 'ready',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Ownership resolver: everything is `mine` unless overridden by the map. */
function ownershipOpts(map: Record<string, OwnershipClass> = {}): DispatchOptions {
  return {
    classifyOwnership: () => 'mine',
    ownershipOf: map,
  };
}

/** Convenience: identifiers of the dispatch result, in order. */
function ids(items: WorkItem[]): string[] {
  return items.map((i) => i.identifier);
}

describe('isClaimable', () => {
  it('maps ownership classes onto the default claim policy', () => {
    // defaults: claimAssignedToAgent + claimUnassigned true; human/others false
    expect(isClaimable('mine', OWNERSHIP)).toBe(true);
    expect(isClaimable('unassigned', OWNERSHIP)).toBe(true);
    expect(isClaimable('reviewer', OWNERSHIP)).toBe(false);
    expect(isClaimable('other', OWNERSHIP)).toBe(false);
  });

  it('honors a policy that opens up human + other claims', () => {
    const open = OwnershipSchema.parse({
      claimAssignedToHuman: true,
      claimAssignedToOthers: true,
    });
    expect(isClaimable('reviewer', open)).toBe(true);
    expect(isClaimable('other', open)).toBe(true);
  });
});

describe('filterEligible', () => {
  it('keeps a fully-eligible item', () => {
    const items = [makeItem({ identifier: 'DOR-1' })];
    const survivors = filterEligible(items, OWNERSHIP, WIP, ownershipOpts());
    expect(ids(survivors)).toEqual(['DOR-1']);
  });

  it('filters items in a non-dispatchable state (completed/canceled)', () => {
    const items = [
      makeItem({ identifier: 'DOR-1', stateCategory: 'completed' }),
      makeItem({ identifier: 'DOR-2', stateCategory: 'canceled' }),
      makeItem({ identifier: 'DOR-3', stateCategory: 'started' }),
    ];
    const survivors = filterEligible(items, OWNERSHIP, WIP, ownershipOpts());
    expect(ids(survivors)).toEqual(['DOR-3']);
  });

  it('filters items lacking the agent/ready label (PM-driven mode)', () => {
    const items = [
      makeItem({ identifier: 'DOR-1', labels: [] }),
      makeItem({ identifier: 'DOR-2', labels: ['stage/triage'] }),
      makeItem({ identifier: 'DOR-3' }), // has agent/ready
    ];
    const survivors = filterEligible(items, OWNERSHIP, WIP, ownershipOpts());
    expect(ids(survivors)).toEqual(['DOR-3']);
  });

  it('filters items blockedBy an OPEN item but keeps those blocked only by closed items', () => {
    const items = [
      // blocked by an open item → filtered
      makeItem({
        identifier: 'DOR-1',
        relations: { blocks: [], blockedBy: ['DOR-2'], children: [], relatedTo: [] },
      }),
      // the open blocker
      makeItem({ identifier: 'DOR-2', stateCategory: 'started' }),
      // blocked only by a completed item (not in open set) → eligible
      makeItem({
        identifier: 'DOR-3',
        relations: { blocks: [], blockedBy: ['DOR-DONE'], children: [], relatedTo: [] },
      }),
      // the closed blocker
      makeItem({ identifier: 'DOR-DONE', stateCategory: 'completed' }),
    ];
    // Wide cap so the shared default project's perProject:1 doesn't shadow the
    // blocker logic under test.
    const survivors = filterEligible(items, OWNERSHIP, WIDE_WIP, ownershipOpts());
    expect(ids(survivors).sort()).toEqual(['DOR-2', 'DOR-3']);
  });

  it('filters items whose project is completed/canceled', () => {
    const items = [
      makeItem({
        identifier: 'DOR-1',
        project: { id: 'proj_done', name: 'Done', stateCategory: 'completed' },
      }),
      makeItem({
        identifier: 'DOR-2',
        project: { id: 'proj_x', name: 'X', stateCategory: 'canceled' },
      }),
      makeItem({ identifier: 'DOR-3' }), // started project
    ];
    const survivors = filterEligible(items, OWNERSHIP, WIP, ownershipOpts());
    expect(ids(survivors)).toEqual(['DOR-3']);
  });

  it('filters other-owned and reviewer-owned items per the claim policy', () => {
    const items = [
      makeItem({ identifier: 'DOR-1' }), // mine
      makeItem({ identifier: 'DOR-2' }), // other
      makeItem({ identifier: 'DOR-3' }), // reviewer
      makeItem({ identifier: 'DOR-4' }), // unassigned
    ];
    // Wide cap so the shared default project's perProject:1 doesn't shadow the
    // ownership filter under test.
    const survivors = filterEligible(
      items,
      OWNERSHIP,
      WIDE_WIP,
      ownershipOpts({
        'DOR-1': 'mine',
        'DOR-2': 'other',
        'DOR-3': 'reviewer',
        'DOR-4': 'unassigned',
      })
    );
    // defaults claim mine + unassigned only
    expect(ids(survivors).sort()).toEqual(['DOR-1', 'DOR-4']);
  });

  it('enforces the per-project WIP cap (perProject: 1)', () => {
    const items = [
      makeItem({
        identifier: 'DOR-1',
        project: { id: 'proj_a', name: 'A', stateCategory: 'started' },
      }),
      makeItem({
        identifier: 'DOR-2',
        project: { id: 'proj_a', name: 'A', stateCategory: 'started' },
      }),
      makeItem({
        identifier: 'DOR-3',
        project: { id: 'proj_b', name: 'B', stateCategory: 'started' },
      }),
    ];
    const survivors = filterEligible(items, OWNERSHIP, WIP, ownershipOpts());
    // proj_a capped at 1 (DOR-1 admitted, DOR-2 dropped); proj_b admits DOR-3.
    // global cap is 2 → both admitted survivors fit.
    expect(ids(survivors)).toEqual(['DOR-1', 'DOR-3']);
  });

  it('enforces the global WIP cap (global: 2) across projects', () => {
    const items = [
      makeItem({
        identifier: 'DOR-1',
        project: { id: 'p1', name: 'p1', stateCategory: 'started' },
      }),
      makeItem({
        identifier: 'DOR-2',
        project: { id: 'p2', name: 'p2', stateCategory: 'started' },
      }),
      makeItem({
        identifier: 'DOR-3',
        project: { id: 'p3', name: 'p3', stateCategory: 'started' },
      }),
    ];
    const survivors = filterEligible(items, OWNERSHIP, WIP, ownershipOpts());
    expect(ids(survivors)).toEqual(['DOR-1', 'DOR-2']); // 3rd hits global cap
  });

  it('counts existing in-progress load against the caps', () => {
    const items = [
      makeItem({
        identifier: 'DOR-1',
        project: { id: 'proj_a', name: 'A', stateCategory: 'started' },
      }),
    ];
    // proj_a already has 1 in progress → at its perProject cap → filtered.
    const survivors = filterEligible(items, OWNERSHIP, WIP, {
      ...ownershipOpts(),
      inProgressByProject: { proj_a: 1 },
      inProgressTotal: 1,
    });
    expect(survivors).toEqual([]);
  });

  it('throws when no ownership source is provided', () => {
    const items = [makeItem({ identifier: 'DOR-1' })];
    expect(() => filterEligible(items, OWNERSHIP, WIP, {})).toThrow(/ownership/);
  });
});

describe('rankEligible — 7-tier ladder', () => {
  it('tier 1: unblockers (items that block others) rank first', () => {
    const items = [
      makeItem({ identifier: 'DOR-A', priority: 3 }),
      makeItem({
        identifier: 'DOR-B',
        priority: 3,
        relations: { blocks: ['DOR-A'], blockedBy: [], children: [], relatedTo: [] },
      }),
    ];
    // Same priority; DOR-B blocks an open item so it leads despite identifier order.
    expect(ids(rankEligible(items, DISPATCH))).toEqual(['DOR-B', 'DOR-A']);
  });

  it('tier 2: priority orders urgent → high → medium → low → none', () => {
    const items = [
      makeItem({ identifier: 'DOR-NONE', priority: 0 }),
      makeItem({ identifier: 'DOR-LOW', priority: 4 }),
      makeItem({ identifier: 'DOR-URGENT', priority: 1 }),
      makeItem({ identifier: 'DOR-MED', priority: 3 }),
      makeItem({ identifier: 'DOR-HIGH', priority: 2 }),
    ];
    expect(ids(rankEligible(items, DISPATCH))).toEqual([
      'DOR-URGENT',
      'DOR-HIGH',
      'DOR-MED',
      'DOR-LOW',
      'DOR-NONE',
    ]);
  });

  it('tier 3: items in started (in-progress) projects rank before planned ones', () => {
    const items = [
      makeItem({
        identifier: 'DOR-PLANNED',
        project: { id: 'p_plan', name: 'Planned', stateCategory: 'unstarted' },
      }),
      makeItem({
        identifier: 'DOR-PROG',
        project: { id: 'p_prog', name: 'In Progress', stateCategory: 'started' },
      }),
    ];
    // Equal on tiers 1–2; tier 3 promotes the started-project item.
    expect(ids(rankEligible(items, DISPATCH))).toEqual(['DOR-PROG', 'DOR-PLANNED']);
  });

  it('tier 5: size — small-first orders smaller estimates ahead', () => {
    const items = [
      makeItem({ identifier: 'DOR-LG', size: 'lg' }),
      makeItem({ identifier: 'DOR-SM', size: 'sm' }),
      makeItem({ identifier: 'DOR-XL', size: 'xl' }),
    ];
    expect(ids(rankEligible(items, DISPATCH))).toEqual(['DOR-SM', 'DOR-LG', 'DOR-XL']);
  });

  it('tier 5: size — large-first inverts the order', () => {
    const largeFirst = DispatchSchema.parse({ sizeOrder: 'large-first' });
    const items = [
      makeItem({ identifier: 'DOR-SM', size: 'sm' }),
      makeItem({ identifier: 'DOR-LG', size: 'lg' }),
      makeItem({ identifier: 'DOR-XL', size: 'xl' }),
    ];
    expect(ids(rankEligible(items, largeFirst))).toEqual(['DOR-XL', 'DOR-LG', 'DOR-SM']);
  });

  it('tier 5: Fibonacci point estimates rank alongside t-shirt sizes', () => {
    const items = [
      makeItem({ identifier: 'DOR-8', size: '8' }),
      makeItem({ identifier: 'DOR-1', size: '1' }),
      makeItem({ identifier: 'DOR-3', size: '3' }),
    ];
    expect(ids(rankEligible(items, DISPATCH))).toEqual(['DOR-1', 'DOR-3', 'DOR-8']);
  });

  it('tier 6: age — oldest created first', () => {
    const items = [
      makeItem({ identifier: 'DOR-NEW', createdAt: '2026-03-01T00:00:00.000Z' }),
      makeItem({ identifier: 'DOR-OLD', createdAt: '2026-01-01T00:00:00.000Z' }),
      makeItem({ identifier: 'DOR-MID', createdAt: '2026-02-01T00:00:00.000Z' }),
    ];
    expect(ids(rankEligible(items, DISPATCH))).toEqual(['DOR-OLD', 'DOR-MID', 'DOR-NEW']);
  });

  it('tier 7: identifier breaks an otherwise-total tie deterministically', () => {
    const items = [
      makeItem({ identifier: 'DOR-30' }),
      makeItem({ identifier: 'DOR-10' }),
      makeItem({ identifier: 'DOR-20' }),
    ];
    // All fields identical → only the identifier tiebreak distinguishes them.
    expect(ids(rankEligible(items, DISPATCH))).toEqual(['DOR-10', 'DOR-20', 'DOR-30']);
  });

  it('later tiers break ties left by earlier ones (priority then size)', () => {
    const items = [
      makeItem({ identifier: 'DOR-A', priority: 2, size: 'lg' }),
      makeItem({ identifier: 'DOR-B', priority: 2, size: 'sm' }),
      makeItem({ identifier: 'DOR-C', priority: 1, size: 'xl' }),
    ];
    // C wins on priority; A vs B tie on priority → size (small-first) puts B first.
    expect(ids(rankEligible(items, DISPATCH))).toEqual(['DOR-C', 'DOR-B', 'DOR-A']);
  });
});

describe('rankEligible — graceful degradation (missing fields are neutral)', () => {
  it('treats missing priority as neutral (sorts after every concrete priority)', () => {
    const items = [
      makeItem({ identifier: 'DOR-NEUTRAL', priority: undefined }),
      makeItem({ identifier: 'DOR-LOW', priority: 4 }),
    ];
    // A real "low" still outranks a missing priority.
    expect(ids(rankEligible(items, DISPATCH))).toEqual(['DOR-LOW', 'DOR-NEUTRAL']);
  });

  it('treats missing size as neutral, not as smallest', () => {
    const items = [
      makeItem({ identifier: 'DOR-NEUTRAL', size: undefined }),
      makeItem({ identifier: 'DOR-XL', size: 'xl' }),
    ];
    // Even the largest concrete size beats a missing one (neutral sorts last).
    expect(ids(rankEligible(items, DISPATCH))).toEqual(['DOR-XL', 'DOR-NEUTRAL']);
  });

  it('treats an unrecognized size estimate as neutral', () => {
    const items = [
      makeItem({ identifier: 'DOR-WEIRD', size: 'gigantic' }),
      makeItem({ identifier: 'DOR-SM', size: 'sm' }),
    ];
    expect(ids(rankEligible(items, DISPATCH))).toEqual(['DOR-SM', 'DOR-WEIRD']);
  });

  it('treats missing createdAt as neutral in the age tier', () => {
    const items = [
      makeItem({ identifier: 'DOR-NOAGE', createdAt: undefined }),
      makeItem({ identifier: 'DOR-DATED', createdAt: '2026-01-01T00:00:00.000Z' }),
    ];
    expect(ids(rankEligible(items, DISPATCH))).toEqual(['DOR-DATED', 'DOR-NOAGE']);
  });

  it('does not mutate the input array', () => {
    const items = [
      makeItem({ identifier: 'DOR-B', priority: 4 }),
      makeItem({ identifier: 'DOR-A', priority: 1 }),
    ];
    const before = ids(items);
    rankEligible(items, DISPATCH);
    expect(ids(items)).toEqual(before);
  });
});

describe('selectDispatch — full policy (filter then rank)', () => {
  it('filters ineligible items AND returns survivors in ladder order', () => {
    const items: WorkItem[] = [
      // Eligible, urgent → should lead.
      makeItem({
        identifier: 'DOR-URGENT',
        priority: 1,
        project: { id: 'p1', name: 'p1', stateCategory: 'started' },
      }),
      // Eligible, low priority.
      makeItem({
        identifier: 'DOR-LOW',
        priority: 4,
        project: { id: 'p2', name: 'p2', stateCategory: 'started' },
      }),
      // Filtered: not ready.
      makeItem({ identifier: 'DOR-NOTREADY', priority: 1, labels: [] }),
      // Filtered: blocked by an open item.
      makeItem({
        identifier: 'DOR-BLOCKED',
        priority: 1,
        relations: { blocks: [], blockedBy: ['DOR-URGENT'], children: [], relatedTo: [] },
      }),
      // Filtered: other-owned.
      makeItem({ identifier: 'DOR-OTHER', priority: 1 }),
      // Filtered: completed state.
      makeItem({ identifier: 'DOR-DONE', priority: 1, stateCategory: 'completed' }),
    ];
    const result = selectDispatch(
      items,
      { dispatch: DISPATCH, ownership: OWNERSHIP, wipCap: WIP },
      ownershipOpts({
        'DOR-URGENT': 'mine',
        'DOR-LOW': 'mine',
        'DOR-NOTREADY': 'mine',
        'DOR-BLOCKED': 'mine',
        'DOR-OTHER': 'other',
        'DOR-DONE': 'mine',
      })
    );
    expect(ids(result)).toEqual(['DOR-URGENT', 'DOR-LOW']);
  });

  it('produces the complete 7-tier ordering on a mixed survivor set', () => {
    const items: WorkItem[] = [
      makeItem({
        identifier: 'DOR-UNBLOCKER',
        priority: 3,
        project: { id: 'p1', name: 'p1', stateCategory: 'started' },
        relations: { blocks: ['DOR-MED'], blockedBy: [], children: [], relatedTo: [] },
      }),
      makeItem({
        identifier: 'DOR-URGENT',
        priority: 1,
        project: { id: 'p2', name: 'p2', stateCategory: 'started' },
      }),
      makeItem({
        identifier: 'DOR-MED',
        priority: 3,
        project: { id: 'p3', name: 'p3', stateCategory: 'started' },
      }),
    ];
    // Global cap is 2 → only first two admitted in input order, then ranked.
    const wideWip = WipCapSchema.parse({ global: 10, perProject: 10 });
    const result = selectDispatch(
      items,
      { dispatch: DISPATCH, ownership: OWNERSHIP, wipCap: wideWip },
      ownershipOpts()
    );
    // Tier 1: DOR-UNBLOCKER blocks an open item → first. Then priority orders the rest.
    expect(ids(result)).toEqual(['DOR-UNBLOCKER', 'DOR-URGENT', 'DOR-MED']);
  });
});

describe('type sanity', () => {
  it('accepts the full WorkItemPriority range', () => {
    const priorities: WorkItemPriority[] = [0, 1, 2, 3, 4];
    const items = priorities.map((p, i) => makeItem({ identifier: `DOR-${i}`, priority: p }));
    expect(rankEligible(items, DISPATCH)).toHaveLength(5);
  });
});
