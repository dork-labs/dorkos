/**
 * The Inbox popover's derivation and the arrival/sound derivation must agree
 * on what is blocking, or the pill can say one thing while the knock says
 * another — the drift spec `schedule-approval-experience` §C4 names.
 *
 * `deriveWaitingItems` (the popover's per-item count) and
 * `deriveAttentionSignals` (the arrival watch's per-session view, filtered to
 * its own three blocking kinds — `use-blocking-arrivals.ts`'s `BLOCKING_KINDS`)
 * read the same raw queues through the same `signal-ids.ts` vocabulary. For a
 * mixed queue where every session carries at most one ask — the case both the
 * popover and the arrival watch render one row per item for — the two must
 * report the exact same set of ids, and the same count.
 *
 * @module entities/attention/__tests__/waiting-queue-agreement
 */
import { describe, it, expect } from 'vitest';
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import type { InteractionPendingEvent } from '@dorkos/shared/interaction-events';
import type { SessionLifecycle } from '@dorkos/shared/session-stream';
import type { PendingInteractionDTO, Session, Task } from '@dorkos/shared/types';
import { deriveAttentionSignals, type AttentionSources } from '../model/derive-attention-signals';
import { deriveWaitingItems } from '../model/derive-waiting-items';

const NOW = new Date('2026-08-19T09:15:00.000Z').getTime();
const MINUTE = 60 * 1000;

/** A session, with everything a case does not care about filled in. */
function session(id: string, cwd: string): Session {
  return {
    id,
    title: 'Ship the parser',
    cwd,
    createdAt: new Date(NOW - 6 * MINUTE).toISOString(),
    updatedAt: new Date(NOW - 2 * MINUTE).toISOString(),
    permissionMode: 'default',
    runtime: 'claude-code',
  };
}

/** One prompt on the fleet-wide stream, for the given session. */
function ask(
  sessionId: string,
  cwd: string,
  interaction: PendingInteractionDTO
): InteractionPendingEvent {
  return { sessionId, cwd, interaction };
}

/** A capability approval waiting on a person. */
function approval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    approvalId: 'apr-1',
    capabilityId: 'files.write',
    capabilityTitle: 'Write a file',
    tier: 'destructive',
    summary: 'Write src/index.ts',
    requestedBy: 'alpha',
    hasAgentPath: true,
    requestedAt: new Date(NOW - 9 * MINUTE).toISOString(),
    expiresAt: new Date(NOW + 60 * MINUTE).toISOString(),
    ...overrides,
  };
}

/** A schedule an agent proposed and parked. */
function schedule(overrides: Partial<Task> = {}): Task {
  return {
    id: 'tsk-1',
    name: 'nightly-audit',
    displayName: 'Nightly audit',
    description: null,
    prompt: 'Audit the config migration.',
    cron: '0 3 * * *',
    timezone: 'UTC',
    agentId: null,
    enabled: false,
    maxRuntime: null,
    permissionMode: 'default',
    status: 'pending_approval',
    filePath: '/tasks/nightly-audit.json',
    createdAt: new Date(NOW - 20 * MINUTE).toISOString(),
    updatedAt: new Date(NOW - 20 * MINUTE).toISOString(),
    ...overrides,
  };
}

/**
 * Reduce a signal list to what an agreement check compares: the ids of every
 * signal that counts as blocking a person — every kind but `error`, which
 * raises no approval, no ask and no schedule and so never reaches
 * {@link deriveWaitingItems} at all.
 *
 * **A hardcoded independent copy of the rule, not a live read of
 * `use-blocking-arrivals.ts`'s `BLOCKING_KINDS`.** That file is not imported
 * here (this suite lives in `entities/`, which may not import a feature), so
 * this is a second, by-hand statement of the same "every kind but error"
 * rule — pinned separately by `use-blocking-arrivals.test.tsx`'s own suite.
 * If the two ever disagreed about which kinds block, THIS test would not
 * catch it; it only catches `deriveWaitingItems` and `deriveAttentionSignals`
 * disagreeing about a kind they both can produce.
 *
 * @param signals - What {@link deriveAttentionSignals} returned.
 */
