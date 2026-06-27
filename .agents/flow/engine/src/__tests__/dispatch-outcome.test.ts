/**
 * Unit suite for {@link classifyDispatchOutcome} (§2 starvation detection; G3).
 *
 * Pins the four outcome shapes that let the loop tell "genuinely done" from
 * "starved behind the `agent/ready` gate", so `/flow auto` never sets `ready: 0`
 * and stops silently while shapeable work still waits on a triage pass:
 *
 *   (a) empty-with-shapeable -> starved (the keystone case)
 *   (b) done (only terminal items)  -> not starved, nothing shapeable
 *   (c) one ready item              -> picked, not starved
 *   (d) mixed ready + shapeable     -> picked, shapeable counted separately
 *
 * Case (a) is written to FAIL against pre-1.4 code: `classifyDispatchOutcome`
 * does not exist there, so the named import below does not resolve and the whole
 * file errors at load.
 *
 * Imports from the relative module path (NOT the `@dorkos/flow` barrel), matching
 * the sibling `dispatch.test.ts` suite.
 *
 * @see specs/flow-triage-feeds-loop/02-specification.md §2
 */

import { describe, expect, it } from 'vitest';
import { DispatchSchema, OwnershipSchema, WipCapSchema } from '../config-schema.js';
import { classifyDispatchOutcome, type DispatchOptions } from '../dispatch.js';
import type { WorkItem } from '../work-item.js';

const CONFIG = {
  dispatch: DispatchSchema.parse({}),
  ownership: OwnershipSchema.parse({}),
  wipCap: WipCapSchema.parse({}), // { global: 2, perProject: 1 }
};

/** Stub ownership: every item is `unassigned` (claimable under the default policy). */
const OPTS: DispatchOptions = { classifyOwnership: () => 'unassigned' };

/** Build a backlog-category WorkItem, carrying `agent/ready` unless overridden. */
function makeItem(overrides: Partial<WorkItem> & { identifier: string }): WorkItem {
  return {
    id: `node_${overrides.identifier}`,
    title: `Title ${overrides.identifier}`,
    description: '',
    type: 'task',
    stateCategory: 'backlog',
    stateName: 'Backlog',
    priority: 3,
    size: 'md',
    project: { id: 'proj_a', name: 'Project A', stateCategory: 'started' },
    parent: null,
    relations: { blocks: [], blockedBy: [], children: [], relatedTo: [] },
    labels: ['agent/ready'],
    assignee: undefined,
    agentDisposition: 'ready',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('classifyDispatchOutcome', () => {
  it('(a) starved: dispatchable-category items lacking agent/ready -> starved, shapeable counted', () => {
    // Three backlog items sitting behind the readiness gate. A triage pass would
    // ready them; until then nothing is eligible but the queue is NOT done.
    const items = [
      makeItem({ identifier: 'DOR-1', labels: [] }),
      makeItem({ identifier: 'DOR-2', labels: ['stage/triage'] }),
      makeItem({ identifier: 'DOR-3', labels: [] }),
    ];
    const outcome = classifyDispatchOutcome(items, CONFIG, OPTS);
    expect(outcome.picked).toEqual([]);
    expect(outcome.eligibleCount).toBe(0);
    expect(outcome.shapeableCount).toBe(3);
    expect(outcome.starved).toBe(true);
  });

  it('(b) done: only completed/canceled items -> not starved, nothing shapeable', () => {
    // Genuinely drained: terminal items are neither dispatchable nor shapeable.
    const items = [
      makeItem({ identifier: 'DOR-1', stateCategory: 'completed', labels: [] }),
      makeItem({ identifier: 'DOR-2', stateCategory: 'canceled', labels: [] }),
    ];
    const outcome = classifyDispatchOutcome(items, CONFIG, OPTS);
    expect(outcome.eligibleCount).toBe(0);
    expect(outcome.shapeableCount).toBe(0);
    expect(outcome.starved).toBe(false);
  });

  it('(c) picked: a single agent/ready backlog item is dispatched, not starved', () => {
    // One readied item is eligible: the loop has fuel, so it is not starved.
    const items = [makeItem({ identifier: 'DOR-1' })]; // has agent/ready
    const outcome = classifyDispatchOutcome(items, CONFIG, OPTS);
    expect(outcome.eligibleCount).toBe(1);
    expect(outcome.starved).toBe(false);
    expect(outcome.shapeableCount).toBe(0);
  });

  it('(d) mixed: one ready + two shapeable -> picked one, shapeable counted separately', () => {
    // The ready item is dispatched; the two behind the gate are shapeable, not
    // starved (something IS eligible), so a triage pass is offered, not forced.
    const items = [
      makeItem({ identifier: 'DOR-READY' }), // agent/ready
      makeItem({ identifier: 'DOR-SHAPE-1', labels: [] }),
      makeItem({ identifier: 'DOR-SHAPE-2', labels: ['stage/triage'] }),
    ];
    const outcome = classifyDispatchOutcome(items, CONFIG, OPTS);
    expect(outcome.eligibleCount).toBe(1);
    expect(outcome.shapeableCount).toBe(2);
    expect(outcome.starved).toBe(false);
  });
});
