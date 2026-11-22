/** Real SQLite/RoomStore transactions with the registered generated migrations. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createDb,
  runMigrations,
  eq,
  agents,
  authors,
  sessionMetadata,
  roomHandoffOutbox,
  type Db,
} from '@dorkos/db';
import { RoomStore, type NewRoomEntry } from '../../room-store.js';
import { captureAdmissionRecipient } from '../outbox/admission-recipient.js';
import { HandoffOutboxStore, HandoffOutboxConflict } from '../outbox/handoff-outbox-store.js';
const now = 1000;
function entry(id: string): NewRoomEntry {
  return {
    id,
    roomId: 'room',
    authorId: 'casey',
    kind: 'post',
    body: { text: 'Accepted room answer' },
    mentions: [],
    sessionId: 'seat',
    cascadeRoot: id,
    cascadeDepth: 0,
    parentEntryId: null,
    threadRootEntryId: null,
    dispatchId: 'dispatch',
    createdAt: '2026-11-16T12:01:00.000Z',
  };
}
describe('durable public handoff outbox', () => {
  let home: string, path: string, db: Db, store: HandoffOutboxStore, rooms: RoomStore;
  function input(id: string) {
    return {
      envelopeJson: JSON.stringify({
        version: 2,
        recipient: captureAdmissionRecipient(db, 'casey-source', 'casey', '/owned/casey'),
        evidence: {
          state: 'recorded-transfer',
          wordEvidence: 'conservative',
          sessionId: 'casey-source',
          turnSerial: 1,
        },
        source: { id, callerSessionId: 'casey-source', agentPath: '/owned/casey' },
        seat: {
          roomId: 'room',
          authorId: 'casey',
          sessionId: 'seat',
          canonicalSessionId: 'seat',
          joinedAt: '2026-11-16T12:00:00.000Z',
          agentPath: '/owned/casey',
        },
        enqueuedAt: now,
        waitDeadlineAt: now + 120000,
        carry: {
          externalAuthor: false,
          permissionCeiling: null,
          outsider: false,
          outsideWords: true,
          teammate: false,
        },
      }),
      draft: 'Original immutable draft',
      originJson: JSON.stringify({
        sessionId: 'casey-source',
        roomId: null,
        label: 'another chat',
        requester: null,
        memberJoinedAt: null,
      }),
      verbatim: false,
    };
  }
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'handoff-outbox-'));
    path = join(home, 'owned.sqlite');
    db = createDb(path);
    runMigrations(db); // Missing future migration is SETUP failure, never defect proof.
    store = new HandoffOutboxStore(db);
    rooms = new RoomStore(db);
    db.insert(agents)
      .values({
        id: 'casey-agent',
        name: 'casey',
        runtime: 'claude-code',
        projectPath: '/owned/casey',
        registeredAt: '2026-11-16T12:00:00.000Z',
        updatedAt: '2026-11-16T12:00:00.000Z',
      })
      .run();
    db.insert(authors)
      .values({
        id: 'casey',
        kind: 'agent',
        naturalKey: '/owned/casey',
        displayName: 'Casey',
        mintedForManifestId: 'casey-agent',
        createdAt: '2026-11-16T12:00:00.000Z',
      })
      .run();
    db.insert(sessionMetadata)
      .values({
        sessionId: 'casey-source',
        runtime: 'claude-code',
        agentPath: '/owned/casey',
        launchOrigin: 'interactive',
        createdAt: '2026-11-16T12:00:00.000Z',
      })
      .run();
    rooms.createRoom(
      {
        id: 'room',
        kind: 'channel',
        slug: 'room',
        title: 'Room',
        topic: null,
        createdAt: '2026-11-16T12:00:00.000Z',
      },
      []
    );
  });
  afterEach(() => {
    try {
      db?.$client.close();
    } finally {
      if (home) rmSync(home, { recursive: true, force: true });
    }
  });
  function claim(id: string) {
    const original = input(id);
    store.admit(original);
    store.claimQueued(id, original.envelopeJson, 'boot-a', now, (_tx, envelope) => {
      expect(envelope.seat.roomId).toBe('room');
    });
    return original;
  }
  it('prunes settled rows after seven days while retaining pending notices and work', () => {
    const settled = Date.now();
    for (const id of ['old', 'unacked', 'queued', 'recent']) store.admit(input(id));
    store.declineQueued('old', 'it stopped.');
    store.skipNotice('old', 'source closed');
    store.declineQueued('unacked', 'it stopped.');
    store.declineQueued('recent', 'it stopped.');
    store.skipNotice('recent', 'source closed');
    db.update(roomHandoffOutbox)
      .set({ settledAt: settled })
      .where(eq(roomHandoffOutbox.id, 'old'))
      .run();
    db.update(roomHandoffOutbox)
      .set({ settledAt: settled + 1 })
      .where(eq(roomHandoffOutbox.id, 'recent'))
      .run();
    store.pruneSettled(settled + 7 * 24 * 60 * 60_000);
    expect(store.readOwned('old', 'casey')).toBeNull();
    for (const id of ['unacked', 'queued', 'recent'])
      expect(store.readOwned(id, 'casey')).not.toBeNull();
  });
  it('keeps immutable original scope/deadline/body across exact retries and refuses changed retries', () => {
    const original = input('immutable');
    store.admit(original);
    expect(store.admit(original)).toMatchObject({ waitDeadlineAt: now + 120000, state: 'queued' });
    expect(() => store.admit({ ...original, draft: 'Changed' })).toThrow(HandoffOutboxConflict);
    expect(store.readOwned('immutable', 'other')).toBeNull();
    expect(store.readOwned('immutable', 'casey')?.envelopeJson).toBe(original.envelopeJson);
  });
  it('reopens actual SQLite: only original unexpired queued rows are replay candidates', () => {
    store.admit(input('queued'));
    claim('preparing');
    claim('running');
    store.markRunning('running', 'boot-a', 'dispatch', now);
    store.admit(input('expired'));
    db.update(roomHandoffOutbox)
      .set({
        envelopeJson: input('expired').envelopeJson.replace('121000', '1000'),
        waitDeadlineAt: now,
      })
      .where(eq(roomHandoffOutbox.id, 'expired'))
      .run();
    db.$client.close();
    db = createDb(path);
    runMigrations(db);
    store = new HandoffOutboxStore(db);
    store.recoverQueued(now + 1);
    expect(store.queuedRows().map((row) => row.id)).toEqual(['queued']);
    for (const id of ['preparing', 'running'])
      expect(store.readOwned(id, 'casey')).toMatchObject({
        state: 'interrupted',
        noticeState: 'ready',
      });
    expect(store.readOwned('expired', 'casey')?.state).toBe('expired');
    store.recoverQueued(now + 2);
    expect(store.queuedRows().map((row) => row.id)).toEqual(['queued']);
  });
  it('quarantines corrupt durable carry and refuses final claims at original deadline', () => {
    store.admit(input('corrupt'));
    db.update(roomHandoffOutbox)
      .set({ envelopeJson: '{}' })
      .where(eq(roomHandoffOutbox.id, 'corrupt'))
      .run();
    store.recoverQueued(now);
    expect(store.queuedRows()).toEqual([]);
    expect(store.readOwned('corrupt', 'casey')).toMatchObject({
      state: 'quarantined',
      noticeState: 'ready',
    });
    store.admit(input('late'));
    expect(() =>
      store.claimQueued('late', input('late').envelopeJson, 'boot-b', now + 120000, () => {})
    ).toThrow(HandoffOutboxConflict);
    claim('preparing-late');
    expect(() => store.markRunning('preparing-late', 'boot-a', 'dispatch', now + 120000)).toThrow(
      HandoffOutboxConflict
    );
  });
  it('refuses an accidentally asynchronous authority callback without consuming the source', () => {
    store.admit(input('async-authority'));
    expect(() =>
      store.claimQueued(
        'async-authority',
        input('async-authority').envelopeJson,
        'boot',
        now,
        async () => {}
      )
    ).toThrow('must be synchronous');
    expect(store.readOwned('async-authority', 'casey')?.state).toBe('queued');
  });
  it('does not admit or reclaim an original packet after same-ID recipient epoch changes', () => {
    const original = input('epoch');
    store.admit(original);
    db.update(sessionMetadata)
      .set({ createdAt: '2026-11-16T12:01:00.000Z' })
      .where(eq(sessionMetadata.sessionId, 'casey-source'))
      .run();
    expect(() =>
      store.claimQueued('epoch', original.envelopeJson, 'new-boot', now, () => {})
    ).toThrow(HandoffOutboxConflict);
    const another = JSON.parse(original.envelopeJson);
    another.source.id = 'new-original-epoch';
    expect(() => store.admit({ ...original, envelopeJson: JSON.stringify(another) })).toThrow(
      HandoffOutboxConflict
    );
    expect(store.readOwned('epoch', 'casey')?.state).toBe('queued');
    expect(store.readOwned('new-original-epoch', 'casey')).toBeNull();
  });
  it('real RoomStore append commits entry + posted CAS + notice-ready atomically', () => {
    claim('posted');
    store.markRunning('posted', 'boot-a', 'dispatch', now);
    const posted = rooms.appendEntry(
      entry('entry'),
      undefined,
      store.postedBinder('posted', 'boot-a', 'dispatch', 'entry')
    );
    expect(store.readOwned('posted', 'casey')).toMatchObject({
      state: 'posted',
      postedEntryId: 'entry',
      postedSeq: posted.seq,
      noticeState: 'ready',
    });
    expect(rooms.listEntries('room', { limit: 10 }).map((e) => e.id)).toEqual(['entry']);
  });
  it('zero CAS from wrong owner rolls back actual RoomStore append, then valid owner succeeds once', () => {
    claim('rollback');
    store.markRunning('rollback', 'boot-a', 'dispatch', now);
    expect(() =>
      rooms.appendEntry(
        entry('bad'),
        undefined,
        store.postedBinder('rollback', 'wrong', 'dispatch', 'bad')
      )
    ).toThrow(HandoffOutboxConflict);
    expect(rooms.listEntries('room', { limit: 10 })).toEqual([]);
    expect(store.readOwned('rollback', 'casey')?.state).toBe('running');
    rooms.appendEntry(
      entry('good'),
      undefined,
      store.postedBinder('rollback', 'boot-a', 'dispatch', 'good')
    );
    expect(() =>
      rooms.appendEntry(
        entry('duplicate'),
        undefined,
        store.postedBinder('rollback', 'boot-a', 'dispatch', 'duplicate')
      )
    ).toThrow(HandoffOutboxConflict);
    expect(rooms.listEntries('room', { limit: 10 }).map((e) => e.id)).toEqual(['good']);
  });
  it('rolls posted source and actual appended entry back on a later same-transaction failure', () => {
    claim('downstream');
    store.markRunning('downstream', 'boot-a', 'dispatch', now);
    const exact = new Error('later bind statement failed');
    let caught: unknown;
    try {
      rooms.appendEntry(entry('downstream-entry'), undefined, (tx, seq) => {
        store.postedBinder('downstream', 'boot-a', 'dispatch', 'downstream-entry')(tx, seq);
        throw exact;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(exact);
    expect(rooms.listEntries('room', { limit: 10 })).toEqual([]);
    expect(store.readOwned('downstream', 'casey')).toMatchObject({
      state: 'running',
      noticeState: 'none',
      postedEntryId: null,
    });
  });
  it('scopes entry lookup by room when two rooms contain the same entry id and seq', () => {
    rooms.createRoom(
      {
        id: 'other-room',
        kind: 'channel',
        slug: 'other-room',
        title: 'Other',
        topic: null,
        createdAt: '2026-11-16T12:00:00.000Z',
      },
      []
    );
    // Insert foreign room first; a lookup by id+seq alone can select this unrelated post.
    rooms.appendEntry({ ...entry('same-id'), roomId: 'other-room' });
    claim('local-source');
    store.markRunning('local-source', 'boot-a', 'dispatch', now);
    const local = rooms.appendEntry(
      entry('same-id'),
      undefined,
      store.postedBinder('local-source', 'boot-a', 'dispatch', 'same-id')
    );
    expect(local.seq).toBe(1);
    expect(rooms.listEntries('other-room', { limit: 10 })).toHaveLength(1);
    expect(rooms.listEntries('room', { limit: 10 })).toHaveLength(1);
    expect(store.readOwned('local-source', 'casey')).toMatchObject({
      state: 'posted',
      roomId: 'room',
      postedEntryId: 'same-id',
    });
  });
  it('allows only one source per posted room witness and rolls back the competing transaction', () => {
    claim('first-source');
    claim('second-source');
    store.markRunning('first-source', 'boot-a', 'dispatch', now);
    store.markRunning('second-source', 'boot-a', 'dispatch', now);
    const posted = rooms.appendEntry(
      entry('one-witness'),
      undefined,
      store.postedBinder('first-source', 'boot-a', 'dispatch', 'one-witness')
    );
    expect(() =>
      db.transaction((tx) => {
        store.postedBinder('second-source', 'boot-a', 'dispatch', 'one-witness')(tx, posted.seq);
      })
    ).toThrow(); // Actual generated SQLite composite unique constraint owns this refusal.
    expect(store.readOwned('first-source', 'casey')).toMatchObject({
      state: 'posted',
      noticeState: 'ready',
    });
    expect(store.readOwned('second-source', 'casey')).toMatchObject({
      state: 'running',
      noticeState: 'none',
      postedEntryId: null,
    });
    expect(rooms.listEntries('room', { limit: 10 }).map((e) => e.id)).toEqual(['one-witness']);
  });
  it('notice acceptance participates in caller transaction and cannot consume twice', () => {
    claim('notice');
    store.declineOwned('notice', 'boot-a', 'Stopped before posting.');
    const exact = new Error('receipt insert failed');
    let caught: unknown;
    try {
      db.transaction((tx) => {
        store.acceptTerminalNotice(tx, 'notice', 'casey', 'receipt');
        throw exact;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(exact);
    expect(store.readOwned('notice', 'casey')?.noticeState).toBe('ready');
    db.transaction((tx) => store.acceptTerminalNotice(tx, 'notice', 'casey', 'receipt'));
    expect(() =>
      db.transaction((tx) => store.acceptTerminalNotice(tx, 'notice', 'casey', 'second'))
    ).toThrow(HandoffOutboxConflict);
    expect(store.readOwned('notice', 'casey')?.noticeReceiptId).toBe('receipt');
  });
});