function blockingIds(signals: ReturnType<typeof deriveAttentionSignals>): Set<string> {
  return new Set(signals.filter((signal) => signal.kind !== 'error').map((signal) => signal.id));
}

describe('the popover and the arrival watch agree on what is blocking', () => {
  it('report the same ids and the same count for a mixed queue', () => {
    const approvals = [
      approval({ approvalId: 'apr-1', requestedBy: 'alpha' }),
      approval({ approvalId: 'apr-2', requestedBy: 'beta' }),
    ];
    const schedules = [
      schedule({ id: 'tsk-1', displayName: 'Nightly audit' }),
      schedule({ id: 'tsk-2', displayName: 'Weekly digest' }),
    ];
    const asks: InteractionPendingEvent[] = [
      ask('ses-1', '/projects/gamma', {
        type: 'question',
        id: 'q-1',
        startedAt: NOW - 4 * MINUTE,
        remainingMs: 6 * MINUTE,
        questions: [],
      }),
      ask('ses-2', '/projects/delta', {
        type: 'approval',
        id: 'tc-1',
        startedAt: NOW - 3 * MINUTE,
        remainingMs: 7 * MINUTE,
        toolName: 'Write',
        input: JSON.stringify({ file_path: '/projects/delta/standup.md' }),
        hasSuggestions: false,
      }),
      ask('ses-3', '/projects/epsilon', {
        type: 'elicitation',
        id: 'e-1',
        startedAt: NOW - 1 * MINUTE,
        remainingMs: 9 * MINUTE,
        serverName: 'linear',
        message: 'Pick a team',
      }),
    ];
    // Each ask's session is blocked, one ask apiece — the granularity where
    // `deriveAttentionSignals`'s per-session collapse is a no-op, so the two
    // derivations describe the identical set of items.
    const sessions: Session[] = [
      session('ses-1', '/projects/gamma'),
      session('ses-2', '/projects/delta'),
      session('ses-3', '/projects/epsilon'),
    ];
    const lifecycles: Readonly<Record<string, SessionLifecycle>> = {
      'ses-1': 'blocked',
      'ses-2': 'blocked',
      'ses-3': 'blocked',
    };

    const waitingItems = deriveWaitingItems({ approvals, asks, schedules });

    const sources: AttentionSources = {
      approvals,
      schedules,
      sessions,
      lifecycles,
      interactions: asks,
      agentNames: {},
    };
    const arrivalSignals = deriveAttentionSignals(sources);

    const waitingIds = new Set(waitingItems.map((item) => item.id));
    const arrivalBlockingIds = blockingIds(arrivalSignals);

    expect(waitingIds).toEqual(arrivalBlockingIds);
    expect(waitingItems).toHaveLength(arrivalBlockingIds.size);
    // The concrete membership, not just the count agreeing by coincidence.
    expect([...waitingIds].sort()).toEqual([
      'approval:apr-1',
      'approval:apr-2',
      'blocked:e-1',
      'blocked:q-1',
      'blocked:tc-1',
      'schedule:tsk-1',
      'schedule:tsk-2',
    ]);
  });

  it('agrees on kind, not only on id — a question is never counted as a permission prompt', () => {
    const asks: InteractionPendingEvent[] = [
      ask('ses-1', '/projects/gamma', {
        type: 'question',
        id: 'q-1',
        startedAt: NOW,
        remainingMs: 6 * MINUTE,
        questions: [],
      }),
    ];
    const sources: AttentionSources = {
      approvals: [],
      schedules: [],
      sessions: [session('ses-1', '/projects/gamma')],
      lifecycles: { 'ses-1': 'blocked' },
      interactions: asks,
      agentNames: {},
    };

    const [waitingItem] = deriveWaitingItems({ approvals: [], asks, schedules: [] });
    const [arrivalSignal] = deriveAttentionSignals(sources);

    expect(waitingItem?.kind).toBe('question');
    expect(waitingItem?.kind).toBe(arrivalSignal?.kind);
  });
});
