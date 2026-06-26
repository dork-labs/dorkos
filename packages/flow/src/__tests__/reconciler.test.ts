/**
 * Unit suite for the reconciler **registry + scheduler** (task 2.3) and the
 * **baseline reconcilers** wrapping the existing oracles (task 2.5).
 *
 * The scheduler invariants pinned here (§3):
 *   - priority order: reconcilers run in ascending `priority` (lower first);
 *   - due-gating: `enabled: false` and `isDue() === false` both skip `run`;
 *   - contention: a higher-priority reconciler that claims an item makes a
 *     lower-priority one targeting the SAME item stand down (recovery before
 *     dispatch). The contention test FAILS on any non-priority-ordered or
 *     non-deduped scheduler.
 *
 * The baseline invariants (§3):
 *   - `defaultRegistry().list()` is priority-ordered recovery < review < dispatch
 *     < triage < hygiene (the head-of-tick `recovery` slot is filled by task 3.3);
 *   - each baseline reconciler's `run` delegates to its wrapped oracle with no
 *     new decision logic (asserted on the observable result, never the impl).
 *
 * Imports from relative module paths (NOT the `@dorkos/flow` barrel), matching the
 * sibling suites.
 *
 * @see specs/flow-triage-feeds-loop/02-specification.md §3
 */

import { describe, expect, it, vi } from 'vitest';
import {
  CalibrationSchema,
  DispatchSchema,
  GatesSchema,
  OwnershipSchema,
  WipCapSchema,
} from '../config-schema.js';
import { classifyDispatchOutcome, selectDispatch, type DispatchOptions } from '../dispatch.js';
import type { MergeState } from '../gates.js';
import type { WorkItem } from '../work-item.js';
import type { ReconcileContext, ReconcileResult, Reconciler, ReconcilerId } from '../reconciler.js';
import {
  createReconcilerRegistry,
  isCadenceDue,
  runTick,
  type LoopConfigOverrides,
} from '../scheduler.js';
import {
  defaultRegistry,
  dispatchReconciler,
  hygieneReconciler,
  reviewReconciler,
  triageReconciler,
  type FlowReconcileInput,
} from '../reconcilers.js';

// ─── shared fixtures ────────────────────────────────────────────────────────

/** A base, scheduler-free context for fake reconcilers that ignore `input`. */
const BARE_CTX: ReconcileContext<unknown> = { now: 1_000_000, input: undefined };

/** Resolved dispatch policy config — the default §9 dispatch/ownership/WIP. */
const DISPATCH_CONFIG = {
  dispatch: DispatchSchema.parse({}),
  ownership: OwnershipSchema.parse({}),
  wipCap: WipCapSchema.parse({}),
};

/** Stub ownership: every item is `unassigned` (claimable under the default policy). */
const OPTS: DispatchOptions = { classifyOwnership: () => 'unassigned' };

/** Build a backlog-category WorkItem carrying `agent/ready` unless overridden. */
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

/**
 * Build a fake reconciler with a fixed priority and overridable `isDue`/`run`.
 * Defaults: always due, acts as a benign no-op. `intervalMs` is irrelevant here
 * (cadence is exercised by {@link isCadenceDue} directly).
 */
function fakeReconciler(
  id: ReconcilerId,
  priority: number,
  overrides: Partial<Pick<Reconciler<unknown>, 'isDue' | 'run'>> = {}
): Reconciler<unknown> {
  return {
    id,
    defaultConfig: { enabled: true, priority, intervalMs: 1000 },
    isDue: overrides.isDue ?? ((): boolean => true),
    run:
      overrides.run ??
      ((): Promise<ReconcileResult> => Promise.resolve({ id, acted: false, summary: `${id} ran` })),
  };
}

// ─── task 2.3 — the scheduler ─────────────────────────────────────────────────

