import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import type { StreamEvent } from '@dorkos/shared/types';
import {
  getOrCreateProjector,
  disposeProjector,
  rekeyProjector,
  setSessionEventStore,
} from '../../session-state-projector.js';
import { SessionEventStore } from '../../session-event-store.js';
import { toRawSessionEvent } from '../../session-event-normalizer.js';
import { persistenceModeFor } from '../../projector-persistence.js';
import { ApprovalService, hashApprovalInput } from '../../../core/approvals/index.js';
import {
  awaitCapabilityApproval,
  CAPABILITY_APPROVAL_HOLD_CAP_MS,
} from '../../../core/capabilities/capability-approval-hold.js';
import type { CapabilityHoldSession } from '../../../core/capabilities/capability-approval-hold.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  setSessionEventStore(undefined);
});

function fixture(history = false) {
  const dir = mkdtempSync(path.join(tmpdir(), 'capability-record-'));
  const file = path.join(dir, 'events.sqlite');
  let db: Db = createDb(file);
  runMigrations(db);
  let store = new SessionEventStore(db);
  setSessionEventStore(store);
  const id = randomUUID();
  const canonical = randomUUID();
  const projector = getOrCreateProjector(id, dir, {
    persist: persistenceModeFor({ logBackedHistory: history }),
  });
  const approvals = new ApprovalService(db);
  const holds: Array<{ abort: AbortController; wait: Promise<unknown> }> = [];
  const emitted: Array<{ type: string; seq: number }> = [];
  function emit(event: StreamEvent) {
    const raw = toRawSessionEvent(event);
    if (!raw) throw new Error('Expected projectable fixture event');
    const sequenced = projector.ingest(raw);
    emitted.push({ type: sequenced.type, seq: sequenced.seq });
    return sequenced;
  }
  const session: CapabilityHoldSession = {
    eventQueue: [],
    eventQueueNotify() {
      for (const event of session.eventQueue.splice(0)) emit(event);
    },
  };
  function pending() {
    const ticket = approvals.request({
      capabilityId: 'fixture.remove',
      inputHash: hashApprovalInput({ owned: id }),
      summary: 'Remove the owned fixture',
      requestingSession: { sessionId: id, cwd: dir },
    });
    const approval = approvals.getPending(ticket.approvalId);
    if (!approval) throw new Error('Expected real pending approval');
    return { ticket, approval };
  }
  function hold() {
    const { ticket } = pending();
    const abort = new AbortController();
    const wait = awaitCapabilityApproval(
      { approvals, session, signal: abort.signal },
      {
        status: 'approval_required',
        capabilityId: 'fixture.remove',
        capabilityTitle: 'Remove owned fixture',
        tier: 'destructive',
        approvalId: ticket.approvalId,
        approvalToken: ticket.token,
        expiresAt: ticket.expiresAt,
        reason: 'no_approval',
        message: 'Approval required.',
        retry: {
          channel: 'mcp-argument',
          field: 'approvalToken',
          instructions: 'Retry with the token.',
        },
      }
    );
    holds.push({ abort, wait });
    return { ticket, wait };
  }
  cleanups.push(async () => {
    for (const h of holds) h.abort.abort();
    await Promise.all(holds.map((h) => h.wait));
    disposeProjector(id);
    disposeProjector(canonical);
    db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  });
  projector.ingest({ type: 'turn_start' });
  emit({ type: 'text_delta', data: { text: 'private transcript text' } });
  return {
    id,
    canonical,
    projector,
    approvals,
    pending,
    hold,
    emit,
    emitted,
    get store() {
      return store;
    },
    reopen() {
      const previousClient = db.$client;
      db.$client.close();
      db = createDb(file);
      runMigrations(db);
      store = new SessionEventStore(db);
      setSessionEventStore(store);
      return {
        store,
        approvals: new ApprovalService(db),
        previousClient,
        currentClient: db.$client,
      };
    },
  };
}

