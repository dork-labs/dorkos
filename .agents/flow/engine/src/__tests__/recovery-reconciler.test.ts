/**
 * Unit suite for the **recovery reconciler** (task 3.4) — the head-of-tick
 * reconciler (priority 10) wrapping the {@link recoverOrphan} ladder.
 *
 * The invariants pinned here (§6):
 *   - intact checkpoint + dead worker → `resume` (re-attach at HEAD);
 *   - no worktree → `restart-clean` (reason `no-worktree`);
 *   - retries exhausted → `escalate` to `agent/blocked`;
 *   - a parked `agent/needs-input` candidate is NOT in the `isDue` set — parked is
 *     never reclaimed (the single most important invariant);
 *   - contention: recovery(10) + dispatch(30) on the SAME item → recovery acts and
 *     dispatch stands down for that item.
 *
 * The reconciler is pure: every probe/record fact is injected via the
 * {@link RecoveryCandidate} bag (no disk, no tracker). Imports from relative module
 * paths (NOT the `@dorkos/flow` barrel), matching the sibling suites.
 *
 * @see specs/flow-triage-feeds-loop/02-specification.md §6
 */

import { describe, expect, it } from 'vitest';
import { DispatchSchema, OwnershipSchema, RecoverySchema, WipCapSchema } from '../config-schema.js';
import type { DispatchOptions } from '../dispatch.js';
import type { FlowRun, RecoveryConfig, RecoveryContext } from '../flow-run.js';
import type { WorkItem } from '../work-item.js';
import type { ReconcileContext } from '../reconciler.js';
import { runTick } from '../scheduler.js';
import {
  defaultRegistry,
  recoveryReconciler,
  type FlowReconcileInput,
  type RecoveryCandidate,
} from '../reconcilers.js';

// ─── shared fixtures ────────────────────────────────────────────────────────

/** The §9/§12 resolved default recovery policy (maxRetries 2). */
const DEFAULT_RECOVERY: RecoveryConfig = RecoverySchema.parse({});

/** A durable run record with a usable checkpoint, overridable per-test. */
function flowRun(overrides: Partial<FlowRun> = {}): FlowRun {
  return {
    issueId: 'issue-node-1',
    identifier: 'DOR-1',
    sessionId: 'session-abc',
    worktreePath: '/Users/x/.dork/workspaces/core/DOR-1',
    branch: 'dork/DOR-1',
    stage: 'execute',
    status: 'running',
    attemptCount: 0,
    workerPid: 4242,
    startedAt: '2026-06-14T00:00:00.000Z',
    ...overrides,
  };
}

/** A probe context where the checkpoint (git commit + JSONL session) survives. */
function intactProbe(overrides: Partial<RecoveryContext> = {}): RecoveryContext {
  return { worktreeExists: true, sessionLogIntact: true, ...overrides };
}

/** A recovery candidate, defaulting to a resumable `claimed-no-worker` orphan. */
function candidate(overrides: Partial<RecoveryCandidate> = {}): RecoveryCandidate {
  return {
    itemId: 'DOR-1',
    signal: 'claimed-no-worker',
    run: flowRun(),
    probe: intactProbe(),
    ...overrides,
  };
}

/** A recovery-only context with the given candidates + the default policy. */
function recoveryCtx(
  candidates: RecoveryCandidate[],
  claimed?: Set<string>
): ReconcileContext<FlowReconcileInput> {
  return {
    now: 0,
    claimedItemIds: claimed,
    input: { recovery: { candidates, recovery: DEFAULT_RECOVERY } },
  };
}

// ─── the recovery action ladder, surfaced through the reconciler ──────────────

