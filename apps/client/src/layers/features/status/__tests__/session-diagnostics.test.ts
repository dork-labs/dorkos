import { describe, it, expect } from 'vitest';
import {
  cacheHitPercent,
  formatDiagnostics,
  statusRowValue,
  type SessionDiagnostics,
} from '../model/session-diagnostics';
import { makeDiagnostics } from './session-diagnostics-fixture';

/** A fully-populated session snapshot, on a clean default branch. */
function diagnostics(overrides: Partial<SessionDiagnostics> = {}): SessionDiagnostics {
  return makeDiagnostics({
    sessionId: 'session-1',
    git: { state: 'repo', branch: 'main', dirty: false },
    contextPercent: 78,
    cache: { readTokens: 9_000, creationTokens: 1_000, contextTokens: 12_000 },
    ...overrides,
  });
}

describe('cacheHitPercent', () => {
  it('divides cache reads by the full request input', () => {
    expect(
      cacheHitPercent({ readTokens: 9_000, creationTokens: 1_000, contextTokens: 12_000 })
    ).toBe(75);
  });

  it('falls back to the two cache figures when the request input is unknown', () => {
    expect(cacheHitPercent({ readTokens: 3, creationTokens: 1 })).toBe(75);
  });

  it('reports zero rather than dividing by zero', () => {
    expect(cacheHitPercent({ readTokens: 0, creationTokens: 0 })).toBe(0);
  });
});

describe('statusRowValue', () => {
  it('shows only the leaf folder for the directory', () => {
    expect(statusRowValue('cwd', diagnostics())).toBe('dorkos');
  });

  it('flags a dirty working tree beside the branch', () => {
    const d = diagnostics({ git: { state: 'repo', branch: 'main', dirty: true } });
    expect(statusRowValue('git', d)).toBe('main · changed');
  });

  it('says so plainly when the directory is not a repository', () => {
    expect(statusRowValue('git', diagnostics({ git: { state: 'no-repo' } }))).toBe('No repo');
  });

  it('claims nothing at all while the git query has not answered', () => {
    // The one wrong answer here is "No repo": it is a positive claim about a
    // directory that may well be a checkout, asserted only because a request is
    // still in flight.
    expect(statusRowValue('git', diagnostics({ git: { state: 'unknown' } }))).toBeNull();
  });

  it('reports context as a fullness, not a bare number', () => {
    expect(statusRowValue('context', diagnostics())).toBe('78% full');
  });

  it('reports the cache as a share of the request', () => {
    expect(statusRowValue('cache', diagnostics())).toBe('75% from cache');
  });

  it('reports pay-as-you-go usage as a dollar figure', () => {
    expect(statusRowValue('usage', diagnostics())).toBe('$0.35');
  });

  it('reports subscription usage against its window', () => {
    const d = diagnostics({
      usage: { kind: 'subscription', utilization: 0.42, windowLabel: '5-hour window' },
    });
    expect(statusRowValue('usage', d)).toBe('42% of 5-hour window');
  });

  it('pairs the connection state with how far this client has caught up', () => {
    expect(statusRowValue('connection', diagnostics())).toBe('connected · event 412');
  });

  it('returns null for values that have not arrived', () => {
    expect(statusRowValue('context', diagnostics({ contextPercent: null }))).toBeNull();
    expect(statusRowValue('cache', diagnostics({ cache: null }))).toBeNull();
    expect(statusRowValue('usage', diagnostics({ usage: null }))).toBeNull();
    expect(statusRowValue('cwd', diagnostics({ cwd: null }))).toBeNull();
  });

  it('has nothing to say about rows with no live value', () => {
    expect(statusRowValue('agent', diagnostics())).toBeNull();
    expect(statusRowValue('plan', diagnostics())).toBeNull();
  });
});

describe('formatDiagnostics', () => {
  it('produces readable JSON carrying every field a bug report needs', () => {
    const parsed: Record<string, unknown> = JSON.parse(formatDiagnostics(diagnostics()));
    expect(parsed).toMatchObject({
      sessionId: 'session-1',
      cwd: '/Users/dev/work/dorkos',
      git: { branch: 'main', dirty: false },
      runtime: 'claude-code',
      model: 'claude-opus-4-6',
      effort: 'high',
      permissionMode: 'plan',
      contextPercent: 78,
      cache: { readTokens: 9_000, creationTokens: 1_000, contextTokens: 12_000, hitPercent: 75 },
      usage: { kind: 'pay-as-you-go', costUsd: 0.35 },
      connectionState: 'connected',
      lastEventSeq: 412,
      queueDepth: 2,
      clientVersion: '1.4.0',
    });
    expect(typeof parsed.capturedAt).toBe('string');
  });

  it('is indented so it reads as-is when pasted', () => {
    expect(formatDiagnostics(diagnostics())).toContain('\n  "sessionId"');
  });

  it('reports absent values as null rather than omitting them', () => {
    const parsed: Record<string, unknown> = JSON.parse(
      formatDiagnostics(diagnostics({ cache: null, clientVersion: null }))
    );
    expect(parsed.cache).toBeNull();
    expect(parsed.clientVersion).toBeNull();
  });

  it('carries the repository state as its own discriminated value', () => {
    // "not asked yet" and "not a repository" are different bug reports, so the
    // blob has to be able to say which one it was.
    const unknown: Record<string, unknown> = JSON.parse(
      formatDiagnostics(diagnostics({ git: { state: 'unknown' } }))
    );
    expect(unknown.git).toEqual({ state: 'unknown' });

    const noRepo: Record<string, unknown> = JSON.parse(
      formatDiagnostics(diagnostics({ git: { state: 'no-repo' } }))
    );
    expect(noRepo.git).toEqual({ state: 'no-repo' });
  });

  it('carries the server subagent count beside this client’s fold', () => {
    // A disagreement between the two is the signal, so a blob that dropped either
    // one would hide it.
    const parsed: Record<string, unknown> = JSON.parse(
      formatDiagnostics(
        diagnostics({
          activeSubagents: [{ taskId: 't1', status: 'running' }],
          runningSubagentCount: 2,
        })
      )
    );
    expect(parsed.activeSubagents).toEqual([{ taskId: 't1', status: 'running' }]);
    expect(parsed.runningSubagentCount).toBe(2);
  });
});