describe('runTick — priority order (ascending; lower first)', () => {
  it('runs reconcilers in ascending priority regardless of registration order', async () => {
    // Registered 50, 10, 30 — the scheduler must reorder to 10, 30, 50.
    const order: ReconcilerId[] = [];
    const log = (id: ReconcilerId) => (): Promise<ReconcileResult> => {
      order.push(id);
      return Promise.resolve({ id, acted: false, summary: '' });
    };
    const registry = createReconcilerRegistry([
      fakeReconciler('hygiene', 50, { run: log('hygiene') }),
      fakeReconciler('recovery', 10, { run: log('recovery') }),
      fakeReconciler('dispatch', 30, { run: log('dispatch') }),
    ]);

    const results = await runTick(registry, BARE_CTX);

    expect(order).toEqual(['recovery', 'dispatch', 'hygiene']);
    // The collected results come back in the same priority order.
    expect(results.map((r) => r.id)).toEqual(['recovery', 'dispatch', 'hygiene']);
  });

  it('honors a loops priority override when ordering the tick', async () => {
    // dispatch defaults to priority 30 but is overridden to 5 — it must run first.
    const order: ReconcilerId[] = [];
    const log = (id: ReconcilerId) => (): Promise<ReconcileResult> => {
      order.push(id);
      return Promise.resolve({ id, acted: false, summary: '' });
    };
    const registry = createReconcilerRegistry([
      fakeReconciler('recovery', 10, { run: log('recovery') }),
      fakeReconciler('dispatch', 30, { run: log('dispatch') }),
    ]);
    const overrides: LoopConfigOverrides = { dispatch: { priority: 5 } };

    await runTick(registry, BARE_CTX, overrides);

    expect(order).toEqual(['dispatch', 'recovery']);
  });
});

describe('runTick — due-gating (enabled + isDue both skip run)', () => {
  it('skips a not-due reconciler and a disabled reconciler; runs the enabled+due one', async () => {
    const notDueRun = vi.fn(() =>
      Promise.resolve({ id: 'recovery' as const, acted: false, summary: '' })
    );
    const disabledRun = vi.fn(() =>
      Promise.resolve({ id: 'dispatch' as const, acted: false, summary: '' })
    );
    const enabledRun = vi.fn(() =>
      Promise.resolve({ id: 'hygiene' as const, acted: true, summary: 'ran' })
    );

    const registry = createReconcilerRegistry([
      fakeReconciler('recovery', 10, { isDue: () => false, run: notDueRun }),
      fakeReconciler('dispatch', 30, { run: disabledRun }),
      fakeReconciler('hygiene', 50, { run: enabledRun }),
    ]);
    // dispatch is disabled via the loops override; recovery is not due.
    const overrides: LoopConfigOverrides = { dispatch: { enabled: false } };

    const results = await runTick(registry, BARE_CTX, overrides);

    expect(notDueRun).not.toHaveBeenCalled();
    expect(disabledRun).not.toHaveBeenCalled();
    expect(enabledRun).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.id)).toEqual(['hygiene']);
  });
});

describe('runTick — same-item contention resolved by priority (recovery before dispatch)', () => {
  it('skips the lower-priority run for an item the higher-priority one already claimed', async () => {
    // priority-10 reconciler claims DOR-1; priority-30 reconciler also targets
    // DOR-1 and stands down when it sees DOR-1 in the threaded claimed set. This
    // FAILS if the scheduler runs out of priority order (claimed still empty when
    // the low one checks) or does not thread the claimed set at all.
    const highRun = vi.fn(() =>
      Promise.resolve({
        id: 'recovery' as const,
        acted: true,
        itemId: 'DOR-1',
        summary: 'recovered DOR-1',
      })
    );
    const lowRun = vi.fn(() =>
      Promise.resolve({
        id: 'dispatch' as const,
        acted: true,
        itemId: 'DOR-1',
        summary: 'claim DOR-1',
      })
    );

    const registry = createReconcilerRegistry([
      // Registered low-first to also exercise the reorder.
      fakeReconciler('dispatch', 30, {
        isDue: (ctx) => !(ctx.claimedItemIds?.has('DOR-1') ?? false),
        run: lowRun,
      }),
      fakeReconciler('recovery', 10, { run: highRun }),
    ]);

    const results = await runTick(registry, BARE_CTX);

    expect(highRun).toHaveBeenCalledTimes(1);
    expect(lowRun).not.toHaveBeenCalled();
    expect(results.map((r) => r.id)).toEqual(['recovery']);
  });

  it('lets the lower-priority reconciler act on a DIFFERENT item', async () => {
    // recovery claims DOR-1; dispatch targets DOR-2, which is not claimed, so it runs.
    const registry = createReconcilerRegistry([
      fakeReconciler('recovery', 10, {
        run: () =>
          Promise.resolve({ id: 'recovery', acted: true, itemId: 'DOR-1', summary: 'DOR-1' }),
      }),
      fakeReconciler('dispatch', 30, {
        isDue: (ctx) => !(ctx.claimedItemIds?.has('DOR-2') ?? false),
        run: () =>
          Promise.resolve({ id: 'dispatch', acted: true, itemId: 'DOR-2', summary: 'DOR-2' }),
      }),
    ]);

    const results = await runTick(registry, BARE_CTX);

    expect(results.map((r) => r.itemId)).toEqual(['DOR-1', 'DOR-2']);
  });
});

