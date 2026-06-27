import { describe, it, expect } from 'vitest';
import { RecoverySchema } from '../config-schema.js';
import {
  recoverOrphan,
  RECOVERY_BLOCKED_LABEL,
  type FlowRun,
  type RecoveryConfig,
  type RecoveryContext,
} from '../flow-run.js';

/** The §9 / §12 resolved default recovery config — the oracle the spec ships. */
const DEFAULT_RECOVERY: RecoveryConfig = RecoverySchema.parse({});

/** A durable run record with a usable checkpoint, overridable per-test. */
function flowRun(overrides: Partial<FlowRun> = {}): FlowRun {
  return {
    issueId: 'issue-node-id',
    identifier: 'DOR-123',
    sessionId: 'session-abc',
    worktreePath: '/Users/x/.dork/workspaces/core/DOR-123',
    branch: 'dork/DOR-123',
    stage: 'execute',
    status: 'running',
    attemptCount: 0,
    workerPid: 4242,
    startedAt: '2026-06-14T00:00:00.000Z',
    ...overrides,
  };
}

/** A probe context where the checkpoint (git commit + JSONL session) survives. */
function intactContext(overrides: Partial<RecoveryContext> = {}): RecoveryContext {
  return { worktreeExists: true, sessionLogIntact: true, ...overrides };
}

