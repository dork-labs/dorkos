/**
 * One fully-populated {@link SessionDiagnostics} for the Session surfaces' tests.
 *
 * Shared so the panel, the readout, and the serializer are all asserted against
 * the same shape — adding a field to the contract then breaks in one place, not
 * four.
 *
 * @module features/status/__tests__/session-diagnostics-fixture
 */
import type { SessionDiagnostics } from '../model/session-diagnostics';

/**
 * A healthy-but-busy session: dirty worktree, 88% context, plan mode, two queued
 * messages.
 *
 * @param overrides - Fields to replace on the base snapshot.
 */
export function makeDiagnostics(overrides: Partial<SessionDiagnostics> = {}): SessionDiagnostics {
  return {
    sessionId: 'session-42',
    cwd: '/Users/dev/work/dorkos',
    git: { state: 'repo', branch: 'dor-452', dirty: true },
    runtime: 'claude-code',
    model: 'claude-opus-4-6',
    selectedModel: 'default',
    effort: 'high',
    fastMode: false,
    permissionMode: 'plan',
    contextPercent: 88,
    contextUsage: null,
    cache: { readTokens: 3, creationTokens: 1 },
    usage: { kind: 'pay-as-you-go', costUsd: 0.35 },
    connectionState: 'connected',
    streaming: false,
    lifecycle: 'idle',
    triggerPending: false,
    lastEventSeq: 412,
    snapshotCursor: 400,
    lastEventAt: null,
    queueDepth: 2,
    subagents: [],
    activeSubagents: [],
    runningSubagentCount: 0,
    clientVersion: '1.4.0',
    ...overrides,
  };
}