describe('isCadenceDue — the cadence half of isDue', () => {
  it('is due when never run before (lastRunAt undefined)', () => {
    expect(isCadenceDue({ now: 0, input: undefined }, 60_000)).toBe(true);
  });

  it('is due once the interval has elapsed, not before', () => {
    expect(isCadenceDue({ now: 60_000, lastRunAt: 0, input: undefined }, 60_000)).toBe(true);
    expect(isCadenceDue({ now: 59_999, lastRunAt: 0, input: undefined }, 60_000)).toBe(false);
  });
});

// ─── task 2.5 — the baseline reconcilers ──────────────────────────────────────

describe('defaultRegistry — baseline reconcilers in priority order', () => {
  it('lists recovery(10) < review(25) < dispatch(30) < triage(40) < hygiene(50)', () => {
    const list = defaultRegistry().list();
    expect(list.map((r) => r.id)).toEqual(['recovery', 'review', 'dispatch', 'triage', 'hygiene']);
    expect(list.map((r) => r.defaultConfig.priority)).toEqual([10, 25, 30, 40, 50]);
  });

  it('each baseline defaultConfig is enabled with a positive cadence', () => {
    for (const r of defaultRegistry().list()) {
      expect(r.defaultConfig.enabled).toBe(true);
      expect(r.defaultConfig.intervalMs).toBeGreaterThan(0);
    }
  });
});

describe('dispatchReconciler — wraps selectDispatch with no new logic', () => {
  // Two DIFFERENT projects so both survive the perProject WIP cap (1); global cap
  // (2) admits both, leaving the priority tier to rank DOR-2 (urgent) first.
  const items = [
    makeItem({
      identifier: 'DOR-1',
      priority: 3,
      project: { id: 'proj_a', name: 'A', stateCategory: 'started' },
    }),
    makeItem({
      identifier: 'DOR-2',
      priority: 1, // urgent → ranks first
      project: { id: 'proj_b', name: 'B', stateCategory: 'started' },
    }),
  ];
  const ctx = (claimed?: Set<string>): ReconcileContext<FlowReconcileInput> => ({
    now: 0,
    claimedItemIds: claimed,
    input: { dispatch: { items, config: DISPATCH_CONFIG, opts: OPTS } },
  });

  it('isDue when there is unclaimed eligible work, not when the slice is absent', () => {
    expect(dispatchReconciler.isDue(ctx())).toBe(true);
    expect(dispatchReconciler.isDue({ now: 0, input: {} })).toBe(false);
  });

  it('run claims exactly the oracle top pick (delegation, not re-ranking)', async () => {
    const expected = selectDispatch(items, DISPATCH_CONFIG, OPTS)[0]?.identifier;
    const result = await dispatchReconciler.run(ctx());
    expect(result.acted).toBe(true);
    expect(result.itemId).toBe(expected); // DOR-2 (urgent)
    expect(result.id).toBe('dispatch');
  });

  it('skips an item already claimed this tick (contention)', async () => {
    const top = selectDispatch(items, DISPATCH_CONFIG, OPTS)[0]?.identifier as string;
    const result = await dispatchReconciler.run(ctx(new Set([top])));
    // The top pick is claimed, so it falls through to the next eligible item.
    expect(result.itemId).not.toBe(top);
    expect(result.itemId).toBe('DOR-1');
  });
});

