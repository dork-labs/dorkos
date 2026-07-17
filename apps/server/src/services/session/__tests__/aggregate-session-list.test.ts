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
import { FakeAgentRuntime, createMockSessionWithReading } from '@dorkos/test-utils';
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

  it('carries a context reading only for the runtime that produced one (fleet-context-health)', async () => {
    // Purpose (DOR-113): claude-code emits a best-effort list reading from its
    // tail; codex/opencode closed rows are token-less. The merged list must keep
    // that per-runtime honesty — the client renders "unknown" for the omitted
    // rows, never a fabricated 0%.
    const claude = new FakeAgentRuntime('claude-code');
    const codex = new FakeAgentRuntime('codex');
    const opencode = new FakeAgentRuntime('opencode');
    claude.listSessions.mockResolvedValue([
      createMockSessionWithReading({
        id: 'cc-1',
        updatedAt: '2026-03-01T00:00:00.000Z',
        contextTokens: 150_000,
        lastAutoCompactAt: '2026-03-01T00:00:00.000Z',
      }),
    ]);
    codex.listSessions.mockResolvedValue([
      makeSession({ id: 'cx-1', updatedAt: '2026-02-01T00:00:00.000Z', runtime: 'codex' }),
    ]);
    opencode.listSessions.mockResolvedValue([
      makeSession({ id: 'oc-1', updatedAt: '2026-01-01T00:00:00.000Z', runtime: 'opencode' }),
    ]);

    const { sessions, warnings } = await aggregateSessionList({
      runtimes: [claude, codex, opencode],
      projectDir: '/p',
    });

    expect(warnings).toEqual([]);
    const byId = Object.fromEntries(sessions.map((s) => [s.id, s]));
    expect(byId['cc-1']!.contextTokens).toBe(150_000);
    expect(byId['cc-1']!.lastAutoCompactAt).toBe('2026-03-01T00:00:00.000Z');
    // The token-less runtimes omit the reading entirely.
    expect(byId['cx-1']!.contextTokens).toBeUndefined();
    expect(byId['cx-1']!.lastAutoCompactAt).toBeUndefined();
    expect(byId['oc-1']!.contextTokens).toBeUndefined();
  });

  it('a rejecting runtime degrades to a warning while a reading-bearing runtime still lists (ADR-0310)', async () => {
    // Purpose (DOR-113): a whole-runtime failure never fails the aggregate and
    // never suppresses another runtime's reading — it degrades via warnings[].
    const claude = new FakeAgentRuntime('claude-code');
    const codex = new FakeAgentRuntime('codex');
    claude.listSessions.mockResolvedValue([
      createMockSessionWithReading({ id: 'cc-1', updatedAt: '2026-03-01T00:00:00.000Z' }),
    ]);
    codex.listSessions.mockRejectedValue(new Error('codex offline'));

    const { sessions, warnings } = await aggregateSessionList({
      runtimes: [claude, codex],
      projectDir: '/p',
    });

    expect(sessions.map((s) => s.id)).toEqual(['cc-1']);
    expect(sessions[0]!.contextTokens).toBe(120_000);
    expect(warnings).toEqual([{ runtime: 'codex', message: 'codex offline' }]);
  });
});
