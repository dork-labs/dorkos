/**
 * Unit tests for the machine-wide daily session counts (DOR-1039).
 *
 * The Activity tab's week line counts the same subject its feed describes:
 * every agent on this machine, not the project the client happens to have
 * selected. These tests pin the three properties that makes it honest — the
 * fan-out covers every agent path, a runtime that cannot answer degrades to a
 * warning instead of a silently smaller number, and only sessions created
 * inside the window are counted.
 */
import { describe, it, expect } from 'vitest';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { Session } from '@dorkos/shared/types';
import { countSessionsPerDay } from '../session-daily-counts.js';

/** Local-midnight ISO timestamp `daysAgo` days before `now`. */
function daysBefore(now: Date, daysAgo: number, hour = 12): string {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, hour);
  return day.toISOString();
}

function makeSession(id: string, createdAt: string, cwd: string | undefined): Session {
  return {
    id,
    title: `Session ${id}`,
    createdAt,
    updatedAt: createdAt,
    permissionMode: 'default',
    runtime: 'fake-a',
    ...(cwd !== undefined ? { cwd } : {}),
  };
}

/** A FakeAgentRuntime whose listSessions answers per working directory. */
function runtimeReturning(type: string, byDir: Record<string, Session[]>): FakeAgentRuntime {
  const runtime = new FakeAgentRuntime(type);
  runtime.listSessions.mockImplementation((dir: string) => Promise.resolve(byDir[dir] ?? []));
  return runtime;
}

const NOW = new Date('2026-08-10T15:00:00');

describe('countSessionsPerDay', () => {
  it('counts sessions from EVERY agent path, bucketed oldest day first', async () => {
    const runtime = runtimeReturning('fake-a', {
      '/p1': [
        makeSession('a1', daysBefore(NOW, 0), '/p1'),
        makeSession('a2', daysBefore(NOW, 6), '/p1'),
      ],
      '/p2': [makeSession('b1', daysBefore(NOW, 0), '/p2')],
    });

    const result = await countSessionsPerDay({
      runtimes: [runtime],
      agentPaths: ['/p1', '/p2'],
      days: 7,
      now: NOW.getTime(),
    });

    // index 0 = six days ago, index 6 = today.
    expect(result.dailyCounts).toEqual([1, 0, 0, 0, 0, 0, 2]);
    expect(result.warnings).toEqual([]);
  });

  it('merges across runtimes', async () => {
    const a = runtimeReturning('fake-a', { '/p1': [makeSession('a1', daysBefore(NOW, 1), '/p1')] });
    const b = runtimeReturning('fake-b', { '/p1': [makeSession('b1', daysBefore(NOW, 1), '/p1')] });

    const result = await countSessionsPerDay({
      runtimes: [a, b],
      agentPaths: ['/p1'],
      days: 7,
      now: NOW.getTime(),
    });

    expect(result.dailyCounts[5]).toBe(2);
    expect(result.dailyCounts.reduce((sum, n) => sum + n, 0)).toBe(2);
  });

  it('ignores sessions created before the window and in the future', async () => {
    const runtime = runtimeReturning('fake-a', {
      '/p1': [
        makeSession('old', daysBefore(NOW, 7), '/p1'),
        makeSession('ancient', daysBefore(NOW, 400), '/p1'),
        makeSession('future', daysBefore(NOW, -1), '/p1'),
        makeSession('today', daysBefore(NOW, 0), '/p1'),
      ],
    });

    const result = await countSessionsPerDay({
      runtimes: [runtime],
      agentPaths: ['/p1'],
      days: 7,
      now: NOW.getTime(),
    });

    expect(result.dailyCounts).toEqual([0, 0, 0, 0, 0, 0, 1]);
  });

  it('applies the exact-cwd membership rule, so a foreign session is not counted twice', async () => {
    const runtime = runtimeReturning('fake-a', {
      // A runtime may list sessions belonging to another directory; only the
      // ones whose cwd IS this agent path are that agent's (DOR-203).
      '/p1': [
        makeSession('mine', daysBefore(NOW, 0), '/p1'),
        makeSession('theirs', daysBefore(NOW, 0), '/p2'),
        makeSession('ghost', daysBefore(NOW, 0), undefined),
      ],
    });

    const result = await countSessionsPerDay({
      runtimes: [runtime],
      agentPaths: ['/p1'],
      days: 7,
      now: NOW.getTime(),
    });

    expect(result.dailyCounts.reduce((sum, n) => sum + n, 0)).toBe(1);
  });

  it('degrades per runtime: a failing backend costs a warning, not the count', async () => {
    const good = runtimeReturning('fake-a', {
      '/p1': [makeSession('a1', daysBefore(NOW, 0), '/p1')],
    });
    const bad = new FakeAgentRuntime('fake-b');
    bad.listSessions.mockRejectedValue(new Error('backend down'));

    const result = await countSessionsPerDay({
      runtimes: [good, bad],
      agentPaths: ['/p1', '/p2'],
      days: 7,
      now: NOW.getTime(),
    });

    expect(result.dailyCounts[6]).toBe(1);
    // One warning per failing runtime, not one per agent path scanned.
    expect(result.warnings).toEqual([{ runtime: 'fake-b', message: 'backend down' }]);
  });

  it('answers zeros — not an empty array — when no agent has run anything', async () => {
    const runtime = runtimeReturning('fake-a', {});

    const result = await countSessionsPerDay({
      runtimes: [runtime],
      agentPaths: ['/p1'],
      days: 7,
      now: NOW.getTime(),
    });

    expect(result.dailyCounts).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it('dedupes agent paths so one directory registered twice counts once', async () => {
    const runtime = runtimeReturning('fake-a', {
      '/p1': [makeSession('a1', daysBefore(NOW, 0), '/p1')],
    });

    const result = await countSessionsPerDay({
      runtimes: [runtime],
      agentPaths: ['/p1', '/p1'],
      days: 7,
      now: NOW.getTime(),
    });

    expect(result.dailyCounts[6]).toBe(1);
  });
});