describe('hygieneReconciler — wraps classifyDispatchOutcome', () => {
  it('run surfaces starvation (acted === outcome.starved)', async () => {
    // Three backlog items WITHOUT agent/ready → starved.
    const items = [
      makeItem({ identifier: 'DOR-1', labels: [] }),
      makeItem({ identifier: 'DOR-2', labels: [] }),
      makeItem({ identifier: 'DOR-3', labels: [] }),
    ];
    const outcome = classifyDispatchOutcome(items, DISPATCH_CONFIG, OPTS);
    const result = await hygieneReconciler.run({
      now: 0,
      input: { hygiene: { items, config: DISPATCH_CONFIG, opts: OPTS } },
    });
    expect(result.acted).toBe(outcome.starved);
    expect(result.acted).toBe(true);
    expect(result.summary).toContain('3 shapeable');
  });

  it('is not due when the slice is absent', () => {
    expect(hygieneReconciler.isDue({ now: 0, input: {} })).toBe(false);
  });
});

describe('reviewReconciler — wraps evaluateAutoMerge', () => {
  it('run reports the auto-merge disposition for the approved PR', async () => {
    const state: MergeState = {
      mergeable: 'clean',
      ci: 'green',
      functionalChange: false,
      attemptCount: 1,
    };
    const result = await reviewReconciler.run({
      now: 0,
      input: {
        review: {
          itemId: 'DOR-9',
          state,
          gates: GatesSchema.parse({}),
          calibration: CalibrationSchema.parse({}),
        },
      },
    });
    // clean + green + no drift → the ladder yields a plain merge.
    expect(result.acted).toBe(true);
    expect(result.itemId).toBe('DOR-9');
    expect(result.summary).toContain('merge');
  });
});

describe('triageReconciler — thin delegation marker (no typed oracle)', () => {
  it('is due and acts when shapeable backlog exists', async () => {
    const ctx: ReconcileContext<FlowReconcileInput> = {
      now: 0,
      input: { triage: { shapeableCount: 4 } },
    };
    expect(triageReconciler.isDue(ctx)).toBe(true);
    const result = await triageReconciler.run(ctx);
    expect(result.acted).toBe(true);
    expect(result.itemId).toBeUndefined(); // backlog-wide, not item-scoped
    expect(result.summary).toContain('4 shapeable');
  });

  it('is not due when nothing is shapeable', () => {
    expect(triageReconciler.isDue({ now: 0, input: { triage: { shapeableCount: 0 } } })).toBe(
      false
    );
  });
});

describe('defaultRegistry + runTick — review claims a gated item before dispatch', () => {
  it('review (25) claims DOR-1 so dispatch (30) skips it', async () => {
    // A single ready item DOR-1 that is ALSO the approved-PR candidate at the gate.
    // review runs first (priority 25), claims DOR-1; dispatch then finds no
    // unclaimed eligible item and stands down.
    const items = [makeItem({ identifier: 'DOR-1' })];
    const ctx: ReconcileContext<FlowReconcileInput> = {
      now: 0,
      input: {
        review: {
          itemId: 'DOR-1',
          state: { mergeable: 'clean', ci: 'green', functionalChange: false, attemptCount: 1 },
          gates: GatesSchema.parse({}),
          calibration: CalibrationSchema.parse({}),
        },
        dispatch: { items, config: DISPATCH_CONFIG, opts: OPTS },
        // hygiene + triage absent → not due this tick.
      },
    };

    const results = await runTick(defaultRegistry(), ctx);

    const review = results.find((r) => r.id === 'review');
    const dispatch = results.find((r) => r.id === 'dispatch');
    expect(review?.acted).toBe(true);
    expect(review?.itemId).toBe('DOR-1');
    // dispatch stood down: DOR-1 was already claimed, no other eligible item.
    expect(dispatch?.acted).toBeFalsy();
  });
});
