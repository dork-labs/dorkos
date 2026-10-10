/**
 * Acknowledging managed remote access commands (DOR-2086): retried until
 * accepted or refused, across a restart, never trusting a count alone, and
 * the journal that holds them staying bounded.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import openFixture from '@dork-labs/cloud-api/fixtures/v1/remote/command-open.json' with { type: 'json' };
import ackRequest from '@dork-labs/cloud-api/fixtures/v1/remote/commands-ack-request.json' with { type: 'json' };
import ackResponse from '@dork-labs/cloud-api/fixtures/v1/remote/commands-ack.json' with { type: 'json' };

import { RemoteCommandAckRequestSchema } from '@dork-labs/cloud-api';
import { CommandAcks } from '../command-acks.js';
import type { LeasedCommand } from '../command-dispatcher.js';
import { JOURNAL_MAX_FINISHED_ROWS, JOURNAL_RETENTION_MS } from '../command-journal.js';
import { CommandJournal } from '../command-journal.js';
import { commandWorld, INSTANCE_ID, type CommandWorld } from './command-harness.js';
import { problem } from './fake-cloud.js';

const ACK = '/v1/remote/commands/ack';
const open = openFixture as LeasedCommand;

let w: CommandWorld;
let retries: number[];

function acks(world: CommandWorld = w): CommandAcks {
  return new CommandAcks(world.link, {
    journal: world.journal,
    random: () => 0.5,
    timers: {
      setTimeout: (_fn, ms) => {
        retries.push(ms);
        return ms;
      },
      clearTimeout: () => undefined,
    },
  });
}

/** Journal and settle a command without acting on anything. */
function settled(id: string, leaseToken = `lt_${id}`, outcome: 'applied' | 'failed' = 'applied') {
  w.journal.record({ commandId: id, leaseToken, verb: 'close', instanceId: INSTANCE_ID });
  w.journal.settle(id, outcome);
}

beforeEach(async () => {
  w = await commandWorld();
  retries = [];
});

afterEach(() => {
  w.cleanup();
});

describe('CommandAcks', () => {
  it('sends the published request shape and finishes what Cloud settled', async () => {
    settled('cmd_0001', 'lt_0003');
    w.cloud.on('POST', ACK, { status: 200, body: { acknowledged: 1 } });
    await acks().flush();
    const body = w.cloud.callsTo('POST', ACK)[0]?.body;
    expect(RemoteCommandAckRequestSchema.parse(body)).toEqual({ items: [ackRequest.items[0]] });
    expect(w.journal.pendingAcks(INSTANCE_ID)).toEqual([]);
    expect(w.journal.read(['cmd_0001'])[0]?.ackState).toBe('acked');
  });

  it('settles a whole batch only when the count matches, and checks each lease when it does not', async () => {
    settled('cmd_a');
    settled('cmd_b');
    w.cloud.on(
      'POST',
      ACK,
      { status: 200, body: { acknowledged: 1 } },
      { status: 200, body: { acknowledged: 1 } },
      { status: 200, body: { acknowledged: 0 } }
    );
    await acks().flush();
    const calls = w.cloud.callsTo('POST', ACK);
    expect(calls.map((call) => (call.body as { items: unknown[] }).items.length)).toEqual([
      2, 1, 1,
    ]);
    expect(w.journal.read(['cmd_a'])[0]?.ackState).toBe('acked');
    expect(w.journal.read(['cmd_b'])[0]?.ackState).toBe('unconfirmed');
  });

  it('marks a lease Cloud refuses as rejected, splitting a refused batch first', async () => {
    settled('cmd_a');
    settled('cmd_b');
    w.cloud.on(
      'POST',
      ACK,
      problem(409, 'conflict'),
      { status: 200, body: { acknowledged: 1 } },
      problem(409, 'conflict')
    );
    await acks().flush();
    expect(w.journal.read(['cmd_a'])[0]?.ackState).toBe('acked');
    expect(w.journal.read(['cmd_b'])[0]?.ackState).toBe('rejected');
  });

  it('retries an outage or a rate limit with backoff, and keeps the item pending', async () => {
    settled('cmd_a');
    w.cloud.on('POST', ACK, { networkError: true }, problem(429, 'rate_limited'), {
      status: 200,
      body: ackResponse,
    });
    const sender = acks();
    await sender.flush();
    await sender.flush();
    expect(retries).toEqual([1000, 2000]);
    expect(w.journal.pendingAcks(INSTANCE_ID)).toHaveLength(1);
    await sender.flush();
    expect(w.journal.pendingAcks(INSTANCE_ID)).toEqual([]);
  });

  it('never acknowledges under a later link', async () => {
    settled('cmd_a');
    w.cloud.unlink();
    w.cloud.relink();
    await acks().flush();
    expect(w.cloud.callsTo('POST', ACK)).toEqual([]);
    expect(w.journal.pendingAcks(INSTANCE_ID)).toHaveLength(1);
  });
});

