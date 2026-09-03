import type { ContextUsage } from '@dorkos/shared/types';
import type { SessionDiagnostics } from '@/layers/features/status';

/** A warm context breakdown, largest category first once the readout sorts it. */
const SESSION_CONTEXT_USAGE: ContextUsage = {
  totalTokens: 176_000,
  maxTokens: 200_000,
  percentage: 88,
  model: 'claude-opus-4-6',
  categories: [
    { name: 'System prompt', tokens: 11_400, color: '#8b5cf6' },
    { name: 'Messages', tokens: 148_200, color: '#3b82f6' },
    { name: 'Tools', tokens: 16_400, color: '#14b8a6' },
    { name: 'Memory', tokens: 0, color: '#f59e0b' },
  ],
};

/**
 * Three snapshots of one session for the Session-readout showcase: healthy,
 * degraded (the state the surface exists for), and cold.
 *
 * @module dev/mock-samples/session-diagnostics
 */
export const SESSION_DIAGNOSTICS: Record<'healthy' | 'degraded' | 'cold', SessionDiagnostics> = {
  healthy: {
    sessionId: '9f3c1b7a-2e4d-4f18-9c02-7a6b5d3e1f88',
    cwd: '/Users/dev/work/dorkos',
    git: { state: 'repo', branch: 'dor-460-session-tab', dirty: true },
    runtime: 'claude-code',
    model: 'claude-opus-4-6',
    selectedModel: 'default',
    effort: 'high',
    fastMode: false,
    permissionMode: 'plan',
    contextPercent: 88,
    contextUsage: SESSION_CONTEXT_USAGE,
    cache: { readTokens: 142_000, creationTokens: 9_400, contextTokens: 176_000 },
    usage: {
      kind: 'subscription',
      utilization: 0.42,
      windowLabel: '5-hour window',
      resetsAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      state: 'ok',
    },
    connectionState: 'connected',
    streaming: true,
    lifecycle: 'streaming',
    triggerPending: false,
    lastEventSeq: 1_284,
    snapshotCursor: 1_190,
    lastEventAt: Date.now() - 1_200,
    queueDepth: 0,
    subagents: [
      { name: 'researcher', description: 'Reads the codebase before you do', model: 'haiku' },
      { name: 'reviewer', description: 'Checks a diff against the rubric' },
    ],
    activeSubagents: [
      {
        taskId: 'task-1',
        status: 'running',
        description: 'Trace every caller of useSessionStatus',
        toolUses: 7,
        lastToolName: 'Grep',
      },
      // A finished row, because the fold keeps them for the whole turn: the
      // showcase has to show that they land under "Finished this turn" and not
      // under "Running".
      {
        taskId: 'task-0',
        status: 'complete',
        description: 'Read the spec',
        toolUses: 3,
        lastToolName: 'Read',
        summary: 'Summarised §2',
      },
    ],
    runningSubagentCount: 1,
    clientVersion: '0.56.0',
  },
  degraded: {
    sessionId: '9f3c1b7a-2e4d-4f18-9c02-7a6b5d3e1f88',
    cwd: '/Users/dev/work/dorkos',
    git: { state: 'repo', branch: 'dor-460-session-tab', dirty: true },
    runtime: 'codex',
    model: 'gpt-5-codex',
    selectedModel: 'gpt-5-codex',
    effort: 'medium',
    fastMode: true,
    permissionMode: 'bypassPermissions',
    contextPercent: 94,
    contextUsage: SESSION_CONTEXT_USAGE,
    cache: null,
    usage: { kind: 'pay-as-you-go', costUsd: 4.12 },
    connectionState: 'reconnecting',
    streaming: true,
    lifecycle: 'streaming',
    triggerPending: true,
    lastEventSeq: 1_190,
    snapshotCursor: 1_190,
    // Four minutes with nothing applied while the turn claims to be streaming —
    // the exact state this surface exists to make visible.
    lastEventAt: Date.now() - 4 * 60 * 1000,
    queueDepth: 3,
    subagents: [],
    activeSubagents: [
      {
        taskId: 'task-9',
        status: 'running',
        description: 'Rewrite the migration',
        toolUses: 31,
        lastToolName: 'Edit',
      },
    ],
    // Two by the server's count, one by this client's fold — a dropped frame,
    // which on a silent stream is exactly the kind of thing worth seeing.
    runningSubagentCount: 2,
    clientVersion: '0.56.0',
  },
  cold: {
    sessionId: 'c0ld0000-0000-4000-8000-000000000000',
    cwd: null,
    git: { state: 'unknown' },
    runtime: null,
    model: null,
    selectedModel: null,
    effort: null,
    fastMode: false,
    permissionMode: 'default',
    contextPercent: null,
    contextUsage: null,
    cache: null,
    usage: null,
    connectionState: 'connecting',
    streaming: false,
    lifecycle: null,
    triggerPending: false,
    lastEventSeq: 0,
    snapshotCursor: null,
    lastEventAt: null,
    queueDepth: 0,
    subagents: [],
    activeSubagents: [],
    runningSubagentCount: null,
    clientVersion: null,
  },
};
