import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import type { HistoryMessage } from '@dorkos/shared/types';
import {
  SessionEventStore,
  setSessionEventStore,
  getOrCreateProjector,
  disposeProjector,
  overlayApprovalReceipts,
  expireOrphanedAsks,
} from '../index.js';
import type { RawSessionEvent } from '../session-state-projector.js';

/**
 * A parked Ask across a server restart (DOR-1439).
 *
 * The restart is simulated the way `session-durable-restart.test.ts` does it —
 * drop the live projector, build a NEW store over the SAME SQLite handle — which
 * is exactly what a real restart leaves behind: the same database, and no
 * in-memory anything. The turn itself is unrecoverable by construction (the
 * runtime process died with the server), so what is asserted is the honest
 * remainder: the ask exists on disk while it is parked, and the next boot closes
 * it out as unanswered instead of letting it vanish.
 */

let seq = 0;
function nextId(): string {
  seq += 1;
  return `parked-ask-restart-${seq}`;
}

const CWD = '/projects/parked-ask';

/** Open a turn and park it on an approval, WITHOUT ever ending the turn. */
function parkOnApproval(sessionId: string, toolCallId: string, startedAt: number): void {
  const projector = getOrCreateProjector(sessionId, CWD, { persist: 'record' });
  projector.ingest({ type: 'turn_start', userMessage: 'do the thing' } as RawSessionEvent);
  projector.ingest({
    type: 'approval_required',
    id: toolCallId,
    startedAt,
    remainingMs: 600_000,
    toolName: 'Bash',
    input: '{}',
    hasSuggestions: false,
  } as RawSessionEvent);
}

/** One assistant message carrying the gated tool call, as history renders it. */
function historyWith(toolCallId: string): HistoryMessage[] {
  return [
    {
      id: 'assistant-1',
      role: 'assistant',
      content: '',
      toolCalls: [{ toolCallId, toolName: 'Bash', status: 'complete' }],
    },
  ];
}

