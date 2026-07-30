/**
 * Unit tests for the multi-runtime session-list aggregator (ADR-0310).
 *
 * The wire-level behavior (envelope shape, `?runtime=` filter, settings
 * overlay) is covered by the route integration suite in
 * `routes/__tests__/sessions-list-aggregation.test.ts`; this file exercises
 * the merge/sort/tag/degrade logic directly, including the per-runtime
 * timeout with an injectable budget (so no test ever sleeps the real 2s).
 */
import { describe, it, expect, vi } from 'vitest';
import { FakeAgentRuntime, createMockSessionWithReading } from '@dorkos/test-utils';
import type { Session } from '@dorkos/shared/types';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
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
  it('drops an id the runtime has RETIRED onto a different canonical id', async () => {
    // A resume-as-new leaves the stale transcript on disk, so the adapter still
    // lists it — but every single-session route resolves that id to the
    // successor, so a row claiming to BE it would describe a session the client
    // never gets when it opens that row (DOR-463). Invariant bought here: every
    // id in a listing resolves to itself.
    const runtime = new FakeAgentRuntime('fake');
    runtime.listSessions.mockResolvedValue([
      makeSession({ id: 'retired', updatedAt: '2026-01-02T00:00:00.000Z' }),
      makeSession({ id: 'canonical', updatedAt: '2026-01-01T00:00:00.000Z' }),
    ]);
    runtime.getInternalSessionId.mockImplementation((id: string) =>
      id === 'retired' ? 'canonical' : undefined
    );

    const { sessions } = await aggregateSessionList({ runtimes: [runtime], projectDir: '/p' });

    expect(sessions.map((s) => s.id)).toEqual(['canonical']);
  });

  it('drops a retired id even when its successor is not in this listing', async () => {
    // The successor may belong to another project's list; the row is still a
    // lie about which session it opens, so it does not survive either.
    const runtime = new FakeAgentRuntime('fake');
    runtime.listSessions.mockResolvedValue([
      makeSession({ id: 'retired', updatedAt: '2026-01-02T00:00:00.000Z' }),
      makeSession({ id: 'plain', updatedAt: '2026-01-01T00:00:00.000Z' }),
    ]);
    runtime.getInternalSessionId.mockImplementation((id: string) =>
      id === 'retired' ? 'elsewhere' : undefined
    );

    const { sessions } = await aggregateSessionList({ runtimes: [runtime], projectDir: '/p' });

    expect(sessions.map((s) => s.id)).toEqual(['plain']);
  });

  it('keeps every session when the runtime reports no alias (the ordinary case)', async () => {
    const runtime = new FakeAgentRuntime('fake');
    runtime.listSessions.mockResolvedValue([
      makeSession({ id: 's1', updatedAt: '2026-01-02T00:00:00.000Z' }),
      makeSession({ id: 's2', updatedAt: '2026-01-01T00:00:00.000Z' }),
    ]);
    // Identity mapping must NOT be treated as a retirement.
    runtime.getInternalSessionId.mockImplementation((id: string) => id);

    const { sessions } = await aggregateSessionList({ runtimes: [runtime], projectDir: '/p' });

    expect(sessions.map((s) => s.id)).toEqual(['s1', 's2']);
  });

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

  it('carries a runtime own partial-failure warnings alongside the sessions it did read', async () => {
    // One level below ADR-0310's per-runtime degradation: claude-code reads one
    // store per Claude account, so an unreadable ACCOUNT must cost that account's
    // sessions only. Rejecting would throw away the accounts that read fine;
    // returning a short list silently would look exactly like a complete one.
    const claude = new FakeAgentRuntime('claude-code');
    claude.listSessionsWithWarnings = vi.fn().mockResolvedValue({
      sessions: [makeSession({ id: 'in-account-a', updatedAt: '2026-03-01T00:00:00.000Z' })],
      warnings: [
        { runtime: 'claude-code', message: 'Claude account ~/.claude2 could not be read' },
      ],
    });

    const { sessions, warnings } = await aggregateSessionList({
      runtimes: [claude],
      projectDir: '/p',
    });

    expect(sessions.map((s) => s.id)).toEqual(['in-account-a']);
    expect(warnings).toEqual([
      { runtime: 'claude-code', message: 'Claude account ~/.claude2 could not be read' },
    ]);
    // The envelope form REPLACES the plain listing rather than joining it: two
    // reads of the same directory could disagree, and would double every session.
    expect(claude.listSessions).not.toHaveBeenCalled();
  });

  it('still asks a runtime that does NOT implement the envelope through plain listSessions', async () => {
    // `listSessionsWithWarnings` is optional, and a runtime reading one store has
    // no partial failure to report — a successful listing is complete by
    // construction. Hand-rolled rather than a FakeAgentRuntime, because the fake
    // implements the optional method and the point here is its ABSENCE.
    const singleStore = {
      type: 'codex',
      listSessions: vi
        .fn()
        .mockResolvedValue([makeSession({ id: 'cx-1', updatedAt: '2026-03-01T00:00:00.000Z' })]),
      getInternalSessionId: vi.fn().mockReturnValue(undefined),
    } as unknown as AgentRuntime;

    const { sessions, warnings } = await aggregateSessionList({
      runtimes: [singleStore],
      projectDir: '/p',
    });

    expect(sessions.map((s) => s.id)).toEqual(['cx-1']);
    expect(warnings).toEqual([]);
  });
});
