/**
 * Which session a scheduled run runs on, and what happens when the runtime under
 * a sticky task changes (DOR-1571, DOR-1615).
 *
 * The lookup here is a REAL `TaskStore` over a real database, not a stub. That
 * is the whole lesson of the DOR-1615 review: the first version of this rule
 * took an injected `boundRuntimeOf` and passed six green tests while doing
 * nothing at all in production, because the table it read is only ever written
 * by interactive sessions. A stub can only ever prove that the branch works if
 * somebody answers it; the store proves that somebody does.
 *
 * @module services/tasks/session/__tests__/sticky-session
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import { SKILL_FILENAME } from '@dorkos/skills/constants';
import { TaskStore } from '../../task-store.js';
import { resolveRunSession } from '../sticky-session.js';

let db: Db;
let store: TaskStore;

beforeEach(() => {
  db = createTestDb();
  store = new TaskStore(db);
});

/**
 * A task, sticky unless said otherwise.
 *
 * @param sticky - Whether every fire resumes one session.
 */
function task(sticky = true) {
  return store.createTask({
    name: 'sweeper',
    description: 'Sweep the repo',
    prompt: 'sweep it',
    cron: '0 3 * * *',
    sticky,
    filePath: `/home/u/.dork/tasks/sweeper/${SKILL_FILENAME}`,
  });
}

/**
 * Record a run that ran a turn on `runtime` and left `sessionId` behind — what
 * a completed sticky fire actually writes.
 *
 * @param taskId - The task that fired.
 * @param sessionId - The real SDK id its turn ran under.
 * @param runtime - The runtime it resolved to, or null for a pre-column run.
 */
function completedRun(taskId: string, sessionId: string, runtime: string | null): void {
  const run = store.createRun(taskId, 'scheduled');
  if (runtime !== null) store.recordRunExecution(run.id, { runtime });
  store.updateRun(run.id, {
    status: 'completed',
    finishedAt: new Date().toISOString(),
    sessionId,
  });
}

/** The run row a fire opens for itself. */
function openRun(taskId: string) {
  return store.createRun(taskId, 'scheduled');
}

/** What every session route's `parseSessionId` will accept. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('resolveRunSession', () => {
  it('gives a non-sticky run a session of its own and no resume', () => {
    const t = task(false);
    completedRun(t.id, 'sess-old', 'claude-code');

    const resolved = resolveRunSession(store, t, { runtimeType: 'claude-code' });
    expect(resolved.hasStarted).toBe(false);
    expect(resolved.sessionId).toMatch(UUID);
  });

  it('gives every non-sticky run a session NOBODY else is on', () => {
    // The discriminating case for using a fresh id rather than the run's own.
    // Two fires of the same task must not land on one session, and — the reason
    // this changed at all — the id has to be one the session routes accept: a
    // run id is a ULID, and `parseSessionId` answers 400 for those, so a card
    // raised on that session could be opened by nobody and answered by nothing.
    const t = task(false);

    const first = resolveRunSession(store, t, { runtimeType: 'claude-code' });
    const second = resolveRunSession(store, t, { runtimeType: 'claude-code' });
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(first.sessionId).toMatch(UUID);
  });

  it("gives a sticky task's FIRST fire a session of its own and no resume", () => {
    const t = task();

    const resolved = resolveRunSession(store, t, { runtimeType: 'claude-code' });
    expect(resolved.hasStarted).toBe(false);
    expect(resolved.sessionId).toMatch(UUID);
  });

  it('resumes the prior session when the runtime has not changed', () => {
    const t = task();
    completedRun(t.id, 'sess-old', 'claude-code');
    const run = openRun(t.id);

    expect(resolveRunSession(store, t, { runtimeType: 'claude-code' })).toEqual({
      sessionId: 'sess-old',
      hasStarted: true,
    });
  });

  it('starts FRESH when the resolved runtime differs from the prior run’s', () => {
    // A session belongs to one runtime, decided by the first authoritative write
    // and never revised (ADR-0255). Asking Claude Code to resume a Codex thread
    // is not a degraded resume, it is a resume of nothing — so the honest answer
    // is the one this task's very first fire got.
    const t = task();
    completedRun(t.id, 'sess-codex', 'codex');

    const resolved = resolveRunSession(store, t, { runtimeType: 'claude-code' });
    expect(resolved.hasStarted).toBe(false);
    expect(resolved.sessionId).toMatch(UUID);
  });

  it('still resumes a prior run with NO runtime on record', () => {
    // The discriminating case. "Unknown" and "different" must not collapse: a
    // guess would manufacture a mismatch for every sticky task whose earlier
    // runs predate `resolved_runtime`, throwing away the history sticky exists
    // to carry.
    const t = task();
    completedRun(t.id, 'sess-ancient', null);
    const run = openRun(t.id);

    expect(resolveRunSession(store, t, { runtimeType: 'claude-code' })).toEqual({
      sessionId: 'sess-ancient',
      hasStarted: true,
    });
  });

  it('reads the runtime off the SAME run it takes the session from', () => {
    // Two runs, two runtimes. Answering from the newest session id but an older
    // run's runtime — which two separate queries could do — would resume a
    // Codex thread under Claude Code.
    const t = task();
    completedRun(t.id, 'sess-first', 'claude-code');
    completedRun(t.id, 'sess-second', 'codex');

    expect(resolveRunSession(store, t, { runtimeType: 'claude-code' }).hasStarted).toBe(false);
    expect(resolveRunSession(store, t, { runtimeType: 'codex' })).toEqual({
      sessionId: 'sess-second',
      hasStarted: true,
    });
  });
});
