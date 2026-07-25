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
    gitBranch: 'main',
    gitDirty: false,
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
    expect(statusRowValue('git', diagnostics({ gitDirty: true }))).toBe('main · changed');
  });

  it('says so plainly when the directory is not a repository', () => {
    expect(statusRowValue('git', diagnostics({ gitBranch: null }))).toBe('No repo');
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
    expect(statusRowValue('sound', diagnostics())).toBeNull();
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
      formatDiagnostics(diagnostics({ cache: null, gitBranch: null, clientVersion: null }))
    );
    expect(parsed.cache).toBeNull();
    expect(parsed.git).toBeNull();
    expect(parsed.clientVersion).toBeNull();
  });
});
