/**
 * What the managed remote access journal and outbox hold on their own
 * (DOR-2086): one row per command id, a closed verb and acknowledgement set,
 * and one row per idempotency key.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, runMigrations, type Db } from '../index.js';
import { remoteCommandJournal, remoteEventOutbox } from '../schema/remote/remote-commands.js';

const row = {
  commandId: 'cmd_0001',
  leaseToken: 'lt_0001',
  verb: 'open' as const,
  instanceId: 'inst_0001',
  receivedAt: '2026-10-10T09:00:00.000Z',
};

describe('remote_command_journal', () => {
  let db: Db;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
  });

  it('stores a command as pending with no outcome yet', () => {
    db.insert(remoteCommandJournal).values(row).run();
    expect(db.select().from(remoteCommandJournal).get()).toEqual({
      ...row,
      outcome: null,
      ackState: 'pending',
      ackAttempts: 0,
      settledAt: null,
      ackedAt: null,
    });
  });

  it('keeps one row per command id', () => {
    db.insert(remoteCommandJournal).values(row).run();
    expect(() => db.insert(remoteCommandJournal).values(row).run()).toThrow(/UNIQUE/i);
  });

  it('refuses a verb outside the leased kinds', () => {
    expect(() =>
      db
        .insert(remoteCommandJournal)
        .values({ ...row, verb: 'keepalive' as never })
        .run()
    ).toThrow(/CHECK/i);
  });

  it('refuses an unknown acknowledgement state', () => {
    db.insert(remoteCommandJournal).values(row).run();
    expect(() =>
      db
        .update(remoteCommandJournal)
        .set({ ackState: 'lost' as never })
        .where(eq(remoteCommandJournal.commandId, row.commandId))
        .run()
    ).toThrow(/CHECK/i);
  });
});

describe('remote_event_outbox', () => {
  let db: Db;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
  });

  it('keeps one batch per idempotency key', () => {
    const batch = {
      id: 'b1',
      idempotencyKey: 'key-1',
      instanceId: 'inst_0001',
      batch: '{"activity":[]}',
      createdAt: '2026-10-10T09:00:00.000Z',
    };
    db.insert(remoteEventOutbox).values(batch).run();
    expect(() =>
      db
        .insert(remoteEventOutbox)
        .values({ ...batch, id: 'b2' })
        .run()
    ).toThrow(/UNIQUE/i);
  });
});
