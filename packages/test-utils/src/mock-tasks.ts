/**
 * Schedule and run fixtures, split out of `mock-factories.ts` to keep that
 * file from growing (DOR-3123).
 *
 * @module test-utils/mock-tasks
 */
import type { Task, TaskRun } from '@dorkos/shared/types';

/** Create a mock Task with sensible defaults. */
export function createMockSchedule(overrides: Partial<Task> = {}): Task {
  return {
    id: 'sched-1',
    name: 'daily-review',
    displayName: 'Daily Review',
    description: 'Review open PRs daily',
    prompt: 'Review open PRs',
    cron: '0 9 * * 1-5',
    enabled: true,
    sticky: false,
    status: 'active',
    agentId: null,
    timezone: null,
    defaultCron: '0 9 * * 1-5',
    defaultTimezone: null,
    timingOverridden: false,
    packageOwned: null,
    approvalChanges: [],
    maxRuntime: null,
    permissionMode: 'acceptEdits',
    runtime: null,
    model: null,
    effort: null,
    account: null,
    filePath: '/tmp/tasks/daily-review/SKILL.md',
    nextRun: new Date(Date.now() + 86400000).toISOString(),
    nextRuns: [],
    reason: null,
    proposedBySessionId: null,
    proposedByAgentPath: null,
    proposedByName: null,
    origin: null,
    reasonSource: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Create a mock TaskRun with sensible defaults. */
export function createMockRun(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: 'run-1',
    scheduleId: 'sched-1',
    sessionId: 'session-1',
    status: 'completed',
    trigger: 'scheduled',
    startedAt: new Date().toISOString(),
    finishedAt: new Date(Date.now() + 60000).toISOString(),
    durationMs: 60000,
    outputSummary: null,
    error: null,
    resolvedRuntime: null,
    resolvedModel: null,
    refusedTools: null,
    outcome: null,
    scheduledFor: null,
    missedTicks: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}