describe('across a restart', () => {
  it('a lost acknowledgement is redelivered and answered without acting twice', async () => {
    expect(await w.dispatcher.dispatch(open, w.link)).toBe('applied');
    w.cloud.on('POST', ACK, { networkError: true });
    await acks().flush();
    expect(w.journal.pendingAcks(INSTANCE_ID)).toHaveLength(1);

    // Restart: a new journal and dispatcher over the same database.
    w.restart();
    w.cloud.on('POST', ACK, { status: 200, body: { acknowledged: 1 } });
    const redelivered = { ...open, leaseToken: 'lt_after_restart' } as LeasedCommand;
    expect(await w.dispatcher.dispatch(redelivered, w.link)).toBe('applied');
    expect(w.tunnel.startManaged).toHaveBeenCalledTimes(1);
    await acks().flush();
    const last = w.cloud.callsTo('POST', ACK).at(-1)?.body as { items: unknown[] };
    expect(last.items).toEqual([
      { id: open.id, leaseToken: 'lt_after_restart', outcome: 'applied' },
    ]);
    expect(w.journal.read([open.id])[0]?.ackState).toBe('acked');
  });

  it('a command interrupted mid-effect settles as failed and is never re-run', async () => {
    w.journal.record({
      commandId: open.id,
      leaseToken: open.leaseToken,
      verb: 'open',
      instanceId: INSTANCE_ID,
    });
    // The process died here, before the outcome was recorded.
    w.restart();
    expect(w.journal.settleInterrupted()).toBe(1);
    expect(await w.dispatcher.dispatch(open, w.link)).toBe('failed');
    expect(w.tunnel.startManaged).not.toHaveBeenCalled();
  });
});

describe('the journal', () => {
  it('keeps no bearer and no tunnel value, only the lease token', async () => {
    expect(await w.dispatcher.dispatch(open, w.link)).toBe('applied');
    const text = JSON.stringify(w.journal.read([open.id]));
    expect(text).not.toContain('crv_0001');
    expect(text).not.toContain('eps_0001');
    expect(text).not.toContain('instance-key');
  });

  it('stays bounded: old rows go, and finished rows past the cap go', () => {
    let clock = Date.parse('2026-10-01T00:00:00.000Z');
    const journal = new CommandJournal(w.db, () => clock);
    journal.record({ commandId: 'old', leaseToken: 'lt', verb: 'close', instanceId: INSTANCE_ID });
    clock += JOURNAL_RETENTION_MS + 1;
    for (let i = 0; i < JOURNAL_MAX_FINISHED_ROWS + 3; i += 1) {
      clock += 1;
      const id = `cmd_${String(i).padStart(4, '0')}`;
      journal.record({ commandId: id, leaseToken: 'lt', verb: 'close', instanceId: INSTANCE_ID });
      journal.settle(id, 'applied');
      journal.finish([{ id, leaseToken: 'lt' }], 'acked');
    }
    journal.record({ commandId: 'owed', leaseToken: 'lt', verb: 'close', instanceId: INSTANCE_ID });
    expect(journal.prune()).toBe(4);
    expect(journal.read(['old', 'cmd_0000', 'cmd_0002'])).toEqual([]);
    expect(journal.read(['owed', 'cmd_0003'])).toHaveLength(2);
  });
});