describe('recoverOrphan — the next-tick recovery ladder (§12)', () => {
  describe('needs-input — parked on a human is NEVER reclaimed', () => {
    it('skips a needs-input item regardless of checkpoint state', () => {
      const action = recoverOrphan('needs-input', flowRun(), intactContext(), DEFAULT_RECOVERY);
      expect(action).toEqual({ kind: 'skip', reason: 'parked-on-human' });
    });

    it('skips even when retries are exhausted (never escalates a parked item)', () => {
      const exhausted = flowRun({ attemptCount: DEFAULT_RECOVERY.maxRetries });
      const action = recoverOrphan('needs-input', exhausted, intactContext(), DEFAULT_RECOVERY);
      expect(action.kind).toBe('skip');
    });

    it('does NOT increment attemptCount when skipping', () => {
      const run = flowRun({ attemptCount: 1 });
      recoverOrphan('needs-input', run, intactContext(), DEFAULT_RECOVERY);
      // The pure ladder never mutates the run; skip carries no attemptCount.
      expect(run.attemptCount).toBe(1);
      const action = recoverOrphan('needs-input', run, intactContext(), DEFAULT_RECOVERY);
      expect(action).not.toHaveProperty('attemptCount');
    });
  });

  describe('claimed-no-worker — adopt + resume when the checkpoint survives', () => {
    it('resumes (re-attach + session resume) when worktree exists AND session log intact', () => {
      const action = recoverOrphan(
        'claimed-no-worker',
        flowRun({ attemptCount: 0 }),
        intactContext(),
        DEFAULT_RECOVERY
      );
      expect(action).toEqual({ kind: 'resume', attemptCount: 1 });
    });

    it('increments attemptCount on each reclaim', () => {
      const first = recoverOrphan(
        'claimed-no-worker',
        flowRun({ attemptCount: 0 }),
        intactContext(),
        DEFAULT_RECOVERY
      );
      expect(first.kind === 'resume' && first.attemptCount).toBe(1);

      const second = recoverOrphan(
        'claimed-no-worker',
        flowRun({ attemptCount: 1 }),
        intactContext(),
        DEFAULT_RECOVERY
      );
      expect(second.kind === 'resume' && second.attemptCount).toBe(2);
    });
  });

  describe('claimed-no-worker — restart-clean when the checkpoint is gone', () => {
    it('restart-cleans (no-worktree) when the worktree is missing', () => {
      const action = recoverOrphan(
        'claimed-no-worker',
        flowRun({ attemptCount: 0 }),
        intactContext({ worktreeExists: false }),
        DEFAULT_RECOVERY
      );
      expect(action).toEqual({ kind: 'restart-clean', reason: 'no-worktree', attemptCount: 1 });
    });

    it('restart-cleans (session-log-corrupt) when the session log is broken but the worktree exists', () => {
      const action = recoverOrphan(
        'claimed-no-worker',
        flowRun({ attemptCount: 0 }),
        intactContext({ sessionLogIntact: false }),
        DEFAULT_RECOVERY
      );
      expect(action).toEqual({
        kind: 'restart-clean',
        reason: 'session-log-corrupt',
        attemptCount: 1,
      });
    });

    it('still increments attemptCount on a restart-clean reclaim', () => {
      const action = recoverOrphan(
        'claimed-no-worker',
        flowRun({ attemptCount: 1 }),
        intactContext({ worktreeExists: false }),
        DEFAULT_RECOVERY
      );
      expect(action.kind === 'restart-clean' && action.attemptCount).toBe(2);
    });
  });

  describe('over maxRetries — escalate to agent/blocked', () => {
    it('escalates when attemptCount has reached maxRetries (no reclaim left)', () => {
      const exhausted = flowRun({ attemptCount: DEFAULT_RECOVERY.maxRetries });
      const action = recoverOrphan(
        'claimed-no-worker',
        exhausted,
        intactContext(),
        DEFAULT_RECOVERY
      );
      expect(action.kind).toBe('escalate');
      expect(action.kind === 'escalate' && action.label).toBe(RECOVERY_BLOCKED_LABEL);
      expect(action.kind === 'escalate' && action.label).toBe('agent/blocked');
    });

    it('escalates when attemptCount exceeds maxRetries', () => {
      const over = flowRun({ attemptCount: DEFAULT_RECOVERY.maxRetries + 5 });
      const action = recoverOrphan('claimed-no-worker', over, intactContext(), DEFAULT_RECOVERY);
      expect(action.kind).toBe('escalate');
    });

    it('does not escalate while one attempt remains (maxRetries - 1 still resumes)', () => {
      const lastAttempt = flowRun({ attemptCount: DEFAULT_RECOVERY.maxRetries - 1 });
      const action = recoverOrphan(
        'claimed-no-worker',
        lastAttempt,
        intactContext(),
        DEFAULT_RECOVERY
      );
      expect(action.kind).toBe('resume');
      expect(action.kind === 'resume' && action.attemptCount).toBe(DEFAULT_RECOVERY.maxRetries);
    });

    it('carries a human-readable reason for the escalation comment', () => {
      const exhausted = flowRun({ attemptCount: DEFAULT_RECOVERY.maxRetries });
      const action = recoverOrphan(
        'claimed-no-worker',
        exhausted,
        intactContext(),
        DEFAULT_RECOVERY
      );
      expect(action.kind === 'escalate' && action.reason).toMatch(/exhausted/i);
    });
  });

  describe('no-local-record — re-derive from tracker + workspace (tracker-as-truth)', () => {
    it('re-derives when there is no local run record (claimed on another machine)', () => {
      const action = recoverOrphan('no-local-record', null, intactContext(), DEFAULT_RECOVERY);
      expect(action).toEqual({ kind: 're-derive', reason: 'no-local-record' });
    });

    it('re-derives even when a stale run object is passed (signal wins, no reclaim of a foreign run)', () => {
      const action = recoverOrphan('no-local-record', flowRun(), intactContext(), DEFAULT_RECOVERY);
      expect(action.kind).toBe('re-derive');
    });
  });

  describe('input invariants', () => {
    it('throws when claimed-no-worker is given without a local run record', () => {
      expect(() =>
        recoverOrphan('claimed-no-worker', null, intactContext(), DEFAULT_RECOVERY)
      ).toThrow(/requires a local FlowRun/);
    });

    it('honors a custom maxRetries from config', () => {
      const strict: RecoveryConfig = RecoverySchema.parse({ maxRetries: 0 });
      // With maxRetries 0, a fresh (attemptCount 0) claimed orphan escalates immediately.
      const action = recoverOrphan(
        'claimed-no-worker',
        flowRun({ attemptCount: 0 }),
        intactContext(),
        strict
      );
      expect(action.kind).toBe('escalate');
    });
  });
});