describe('capability approval record durability', () => {
  it.each(['required', 'resolved'] as const)(
    'persists a real capability %s event eagerly before its turn ends',
    async (kind) => {
      const f = fixture();
      const held = f.hold();
      if (kind === 'resolved') {
        f.approvals.grant(held.ticket.approvalId);
        await expect(held.wait).resolves.toBe('granted');
      }
      const type =
        kind === 'required' ? 'capability_approval_required' : 'capability_approval_resolved';
      const source = f.emitted.filter((e) => e.type === type);
      expect(source).toHaveLength(1);
      const rows = f.store.readAll(f.id).filter((e) => e.type === type);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.seq).toBe(source[0]!.seq);
      expect(f.store.readAll(f.id).some((e) => e.type === 'turn_end')).toBe(false);
      if (kind === 'required')
        expect(rows[0]).toMatchObject({ approval: { approvalId: held.ticket.approvalId } });
      else
        expect(rows[0]).toMatchObject({ approvalId: held.ticket.approvalId, outcome: 'granted' });
    }
  );

  it('keeps an unanswered request across a true database close and reopen without a turn-end flush', () => {
    const f = fixture();
    const { ticket, approval } = f.pending();
    const event = f.emit({
      type: 'capability_approval_required',
      data: { approval, startedAt: Date.now(), capMs: CAPABILITY_APPROVAL_HOLD_CAP_MS },
    });
    expect(f.store.readAll(f.id)).toMatchObject([
      {
        type: 'capability_approval_required',
        seq: event.seq,
        approval: { approvalId: ticket.approvalId },
      },
    ]);
    expect(f.store.readAll(f.id)).toHaveLength(1);
    disposeProjector(f.id); // Retires the in-memory turn; no turn_end is ingested.
    const reopened = f.reopen();
    expect(reopened.previousClient.open).toBe(false);
    expect(reopened.currentClient).not.toBe(reopened.previousClient);
    expect(reopened.approvals.getPending(ticket.approvalId)).toMatchObject({
      approvalId: ticket.approvalId,
    });
    expect(reopened.store.readAll(f.id).map((e) => [e.type, e.seq])).toEqual([
      ['capability_approval_required', event.seq],
    ]);
  });

  it('keeps both eager rows under the canonical rekey and deduplicates the later turn flush across a real database reopen', async () => {
    const f = fixture();
    const held = f.hold();
    expect(f.store.readAll(f.id).map((e) => e.type)).toEqual(['capability_approval_required']);
    rekeyProjector(f.id, f.canonical);
    expect(f.store.readAll(f.id)).toEqual([]);
    f.approvals.grant(held.ticket.approvalId);
    await expect(held.wait).resolves.toBe('granted');
    expect(f.store.readAll(f.canonical).map((e) => [e.type, e.seq])).toEqual([
      ['capability_approval_required', 3],
      ['capability_approval_resolved', 4],
    ]);
    f.projector.ingest({ type: 'turn_end' });
    const expected = [
      ['turn_start', 1],
      ['capability_approval_required', 3],
      ['capability_approval_resolved', 4],
      ['turn_end', 5],
    ];
    expect(f.store.readAll(f.canonical).map((e) => [e.type, e.seq])).toEqual(expected);
    const reopened = f.reopen();
    expect(reopened.previousClient.open).toBe(false);
    expect(reopened.currentClient).not.toBe(reopened.previousClient);
    expect(reopened.store.readAll(f.id)).toEqual([]);
    expect(reopened.store.readAll(f.canonical).map((e) => [e.type, e.seq])).toEqual(expected);
    expect(reopened.store.readAll(f.canonical).some((e) => e.type === 'text_delta')).toBe(false);
  });

  it('preserves ordinary eager approvals while record mode omits transcript text', () => {
    const f = fixture();
    f.emit({
      type: 'approval_required',
      data: {
        toolCallId: 'ordinary',
        toolName: 'Bash',
        input: JSON.stringify({ command: 'owned' }),
        timeoutMs: 60000,
        startedAt: Date.now(),
        hasSuggestions: false,
      },
    });
    expect(f.store.readAll(f.id).map((e) => e.type)).toEqual(['approval_required']);
    f.projector.ingest({ type: 'turn_end' });
    expect(f.store.readAll(f.id).map((e) => e.type)).toEqual([
      'turn_start',
      'approval_required',
      'turn_end',
    ]);
    expect(f.store.readAll(f.id).some((e) => e.type === 'text_delta')).toBe(false);
  });

  it('preserves full history text and boundaries for log-backed runtimes', () => {
    const f = fixture(true);
    expect(f.store.readAll(f.id)).toEqual([]);
    f.projector.ingest({ type: 'turn_end' });
    expect(f.store.readAll(f.id).map((e) => e.type)).toEqual([
      'turn_start',
      'text_delta',
      'turn_end',
    ]);
  });
});
