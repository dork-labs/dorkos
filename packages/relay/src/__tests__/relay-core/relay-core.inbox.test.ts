import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { RelayCore } from '../../relay-core.js';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import { makeTmpDir, useRelayCore } from './relay-core.fixtures.js';

const h = useRelayCore();

// ---------------------------------------------------------------------------
// Restart recovery — regression for C1 (persisted noop subscriptions)
// ---------------------------------------------------------------------------

describe('restart recovery', () => {
  it('ignores a legacy subscriptions.json — messages published after restart are not destroyed', async () => {
    // Simulate the pre-fix state: a previous process persisted subscription
    // patterns to subscriptions.json before crashing. Those patterns used to
    // be restored with noop handlers that claimed and deleted every message.
    const legacyDir = await makeTmpDir('relay-legacy-subs-');
    fsSync.writeFileSync(
      path.join(legacyDir, 'subscriptions.json'),
      JSON.stringify([
        {
          id: '01LEGACY00000000000000000',
          pattern: 'relay.inbox.crashed-caller',
          createdAt: new Date().toISOString(),
        },
      ]),
      'utf-8'
    );

    const restarted = new RelayCore({ dataDir: legacyDir });
    try {
      await restarted.registerEndpoint('relay.inbox.crashed-caller');

      await restarted.publish(
        'relay.inbox.crashed-caller',
        { type: 'agent_result', text: 'late reply', done: true },
        { from: 'relay.agent.responder' }
      );

      // No phantom subscriber claimed the message — it stays unread and
      // pollable with its payload intact.
      const inbox = await restarted.readInbox('relay.inbox.crashed-caller', { status: 'unread' });
      expect(inbox.messages).toHaveLength(1);
      expect(inbox.messages[0].payload).toEqual({
        type: 'agent_result',
        text: 'late reply',
        done: true,
      });
    } finally {
      await restarted.close();
      await fs.rm(legacyDir, { recursive: true, force: true });
    }
  });

  it('a legacy persisted pattern does not count as a subscriber — late real subscribers still receive the message', async () => {
    const legacyDir = await makeTmpDir('relay-legacy-subs2-');
    fsSync.writeFileSync(
      path.join(legacyDir, 'subscriptions.json'),
      JSON.stringify([
        {
          id: '01LEGACY00000000000000000',
          pattern: 'relay.human.console.>',
          createdAt: new Date().toISOString(),
        },
      ]),
      'utf-8'
    );

    const restarted = new RelayCore({ dataDir: legacyDir });
    try {
      // Pre-fix: the restored noop pattern matched, deliveredTo became 1, and
      // the message skipped the pending buffer — lost forever.
      const result = await restarted.publish(
        'relay.human.console.client-1',
        { text: 'hello human' },
        { from: 'relay.agent.responder' }
      );
      expect(result.deliveredTo).toBe(0);

      // Post-fix: the message sits in the pending buffer and a real
      // subscriber registered later still receives it.
      const received: RelayEnvelope[] = [];
      restarted.subscribe('relay.human.console.client-1', (envelope) => {
        received.push(envelope);
      });

      await vi.waitFor(() => {
        expect(received).toHaveLength(1);
      });
      expect(received[0].payload).toEqual({ text: 'hello human' });
    } finally {
      await restarted.close();
      await fs.rm(legacyDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Inbox reads — regression for C2 (payloads + ack)
// ---------------------------------------------------------------------------

describe('readInbox payloads and ack', () => {
  it('returns envelope payloads for unread messages', async () => {
    await h.relay.registerEndpoint('relay.inbox.reader');
    await h.relay.publish(
      'relay.inbox.reader',
      { type: 'progress', step: 1, step_type: 'message', text: 'working', done: false },
      { from: 'relay.agent.responder' }
    );

    const inbox = await h.relay.readInbox('relay.inbox.reader', { status: 'unread' });
    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0].status).toBe('pending');
    expect(inbox.messages[0].payload).toEqual({
      type: 'progress',
      step: 1,
      step_type: 'message',
      text: 'working',
      done: false,
    });
    expect(inbox.messages[0].sender).toBe('relay.agent.responder');
  });

  it('ack transitions unread messages to read so polls stop returning them', async () => {
    await h.relay.registerEndpoint('relay.inbox.acker');
    await h.relay.publish('relay.inbox.acker', { text: 'one' }, { from: 'relay.agent.responder' });
    await h.relay.publish('relay.inbox.acker', { text: 'two' }, { from: 'relay.agent.responder' });

    const first = await h.relay.readInbox('relay.inbox.acker', { status: 'unread', ack: true });
    expect(first.messages).toHaveLength(2);
    expect(first.messages.map((m) => m.payload)).toEqual(
      expect.arrayContaining([{ text: 'one' }, { text: 'two' }])
    );

    // Acked messages no longer appear as unread…
    const second = await h.relay.readInbox('relay.inbox.acker', { status: 'unread' });
    expect(second.messages).toHaveLength(0);

    // …and are queryable as read.
    const read = await h.relay.readInbox('relay.inbox.acker', { status: 'read' });
    expect(read.messages).toHaveLength(2);
  });

  it('with more unread messages than the limit, the first page is the OLDEST (FIFO across polls)', async () => {
    // Regression: unread pages used to come back newest-first, so an over-limit
    // backlog served the final done:true message on the FIRST poll — the agent
    // unregistered the inbox per the tool docs and orphaned earlier progress.
    await h.relay.registerEndpoint('relay.inbox.backlog');
    for (let step = 1; step <= 3; step++) {
      await h.relay.publish(
        'relay.inbox.backlog',
        { type: 'progress', step, done: step === 3 },
        { from: 'relay.agent.responder' }
      );
    }

    const firstPage = await h.relay.readInbox('relay.inbox.backlog', {
      status: 'unread',
      limit: 2,
      ack: true,
    });
    expect(firstPage.messages.map((m) => (m.payload as { step: number }).step)).toEqual([1, 2]);
    expect(firstPage.nextCursor).toBeTruthy();

    // Acked pages drain in order — the next poll returns the remaining oldest.
    const secondPage = await h.relay.readInbox('relay.inbox.backlog', {
      status: 'unread',
      limit: 2,
      ack: true,
    });
    expect(secondPage.messages.map((m) => (m.payload as { step: number }).step)).toEqual([3]);
    expect((secondPage.messages[0].payload as { done: boolean }).done).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// readInbox status filtering — DOR-337
// ---------------------------------------------------------------------------

describe('readInbox status filtering (DOR-337)', () => {
  it('separates a budget-rejected failure from a deliverable message in the same inbox', async () => {
    await h.relay.registerEndpoint('relay.agent.status-filter');

    // A real deliverable.
    await h.relay.publish(
      'relay.agent.status-filter',
      { text: 'deliverable' },
      { from: 'relay.sender' }
    );

    // Rejected at the budget gate — indexed status='failed' under the SAME
    // endpoint hash (endpoint hash is the subject itself), landing in the
    // Maildir failed/ dir right alongside the deliverable's new/ entry.
    await h.relay.publish(
      'relay.agent.status-filter',
      { text: 'rejected' },
      { from: 'relay.sender', budget: { callBudgetRemaining: 0 } }
    );

    const pending = await h.relay.readInbox('relay.agent.status-filter', { status: 'pending' });
    expect(pending.messages).toHaveLength(1);
    expect(pending.messages[0].payload).toEqual({ text: 'deliverable' });

    const failed = await h.relay.readInbox('relay.agent.status-filter', { status: 'failed' });
    expect(failed.messages).toHaveLength(1);
    expect(failed.messages[0].status).toBe('failed');

    const all = await h.relay.readInbox('relay.agent.status-filter', { status: 'all' });
    expect(all.messages).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Subscribe drains stranded messages — regression for H1
// ---------------------------------------------------------------------------

describe('subscribe drains endpoint backlog', () => {
  it('delivers messages already sitting in new/ to a late subscriber', async () => {
    await h.relay.registerEndpoint('relay.inbox.query.late-subscriber');

    // Reply lands while there is no subscriber — it strands in new/.
    await h.relay.publish(
      'relay.inbox.query.late-subscriber',
      { type: 'agent_result', text: 'early reply', done: true },
      { from: 'relay.agent.responder' }
    );

    const received: RelayEnvelope[] = [];
    h.relay.subscribe('relay.inbox.query.late-subscriber', (envelope) => {
      received.push(envelope);
    });

    await vi.waitFor(() => {
      expect(received).toHaveLength(1);
    });
    expect(received[0].payload).toEqual({ type: 'agent_result', text: 'early reply', done: true });
  });
});