describe('a parked Ask across a server restart (DOR-1439)', () => {
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
    setSessionEventStore(new SessionEventStore(db));
  });
  afterEach(() => {
    setSessionEventStore(undefined);
  });

  it('writes a parked ask to disk before its turn ends', () => {
    const id = nextId();
    parkOnApproval(id, 'tc-parked', 1_700_000_000_000);

    // The turn is still open — the whole point — so nothing has been flushed by
    // the turn-granular path. The ask is durable anyway.
    const open = new SessionEventStore(db).readUnresolvedInteractions();
    expect(open).toEqual([
      { sessionId: id, id: 'tc-parked', kind: 'approval', startedAt: 1_700_000_000_000 },
    ]);
    disposeProjector(id);
  });

  it('the reopened conversation says nobody answered, instead of showing nothing', () => {
    const id = nextId();
    parkOnApproval(id, 'tc-orphan', 1_700_000_000_000);

    // Restart: the projector is gone and a fresh store opens the same database.
    disposeProjector(id);
    const revived = new SessionEventStore(db);
    setSessionEventStore(revived);
    expect(expireOrphanedAsks(revived, 1_700_000_060_000)).toBe(1);

    const [message] = overlayApprovalReceipts(id, historyWith('tc-orphan'));
    expect(message?.toolCalls?.[0]?.approvalOutcome).toBe('expired');
    expect(message?.toolCalls?.[0]?.approvalResolvedAt).toBe(1_700_000_060_000);
    expect(message?.toolCalls?.[0]?.approvalStartedAt).toBe(1_700_000_000_000);
  });

  it('closes a parked question as a question, not as a refused permission', () => {
    const id = nextId();
    const projector = getOrCreateProjector(id, CWD, { persist: 'record' });
    projector.ingest({ type: 'turn_start', userMessage: 'pick one' } as RawSessionEvent);
    projector.ingest({
      type: 'question_prompt',
      id: 'tc-question',
      startedAt: 1_700_000_000_000,
      remainingMs: 600_000,
      questions: [{ question: 'Which sort?', header: 'Sort', options: [] }],
    } as unknown as RawSessionEvent);
    disposeProjector(id);

    const revived = new SessionEventStore(db);
    setSessionEventStore(revived);
    expireOrphanedAsks(revived, 1_700_000_060_000);

    const [message] = overlayApprovalReceipts(id, historyWith('tc-question'));
    expect(message?.toolCalls?.[0]?.questionOutcome).toBe('expired');
    // The kinds share the `expired` resolution, so a question that came back as
    // a denied permission prompt would be this assertion going red.
    expect(message?.toolCalls?.[0]?.approvalOutcome).toBeUndefined();
  });

  it('never re-closes an ask that was answered before the restart', () => {
    const id = nextId();
    parkOnApproval(id, 'tc-answered', 1_700_000_000_000);
    // Answered, and then the process dies mid-turn — still no `turn_end`.
    getOrCreateProjector(id, CWD).resolveInteraction('tc-answered', 'approved');
    disposeProjector(id);

    const revived = new SessionEventStore(db);
    setSessionEventStore(revived);
    expect(expireOrphanedAsks(revived, 1_700_000_060_000)).toBe(0);

    const [message] = overlayApprovalReceipts(id, historyWith('tc-answered'));
    expect(message?.toolCalls?.[0]?.approvalOutcome).toBe('allowed');
  });

  it('one session answering does not close another session ask with the same id', () => {
    // The PARKED session takes the lower id on purpose: rows are collected in
    // session-id order, so this is the ordering in which an ask keyed by the
    // interaction alone would be closed by the other session's answer.
    const parked = nextId();
    const answered = nextId();
    parkOnApproval(parked, 'tc-shared', 1_700_000_000_000);
    parkOnApproval(answered, 'tc-shared', 1_700_000_000_000);
    getOrCreateProjector(answered, CWD).resolveInteraction('tc-shared', 'approved');
    disposeProjector(answered);
    disposeProjector(parked);

    const revived = new SessionEventStore(db);
    setSessionEventStore(revived);
    expect(expireOrphanedAsks(revived, 1_700_000_060_000)).toBe(1);

    expect(
      overlayApprovalReceipts(parked, historyWith('tc-shared'))[0]?.toolCalls?.[0]?.approvalOutcome
    ).toBe('expired');
    expect(
      overlayApprovalReceipts(answered, historyWith('tc-shared'))[0]?.toolCalls?.[0]
        ?.approvalOutcome
    ).toBe('allowed');
  });

  it('is idempotent — a second boot finds nothing left to close', () => {
    const id = nextId();
    parkOnApproval(id, 'tc-twice', 1_700_000_000_000);
    disposeProjector(id);

    const revived = new SessionEventStore(db);
    setSessionEventStore(revived);
    expect(expireOrphanedAsks(revived, 1_700_000_060_000)).toBe(1);
    expect(expireOrphanedAsks(new SessionEventStore(db), 1_700_000_120_000)).toBe(0);

    // …and the first answer is the one that stands.
    const [message] = overlayApprovalReceipts(id, historyWith('tc-twice'));
    expect(message?.toolCalls?.[0]?.approvalResolvedAt).toBe(1_700_000_060_000);
  });

  it('leaves the next turn a seq to use that the sweep has not taken', () => {
    const id = nextId();
    parkOnApproval(id, 'tc-seq', 1_700_000_000_000);
    disposeProjector(id);

    const revived = new SessionEventStore(db);
    setSessionEventStore(revived);
    expireOrphanedAsks(revived, 1_700_000_060_000);
    const sweptTo = revived.maxSeq(id);

    // The session is reopened and runs another turn: its rows must land ABOVE
    // the sweep's, or `INSERT OR IGNORE` would silently drop every one of them.
    const projector = getOrCreateProjector(id, CWD, { persist: 'record' });
    const started = projector.ingest({
      type: 'turn_start',
      userMessage: 'asking again',
    } as RawSessionEvent);
    expect(started.seq).toBeGreaterThan(sweptTo);
    disposeProjector(id);
  });
});
