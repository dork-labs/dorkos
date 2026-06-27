/**
 * Unit suite for the **`FlowRun` writer/reader** (task 3.2) — the typed
 * `flow-state.json` store (`flow-state.ts`).
 *
 * The invariants pinned here (§6):
 *   - round-trip: `writeFlowRun` then `readFlowState` returns the same record keyed
 *     by `issueId`;
 *   - upsert: a second write for one `issueId` replaces, never duplicates;
 *   - fail-soft: a non-JSON store reads as `{}` and never throws;
 *   - status update: `updateFlowRunStatus` flips the lifecycle status and applies a
 *     field patch;
 *   - gc: `gcFlowState` drops exactly the closed records and returns the count.
 *
 * The store is an **in-memory** {@link FlowStateStore} — the fs seam lives at the
 * consumer (the package performs no I/O), so the tests never touch a real
 * `~/.dork`. Imports from relative module paths (NOT the `@dorkos/flow` barrel),
 * matching the sibling suites.
 *
 * @see specs/flow-triage-feeds-loop/02-specification.md §6
 */

import { describe, expect, it } from 'vitest';
import type { FlowRun } from '../flow-run.js';
import {
  gcFlowState,
  parseFlowState,
  pruneClosedRuns,
  readFlowState,
  serializeFlowState,
  updateFlowRunStatus,
  writeFlowRun,
  type FlowStateStore,
} from '../flow-state.js';

