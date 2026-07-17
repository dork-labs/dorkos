/**
 * Unit tests for the cross-agent recent-sessions fan-out (DOR-329).
 *
 * Built on the aggregate-session-list.test.ts template with `FakeAgentRuntime`:
 * exercises multi-path × multi-runtime fan-out, exact-cwd membership (DOR-203),
 * agentActivity completeness beyond the trim limit, limit/order, path dedupe,
 * warnings aggregation, and bounded-concurrency correctness — all directly on
 * the service, no HTTP layer.
 */
import { describe, it, expect } from 'vitest';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { Session } from '@dorkos/shared/types';
import { listRecentSessions } from '../recent-sessions.js';

function makeSession(
  id: string,
  updatedAt: string,
  cwd: string | undefined,
  runtime = 'fake-a'
): Session {
  return {
    id,
    title: `Session ${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt,
    permissionMode: 'default',
    runtime,
    ...(cwd !== undefined ? { cwd } : {}),
  };
}

/** Build a FakeAgentRuntime whose listSessions returns per-directory sessions. */
function runtimeReturning(type: string, byDir: Record<string, Session[]>): FakeAgentRuntime {
  const runtime = new FakeAgentRuntime(type);
  runtime.listSessions.mockImplementation((dir: string) => Promise.resolve(byDir[dir] ?? []));
  return runtime;
}

describe('listRecentSessions', () => {
  it('fans out across paths and runtimes, merged updatedAt desc', async () => {
    const a = runtimeReturning('fake-a', {
      '/p1': [makeSession('a1', '2026-03-01T00:00:00.000Z', '/p1', 'fake-a')],
    });
    const b = runtimeReturning('fake-b', {
      '/p2': [makeSession('b1', '2026-02-01T00:00:00.000Z', '/p2', 'fake-b')],
    });

    const result = await listRecentSessions({
      runtimes: [a, b],
      agentPaths: ['/p1', '/p2'],
      limit: 10,
    });

    expect(result.sessions.map((s) => s.id)).toEqual(['a1', 'b1']);
    expect(result.agentActivity).toEqual({
      '/p1': '2026-03-01T00:00:00.000Z',
      '/p2': '2026-02-01T00:00:00.000Z',
    });
    expect(result.warnings).toEqual([]);
  });

  it('excludes sessions whose cwd does not exactly match the agent path (DOR-203)', async () => {
    const a = runtimeReturning('fake-a', {
      '/p1': [
        makeSession('member', '2026-03-01T00:00:00.000Z', '/p1'),
        // cwd points at a different directory — a ghost/foreign session.
        makeSession('foreign', '2026-04-01T00:00:00.000Z', '/other'),
        // cwd-less session (DOR-202) — excluded by construction.
        makeSession('ghost', '2026-05-01T00:00:00.000Z', undefined),
      ],
    });

    const result = await listRecentSessions({ runtimes: [a], agentPaths: ['/p1'], limit: 10 });

    expect(result.sessions.map((s) => s.id)).toEqual(['member']);
    // agentActivity reflects only the membered session, not the later foreign/ghost ones.
    expect(result.agentActivity).toEqual({ '/p1': '2026-03-01T00:00:00.000Z' });
  });

  it('computes agentActivity before the trim (complete even beyond the limit)', async () => {
    const a = runtimeReturning('fake-a', {
      '/p1': [makeSession('s1', '2026-01-01T00:00:00.000Z', '/p1')],
      '/p2': [makeSession('s2', '2026-02-01T00:00:00.000Z', '/p2')],
      '/p3': [makeSession('s3', '2026-03-01T00:00:00.000Z', '/p3')],
    });

    const result = await listRecentSessions({
      runtimes: [a],
      agentPaths: ['/p1', '/p2', '/p3'],
      limit: 1,
    });

    // Only the single most-recent session survives the trim...
    expect(result.sessions.map((s) => s.id)).toEqual(['s3']);
    // ...but every agent with a session appears in the activity map.
    expect(result.agentActivity).toEqual({
      '/p1': '2026-01-01T00:00:00.000Z',
      '/p2': '2026-02-01T00:00:00.000Z',
      '/p3': '2026-03-01T00:00:00.000Z',
    });
  });

  it('uses the latest session per agent for agentActivity', async () => {
    const a = runtimeReturning('fake-a', {
      '/p1': [
        makeSession('old', '2026-01-01T00:00:00.000Z', '/p1'),
        makeSession('new', '2026-06-01T00:00:00.000Z', '/p1'),
      ],
    });

    const result = await listRecentSessions({ runtimes: [a], agentPaths: ['/p1'], limit: 10 });

    expect(result.agentActivity['/p1']).toBe('2026-06-01T00:00:00.000Z');
  });

  it('sorts merged sessions updatedAt desc and slices to limit', async () => {
    const a = runtimeReturning('fake-a', {
      '/p1': [
        makeSession('mid', '2026-02-01T00:00:00.000Z', '/p1'),
        makeSession('new', '2026-03-01T00:00:00.000Z', '/p1'),
      ],
      '/p2': [makeSession('old', '2026-01-01T00:00:00.000Z', '/p2')],
    });

    const result = await listRecentSessions({
      runtimes: [a],
      agentPaths: ['/p1', '/p2'],
      limit: 2,
    });

    expect(result.sessions.map((s) => s.id)).toEqual(['new', 'mid']);
  });

  it('dedupes the incoming agent paths', async () => {
    const a = runtimeReturning('fake-a', {
      '/p1': [makeSession('s1', '2026-01-01T00:00:00.000Z', '/p1')],
    });

    const result = await listRecentSessions({
      runtimes: [a],
      agentPaths: ['/p1', '/p1', '/p1'],
      limit: 10,
    });

    expect(result.sessions.map((s) => s.id)).toEqual(['s1']);
    // The duplicated path is scanned exactly once.
    expect(a.listSessions).toHaveBeenCalledTimes(1);
    expect(a.listSessions).toHaveBeenCalledWith('/p1');
  });

  it('aggregates and dedupes per-runtime warnings across the fan-out', async () => {
    const a = runtimeReturning('fake-a', {
      '/p1': [makeSession('a1', '2026-01-01T00:00:00.000Z', '/p1')],
      '/p2': [makeSession('a2', '2026-02-01T00:00:00.000Z', '/p2')],
    });
    const down = new FakeAgentRuntime('fake-down');
    down.listSessions.mockRejectedValue(new Error('backend down'));

    const result = await listRecentSessions({
      runtimes: [a, down],
      agentPaths: ['/p1', '/p2'],
      limit: 10,
    });

    // Partial results from the healthy runtime still come back...
    expect(result.sessions.map((s) => s.id)).toEqual(['a2', 'a1']);
    // ...and the down runtime is reported ONCE, not once per scanned path.
    expect(result.warnings).toEqual([{ runtime: 'fake-down', message: 'backend down' }]);
  });

  it('handles more paths than the concurrency width without dropping or duplicating', async () => {
    const paths = Array.from({ length: 12 }, (_, i) => `/p${String(i).padStart(2, '0')}`);
    const byDir: Record<string, Session[]> = {};
    for (const [i, p] of paths.entries()) {
      const ts = new Date(Date.UTC(2026, 0, i + 1)).toISOString();
      byDir[p] = [makeSession(`s-${i}`, ts, p)];
    }
    const a = runtimeReturning('fake-a', byDir);

    const result = await listRecentSessions({ runtimes: [a], agentPaths: paths, limit: 50 });

    expect(result.sessions).toHaveLength(12);
    const ids = result.sessions.map((s) => s.id).sort();
    expect(new Set(ids).size).toBe(12);
    expect(Object.keys(result.agentActivity).sort()).toEqual([...paths].sort());
  });

  it('returns an empty envelope when there are no agent paths', async () => {
    const a = runtimeReturning('fake-a', {});
    const result = await listRecentSessions({ runtimes: [a], agentPaths: [], limit: 10 });
    expect(result).toEqual({ sessions: [], agentActivity: {}, warnings: [] });
  });
});
