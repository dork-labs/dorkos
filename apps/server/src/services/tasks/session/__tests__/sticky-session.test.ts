/**
 * Which session a scheduled run runs on, and what happens when the runtime under
 * a sticky task changes (DOR-1571, DOR-1615).
 *
 * The runtime lookup is a plain function per case rather than the registry,
 * because the rule under test is entirely about the THREE answers it can give —
 * same runtime, a different one, and nothing on record — and those three are
 * what a registry with a database behind it would only make harder to arrange.
 */
import { describe, it, expect } from 'vitest';
import type { Task, TaskRun } from '@dorkos/shared/types';
import { createMockSchedule, createMockRun } from '@dorkos/test-utils/mock-factories';
import { resolveRunSession, type StickySessionLookup } from '../sticky-session.js';

/** A lookup that answers with one fixed resume target, or none. */
function lookup(previous: string | null): StickySessionLookup {
  return { latestStickySessionId: () => previous };
}

/** The task under test. */
function task(overrides: Partial<Task> = {}): Task {
  return createMockSchedule({ id: 'task-1', ...overrides });
}

/** Its freshly opened run row. */
function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return createMockRun({ id: 'run-9', scheduleId: 'task-1', ...overrides });
}

/** "Every session is bound to this runtime." */
const boundTo = (runtime: string | null) => () => runtime;

describe('resolveRunSession', () => {
  it('gives a non-sticky run its own id and no resume', () => {
    expect(
      resolveRunSession(lookup('sess-old'), task({ sticky: false }), run(), {
        runtimeType: 'claude-code',
        boundRuntimeOf: boundTo('claude-code'),
      })
    ).toEqual({ sessionId: 'run-9', hasStarted: false });
  });

  it("gives a sticky task's FIRST fire its own id and no resume", () => {
    expect(
      resolveRunSession(lookup(null), task({ sticky: true }), run(), {
        runtimeType: 'claude-code',
        boundRuntimeOf: boundTo('claude-code'),
      })
    ).toEqual({ sessionId: 'run-9', hasStarted: false });
  });

  it('resumes the prior session when the runtime has not changed', () => {
    expect(
      resolveRunSession(lookup('sess-old'), task({ sticky: true }), run(), {
        runtimeType: 'claude-code',
        boundRuntimeOf: boundTo('claude-code'),
      })
    ).toEqual({ sessionId: 'sess-old', hasStarted: true });
  });

  it('starts FRESH when the resolved runtime differs from the session it would resume', () => {
    // A session belongs to one runtime, decided by the first authoritative write
    // and never revised (ADR-0255). Asking Claude Code to resume a Codex thread
    // is not a degraded resume, it is a resume of nothing — so the honest answer
    // is the same one this task's very first fire got.
    expect(
      resolveRunSession(lookup('sess-codex'), task({ sticky: true }), run(), {
        runtimeType: 'claude-code',
        boundRuntimeOf: boundTo('codex'),
      })
    ).toEqual({ sessionId: 'run-9', hasStarted: false });
  });

  it('still resumes a prior session with NO runtime on record', () => {
    // The discriminating case. "Unknown" and "different" must not collapse: a
    // guessed answer would manufacture a mismatch for every sticky task whose
    // earlier sessions predate the binding table, throwing away the very history
    // sticky exists to carry.
    expect(
      resolveRunSession(lookup('sess-ancient'), task({ sticky: true }), run(), {
        runtimeType: 'claude-code',
        boundRuntimeOf: boundTo(null),
      })
    ).toEqual({ sessionId: 'sess-ancient', hasStarted: true });
  });

  it('asks about the SESSION it would resume, not about the run', () => {
    const asked: string[] = [];
    resolveRunSession(lookup('sess-old'), task({ sticky: true }), run(), {
      runtimeType: 'claude-code',
      boundRuntimeOf: (id) => {
        asked.push(id);
        return 'claude-code';
      },
    });
    expect(asked).toEqual(['sess-old']);
  });
});