/** A durable run record, overridable per-test. */
function flowRun(overrides: Partial<FlowRun> = {}): FlowRun {
  return {
    issueId: 'issue-node-1',
    identifier: 'DOR-123',
    sessionId: 'session-abc',
    worktreePath: '/Users/x/.dork/workspaces/core/DOR-123',
    branch: 'dork/DOR-123',
    stage: 'execute',
    status: 'running',
    attemptCount: 0,
    workerPid: 4242,
    startedAt: '2026-06-14T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * An in-memory {@link FlowStateStore} — the injected fs seam, backed by a string
 * cell instead of a file. Proves the package needs no real filesystem.
 */
function memoryStore(initial?: string): FlowStateStore & { dump(): string | undefined } {
  let cell: string | undefined = initial;
  return {
    read: () => cell,
    write: (contents: string) => {
      cell = contents;
    },
    dump: () => cell,
  };
}

describe('flow-state writer/reader — round-trip + upsert', () => {
  it('writeFlowRun then readFlowState round-trips a record keyed by issueId', () => {
    const store = memoryStore();
    const run = flowRun();
    writeFlowRun(store, run);

    const state = readFlowState(store);
    expect(state[run.issueId]).toEqual(run);
    expect(Object.keys(state)).toEqual([run.issueId]);
  });

  it('a second write for the same issueId replaces, never duplicates', () => {
    const store = memoryStore();
    writeFlowRun(store, flowRun({ stage: 'execute' }));
    writeFlowRun(store, flowRun({ stage: 'verify', attemptCount: 1 }));

    const state = readFlowState(store);
    // Same key → one entry, carrying the latest write.
    expect(Object.keys(state)).toHaveLength(1);
    expect(state['issue-node-1']?.stage).toBe('verify');
    expect(state['issue-node-1']?.attemptCount).toBe(1);
  });

  it('keeps distinct issueIds side by side', () => {
    const store = memoryStore();
    writeFlowRun(store, flowRun({ issueId: 'issue-1', identifier: 'DOR-1' }));
    writeFlowRun(store, flowRun({ issueId: 'issue-2', identifier: 'DOR-2' }));

    const state = readFlowState(store);
    expect(Object.keys(state).sort()).toEqual(['issue-1', 'issue-2']);
  });
});

describe('flow-state reader — fail-soft (never throws)', () => {
  it('a non-JSON store reads as {} (fail-soft, never throws)', () => {
    const store = memoryStore('}{ not json at all');
    expect(() => readFlowState(store)).not.toThrow();
    expect(readFlowState(store)).toEqual({});
  });

  it('an absent store reads as {}', () => {
    expect(readFlowState(memoryStore(undefined))).toEqual({});
  });

  it('a store that throws on read degrades to {} rather than propagating', () => {
    const throwingStore: FlowStateStore = {
      read: () => {
        throw new Error('EACCES');
      },
      write: () => undefined,
    };
    expect(() => readFlowState(throwingStore)).not.toThrow();
    expect(readFlowState(throwingStore)).toEqual({});
  });

  it('schema-invalid JSON (wrong field types) is rejected wholesale as {}', () => {
    // `attemptCount` is a string here — the whole record map is rejected.
    const store = memoryStore(
      JSON.stringify({ 'issue-1': { ...flowRun(), attemptCount: 'nope' } })
    );
    expect(readFlowState(store)).toEqual({});
  });

  it('parseFlowState is the pure fromJSON half (empty string → {})', () => {
    expect(parseFlowState('')).toEqual({});
    expect(parseFlowState(undefined)).toEqual({});
  });
});

describe('flow-state writer — updateFlowRunStatus', () => {
  it('flips running → waiting_for_review and applies a field patch', () => {
    const store = memoryStore();
    writeFlowRun(store, flowRun({ status: 'running', stage: 'verify' }));

    updateFlowRunStatus(store, 'issue-node-1', 'waiting_for_review', {
      stage: 'review',
      completedAt: '2026-06-14T01:00:00.000Z',
    });

    const updated = readFlowState(store)['issue-node-1'];
    expect(updated?.status).toBe('waiting_for_review');
    expect(updated?.stage).toBe('review');
    expect(updated?.completedAt).toBe('2026-06-14T01:00:00.000Z');
    // Untouched fields survive the patch.
    expect(updated?.sessionId).toBe('session-abc');
  });

  it('is a no-op when no record exists for the issueId (never fabricates a run)', () => {
    const store = memoryStore();
    updateFlowRunStatus(store, 'absent', 'complete');
    expect(readFlowState(store)).toEqual({});
  });

  it('does not let the patch override the governing issueId or status', () => {
    const store = memoryStore();
    writeFlowRun(store, flowRun());
    updateFlowRunStatus(store, 'issue-node-1', 'complete', {
      // These are governed by the explicit args, not the patch.
      issueId: 'hijacked',
      status: 'failed',
    } as Partial<FlowRun>);

    const state = readFlowState(store);
    expect(state['hijacked']).toBeUndefined();
    expect(state['issue-node-1']?.status).toBe('complete');
  });
});

describe('flow-state gc — drop closed-issue records', () => {
  it('gcFlowState removes exactly the closed record and returns the count', () => {
    const store = memoryStore();
    writeFlowRun(store, flowRun({ issueId: 'open-1', identifier: 'DOR-1' }));
    writeFlowRun(store, flowRun({ issueId: 'closed-1', identifier: 'DOR-2' }));

    const removed = gcFlowState(store, (issueId) => issueId === 'closed-1');

    expect(removed).toBe(1);
    const state = readFlowState(store);
    expect(Object.keys(state)).toEqual(['open-1']);
  });

  it('returns 0 and leaves the store byte-identical when nothing is closed', () => {
    const store = memoryStore();
    writeFlowRun(store, flowRun({ issueId: 'open-1' }));
    const before = store.dump();

    const removed = gcFlowState(store, () => false);

    expect(removed).toBe(0);
    expect(store.dump()).toBe(before); // no write when nothing dropped
  });

  it('pruneClosedRuns is the pure keep/drop core (no I/O)', () => {
    const state: Record<string, FlowRun> = {
      a: flowRun({ issueId: 'a' }),
      b: flowRun({ issueId: 'b' }),
    };
    const { kept, removed } = pruneClosedRuns(state, (id) => id === 'a');
    expect(removed).toBe(1);
    expect(Object.keys(kept)).toEqual(['b']);
    // Pure: the input map is untouched.
    expect(Object.keys(state).sort()).toEqual(['a', 'b']);
  });
});

describe('flow-state serializer — canonical JSON round-trips', () => {
  it('serializeFlowState → parseFlowState is identity over a run map', () => {
    const state: Record<string, FlowRun> = { 'issue-node-1': flowRun() };
    expect(parseFlowState(serializeFlowState(state))).toEqual(state);
  });
});
