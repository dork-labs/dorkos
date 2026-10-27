/**
 * Whether a schedule is failing (DOR-3123, spec `schedules-failing` SF-4), and
 * why — the one answer the list, its count and its Failing filter all read.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { pulseRuns, pulseSchedules, type Db } from '@dorkos/db';
import { healthOf, HEALTHY, scheduleHealth } from '../schedule-health.js';

/** One finished run, newest-first order is the caller's job. */
function run(
  id: string,
  status: string,
  extra: { refusedTools?: string[]; error?: string; outcome?: string; startedAt?: string } = {}
) {
  return {
    id,
    scheduleId: 's1',
    status,
    startedAt: extra.startedAt ?? `2026-10-25T0${id.slice(-1)}:00:00.000Z`,
    error: extra.error ?? null,
    refusedTools: extra.refusedTools ? JSON.stringify(extra.refusedTools) : null,
    outcome: extra.outcome ?? null,
  };
}

describe('healthOf', () => {
  it('is ok when the schedule never finished a run', () => {
    expect(healthOf([])).toEqual(HEALTHY);
  });

  it('is failing when the latest finished run needs attention, and names the tool', () => {
    expect(
      healthOf([run('r2', 'needs_attention', { refusedTools: ['Bash'], outcome: 'partial' })])
    ).toEqual({
      state: 'failing',
      reason: { kind: 'tool_refused', tools: ['Bash'], nothingDone: false, message: null },
      since: '2026-10-25T02:00:00.000Z',
      streak: 1,
      lastRunId: 'r2',
    });
  });

  it('counts the streak back to the last completed run, and dates it from the oldest', () => {
    const health = healthOf([
      run('r4', 'failed', { error: 'API Error: 500\nstack' }),
      run('r3', 'needs_attention', { refusedTools: ['Bash', 'Write'] }),
      run('r2', 'failed', { error: 'x' }),
      run('r1', 'completed'),
    ]);
    expect(health).toMatchObject({
      state: 'failing',
      reason: { kind: 'error', message: 'API Error: 500' },
      since: '2026-10-25T02:00:00.000Z',
      streak: 3,
      lastRunId: 'r4',
    });
  });

  it('clears after one completed run', () => {
    expect(healthOf([run('r2', 'completed'), run('r1', 'failed')])).toEqual(HEALTHY);
  });

  it('names several refused tools, and says when nothing got done', () => {
    expect(
      healthOf([
        run('r1', 'needs_attention', { refusedTools: ['Bash', 'Write'], outcome: 'nothing_done' }),
      ]).reason
    ).toEqual({
      kind: 'tools_refused',
      tools: ['Bash', 'Write'],
      nothingDone: true,
      message: null,
    });
  });

  it('reads an expired sign-in as its own reason', () => {
    expect(healthOf([run('r1', 'failed', { error: 'Sign in again: 401' })]).reason?.kind).toBe(
      'signin_needed'
    );
  });
});

describe('scheduleHealth', () => {
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
    db.insert(pulseSchedules)
      .values(
        ['s1', 's2'].map((id) => ({
          id,
          name: id,
          cron: '0 * * * *',
          prompt: 'p',
          status: 'active' as const,
          filePath: `/x/${id}/SKILL.md`,
          createdAt: '2026-10-01',
          updatedAt: '2026-10-01',
        }))
      )
      .run();
  });

  /** Write one run row. */
  function insert(id: string, scheduleId: string, status: string, startedAt: string): void {
    db.insert(pulseRuns)
      .values({
        id,
        scheduleId,
        status: status as 'completed',
        startedAt,
        trigger: 'scheduled',
        createdAt: startedAt,
        refusedTools: status === 'needs_attention' ? '["Bash"]' : '[]',
      })
      .run();
  }

  it('ignores skipped, cancelled and running runs, which say nothing about the schedule', () => {
    insert('a1', 's1', 'needs_attention', '2026-10-25T01:00:00.000Z');
    insert('a2', 's1', 'skipped', '2026-10-25T02:00:00.000Z');
    insert('a3', 's1', 'cancelled', '2026-10-25T03:00:00.000Z');
    insert('a4', 's1', 'running', '2026-10-25T04:00:00.000Z');
    insert('b1', 's2', 'failed', '2026-10-25T01:00:00.000Z');
    insert('b2', 's2', 'completed', '2026-10-25T02:00:00.000Z');

    const health = scheduleHealth(db);
    expect(health.get('s1')).toMatchObject({ state: 'failing', streak: 1, lastRunId: 'a1' });
    expect(health.get('s2')).toEqual(HEALTHY);
  });
});
