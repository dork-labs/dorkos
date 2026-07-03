/**
 * Unit tests for the multi-runtime session-list aggregator (ADR-0310).
 *
 * The wire-level behavior (envelope shape, `?runtime=` filter, settings
 * overlay) is covered by the route integration suite in
 * `routes/__tests__/sessions-list-aggregation.test.ts`; this file exercises
 * the merge/sort/tag/degrade logic directly, including the per-runtime
 * timeout with an injectable budget (so no test ever sleeps the real 2s).
 */
import { describe, it, expect } from 'vitest';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { Session } from '@dorkos/shared/types';
import { aggregateSessionList } from '../aggregate-session-list.js';

function makeSession(overrides: Partial<Session> & Pick<Session, 'id' | 'updatedAt'>): Session {
  return {
    title: `Session ${overrides.id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    permissionMode: 'default',
    runtime: 'fake',
    ...overrides,
  };
}

describe('aggregateSessionList', () => {
  it('merges sessions from every runtime, sorted by updatedAt descending', async () => {
    const a = new FakeAgentRuntime('fake-a');
    const b = new FakeAgentRuntime('fake-b');
    a.listSessions.mockResolvedValue([
      makeSession({ id: 'a-old', updatedAt: '2026-01-01T00:00:00.000Z', runtime: 'fake-a' }),
      makeSession({ id: 'a-new', updatedAt: '2026-03-01T00:00:00.000Z', runtime: 'fake-a' }),
    ]);
    b.listSessions.mockResolvedValue([
      makeSession({ id: 'b-mid', updatedAt: '2026-02-01T00:00:00.000Z', runtime: 'fake-b' }),
    ]);

    const { sessions, warnings } = await aggregateSessionList({
      runtimes: [a, b],
      projectDir: '/project',
    });

    expect(sessions.map((s) => s.id)).toEqual(['a-new', 'b-mid', 'a-old']);
    expect(warnings).toEqual([]);
    expect(a.listSessions).toHaveBeenCalledWith('/project');
    expect(b.listSessions).toHaveBeenCalledWith('/project');
  });

  it('defensively fills a missing runtime tag from the owning runtime type', async () => {
    const a = new FakeAgentRuntime('fake-a');
    // Simulate a sloppy adapter that forgot to tag its sessions (task 1.1
    // makes adapters the producers; the aggregator is the backstop).
    const untagged = { ...makeSession({ id: 's1', updatedAt: '2026-01-01T00:00:00.000Z' }) };
    delete (untagged as Partial<Session>).runtime;
    a.listSessions.mockResolvedValue([untagged as Session]);

    const { sessions } = await aggregateSessionList({ runtimes: [a], projectDir: '/p' });

    expect(sessions[0]!.runtime).toBe('fake-a');
  });

  it('preserves an adapter-set runtime tag rather than overwriting it', async () => {
    const a = new FakeAgentRuntime('fake-a');
    a.listSessions.mockResolvedValue([
      makeSession({ id: 's1', updatedAt: '2026-01-01T00:00:00.000Z', runtime: 'fake-a' }),
    ]);

    const { sessions } = await aggregateSessionList({ runtimes: [a], projectDir: '/p' });

    expect(sessions[0]!.runtime).toBe('fake-a');
  });

  it('degrades gracefully: a rejecting runtime yields a warning and partial results', async () => {
    const a = new FakeAgentRuntime('fake-a');
    const b = new FakeAgentRuntime('fake-b');
    a.listSessions.mockResolvedValue([
      makeSession({ id: 'a-1', updatedAt: '2026-01-01T00:00:00.000Z', runtime: 'fake-a' }),
    ]);
    b.listSessions.mockRejectedValue(new Error('backend exploded'));

    const { sessions, warnings } = await aggregateSessionList({
      runtimes: [a, b],
      projectDir: '/p',
    });

    expect(sessions.map((s) => s.id)).toEqual(['a-1']);
    expect(warnings).toEqual([{ runtime: 'fake-b', message: 'backend exploded' }]);
  });

  it('times out a hung runtime and reports it as a warning', async () => {
    const a = new FakeAgentRuntime('fake-a');
    const hung = new FakeAgentRuntime('fake-hung');
    a.listSessions.mockResolvedValue([
      makeSession({ id: 'a-1', updatedAt: '2026-01-01T00:00:00.000Z', runtime: 'fake-a' }),
    ]);
    hung.listSessions.mockImplementation(() => new Promise<Session[]>(() => {}));

    const { sessions, warnings } = await aggregateSessionList({
      runtimes: [a, hung],
      projectDir: '/p',
      timeoutMs: 25,
    });

    expect(sessions.map((s) => s.id)).toEqual(['a-1']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.runtime).toBe('fake-hung');
    expect(warnings[0]!.message).toMatch(/timed out/);
  });

  it('returns empty sessions with no warnings when no runtimes are registered', async () => {
    const result = await aggregateSessionList({ runtimes: [], projectDir: '/p' });
    expect(result).toEqual({ sessions: [], warnings: [] });
  });
});