describe('recoveryReconciler — resume / restart-clean / escalate', () => {
  it('(a) intact checkpoint + dead worker → resume (attemptCount + 1)', async () => {
    const ctx = recoveryCtx([candidate({ run: flowRun({ attemptCount: 0 }) })]);
    expect(recoveryReconciler.isDue(ctx)).toBe(true);

    const result = await recoveryReconciler.run(ctx);
    expect(result.acted).toBe(true);
    expect(result.itemId).toBe('DOR-1');
    expect(result.summary).toMatch(/resume/);
    expect(result.summary).toMatch(/attempt 1/); // attemptCount + 1
  });

  it('(b) no worktree → restart-clean (reason no-worktree)', async () => {
    const ctx = recoveryCtx([candidate({ probe: intactProbe({ worktreeExists: false }) })]);
    const result = await recoveryReconciler.run(ctx);
    expect(result.acted).toBe(true);
    expect(result.summary).toMatch(/restart-clean/);
    expect(result.summary).toMatch(/no-worktree/);
  });

  it('(c) retries exhausted → escalate to agent/blocked', async () => {
    const ctx = recoveryCtx([
      candidate({ run: flowRun({ attemptCount: DEFAULT_RECOVERY.maxRetries }) }),
    ]);
    const result = await recoveryReconciler.run(ctx);
    expect(result.acted).toBe(true);
    expect(result.summary).toMatch(/escalate/);
    expect(result.summary).toMatch(/agent\/blocked/);
  });

  it('re-derives when there is no local record (claimed on another machine)', async () => {
    const ctx = recoveryCtx([candidate({ signal: 'no-local-record', run: null })]);
    const result = await recoveryReconciler.run(ctx);
    expect(result.acted).toBe(true);
    expect(result.summary).toMatch(/re-derive/);
  });
});

describe('recoveryReconciler — parked is NEVER reclaimed (the key invariant)', () => {
  it('(d) a needs-input candidate is NOT in the isDue set', () => {
    const ctx = recoveryCtx([candidate({ signal: 'needs-input' })]);
    // Parked on a human → not due, never reclaimed.
    expect(recoveryReconciler.isDue(ctx)).toBe(false);
  });

  it('skips a needs-input candidate but still acts on a sibling orphan', async () => {
    const ctx = recoveryCtx([
      candidate({ itemId: 'DOR-parked', signal: 'needs-input' }),
      candidate({ itemId: 'DOR-orphan', run: flowRun({ identifier: 'DOR-orphan' }) }),
    ]);
    expect(recoveryReconciler.isDue(ctx)).toBe(true);
    const result = await recoveryReconciler.run(ctx);
    // The parked item is skipped; the real orphan is the one acted on.
    expect(result.itemId).toBe('DOR-orphan');
    expect(result.summary).toMatch(/resume/);
  });

  it('is not due when the recovery slice is absent', () => {
    expect(recoveryReconciler.isDue({ now: 0, input: {} })).toBe(false);
  });

  it('skips an orphan already claimed earlier this tick (contention)', () => {
    const ctx = recoveryCtx([candidate({ itemId: 'DOR-1' })], new Set(['DOR-1']));
    expect(recoveryReconciler.isDue(ctx)).toBe(false);
  });
});

// ─── ordering: recovery (10) before dispatch (30) on the same item ────────────

describe('defaultRegistry + runTick — recovery claims an orphan before dispatch', () => {
  /** A backlog-category, agent/ready WorkItem (claimable under default policy). */
  function readyItem(identifier: string): WorkItem {
    return {
      id: `node_${identifier}`,
      identifier,
      title: `Title ${identifier}`,
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
    };
  }

  it('(e) recovery(10) acts on DOR-1 so dispatch(30) skips it', async () => {
    const opts: DispatchOptions = { classifyOwnership: () => 'unassigned' };
    const ctx: ReconcileContext<FlowReconcileInput> = {
      now: 0,
      input: {
        // Recovery sees DOR-1 as an orphan; dispatch sees DOR-1 as ready work.
        recovery: { candidates: [candidate({ itemId: 'DOR-1' })], recovery: DEFAULT_RECOVERY },
        dispatch: {
          items: [readyItem('DOR-1')],
          config: {
            dispatch: DispatchSchema.parse({}),
            ownership: OwnershipSchema.parse({}),
            wipCap: WipCapSchema.parse({}),
          },
          opts,
        },
      },
    };

    const results = await runTick(defaultRegistry(), ctx);

    const recovery = results.find((r) => r.id === 'recovery');
    const dispatch = results.find((r) => r.id === 'dispatch');
    expect(recovery?.acted).toBe(true);
    expect(recovery?.itemId).toBe('DOR-1');
    // dispatch stood down: DOR-1 was already claimed by recovery, no other item.
    expect(dispatch?.acted).toBeFalsy();
  });
});
