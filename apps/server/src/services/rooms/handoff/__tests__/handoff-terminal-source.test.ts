/** Actual acceptance coordinator, queue and migrated SQLite. No authority mocks/providers. */
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
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
  roomSessions,
  roomHandoffOutbox,
  sessionMessageAcceptanceReceipts,
  sessionMessageQueue,
  type Db,
} from '@dorkos/db';
import { MessageQueueStore } from '../../../session/message-queue-store.js';
import { PrivateSessionMessageAcceptanceService } from '../../../session/private-messages/acceptance.js';
import { HandoffOutboxStore } from '../outbox/handoff-outbox-store.js';
import { captureAdmissionRecipient } from '../outbox/admission-recipient.js';
import { HandoffTerminalSource } from '../handoff-terminal-source.js';
const NOW = new Date('2026-11-16T12:00:00.000Z');
describe('closed room handoff terminal source', () => {
  let home: string,
    path: string,
    db: Db,
    outbox: HandoffOutboxStore,
    adapter: HandoffTerminalSource,
    coordinator: PrivateSessionMessageAcceptanceService;
  function input(
    id = 'source',
    recipient = captureAdmissionRecipient(db, 'original-caller', 'casey-author', '/owned/casey')
  ) {
    return {
      envelopeJson: JSON.stringify({
        version: 2,
        recipient,
        evidence: {
          state: 'recorded-transfer',
          wordEvidence: 'conservative',
          sessionId: 'original-caller',
          turnSerial: 1,
        },
        source: { id, callerSessionId: 'original-caller', agentPath: '/owned/casey' },
        seat: {
          roomId: 'room',
          authorId: 'casey-author',
          sessionId: 'seat',
          canonicalSessionId: 'seat',
          joinedAt: NOW.toISOString(),
          agentPath: '/owned/casey',
        },
        enqueuedAt: 1000,
        waitDeadlineAt: 121000,
        carry: {
          externalAuthor: true,
          outsider: true,
          outsideWords: true,
          teammate: true,
          permissionCeiling: {
            asks: 'never',
            reach: 'everything',
            teammate: [{ roomId: 'room', authorId: 'casey-author' }],
          },
        },
      }),
      draft: 'Private original draft must not enter notification text',
      originJson: JSON.stringify({
        sessionId: 'original-caller',
        roomId: null,
        label: 'another chat',
        requester: null,
        memberJoinedAt: null,
      }),
      verbatim: false,
    };
  }
  function compose(epoch = 'boot-a') {
    outbox = new HandoffOutboxStore(db);
    adapter = new HandoffTerminalSource(db, outbox);
    coordinator = new PrivateSessionMessageAcceptanceService(
      db,
      new MessageQueueStore(db),
      [adapter],
      epoch,
      () => NOW
    );
  }
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'handoff-notice-'));
    path = join(home, 'owned.sqlite');
    db = createDb(path);
    runMigrations(db); // Missing generated outbox migration = setup failure, never RED.
    db.insert(agents)
      .values({
        id: 'casey-agent',
        name: 'casey',
        runtime: 'claude-code',
        projectPath: '/owned/casey',
        registeredAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      })
      .run();
    db.insert(authors)
      .values({
        id: 'casey-author',
        kind: 'agent',
        naturalKey: '/owned/casey',
        displayName: 'Casey',
        mintedForManifestId: 'casey-agent',
        createdAt: NOW.toISOString(),
      })
      .run();
    db.insert(sessionMetadata)
      .values({
        sessionId: 'original-caller',
        runtime: 'claude-code',
        agentPath: '/owned/casey',
        launchOrigin: 'interactive',
        createdAt: NOW.toISOString(),
      })
      .run();
    compose();
    outbox.admit(input());
    outbox.claimQueued('source', input().envelopeJson, 'boot-a', 1000, () => {});
    outbox.declineOwned('source', 'boot-a', 'No room post was made.');
  });
  afterEach(() => {
    try {
      db?.$client.close();
    } finally {
      if (home) rmSync(home, { recursive: true, force: true });
    }
  });
  it('accepts interactive exact original requester once with safe placeholder and stable real authority digest', () => {
    const ref = adapter.reference('source');
    const a = coordinator.accept(ref);
    const b = coordinator.accept(ref);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.receipt.id).toBe(a.receipt.id);
    expect(a.receipt).toMatchObject({
      sessionId: 'original-caller',
      agentId: 'casey-agent',
      originRuntime: 'claude-code',
      originAgentPath: '/owned/casey',
      sourceKind: 'room_handoff_terminal',
    });
    expect(a.receipt.originAuthorityDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(db.select().from(sessionMessageQueue).all()).toHaveLength(1);
    expect(outbox.readOwned('source', 'casey-author')).toMatchObject({
      noticeState: 'accepted',
      noticeReceiptId: a.receipt.id,
    });
  });
  it.each(['heartbeat', 'schedule', 'relay-binding', 'outside-sender', 'connector-event', null])(
    'never expands closed origin %s',
    (origin) => {
      db.update(sessionMetadata)
        .set({ launchOrigin: origin })
        .where(eq(sessionMetadata.sessionId, 'original-caller'))
        .run();
      expect(() => adapter.reference('source')).toThrow('no longer available');
      expect(db.select().from(sessionMessageQueue).all()).toEqual([]);
      expect(outbox.readOwned('source', 'casey-author')?.noticeState).toBe('ready');
    }
  );
  it('refuses original requester now bound to a room and never redirects to a DM or public room', () => {
    db.insert(roomSessions)
      .values({
        roomId: 'room',
        authorId: 'casey-author',
        sessionId: 'original-caller',
        createdAt: NOW.toISOString(),
      })
      .run();
    expect(() => adapter.reference('source')).toThrow('no longer available');
    expect(db.select().from(sessionMessageQueue).all()).toEqual([]);
  });
  it('rolls actual queue+receipt insertion back when source onAccepted CAS fails, then retries normally', () => {
    const ref = adapter.reference('source');
    db.$client
      .exec(`CREATE TRIGGER refuse_notice_accept BEFORE UPDATE OF notice_state ON room_handoff_outbox
      WHEN NEW.notice_state = 'accepted' BEGIN SELECT RAISE(ABORT,'notice write failed'); END;`);
    expect(() => coordinator.accept(ref)).toThrow('notice write failed');
    expect(db.select().from(sessionMessageQueue).all()).toEqual([]);
    expect(db.select().from(sessionMessageAcceptanceReceipts).all()).toEqual([]);
    expect(outbox.readOwned('source', 'casey-author')?.noticeState).toBe('ready');
    db.$client.exec('DROP TRIGGER refuse_notice_accept');
    expect(coordinator.accept(ref).created).toBe(true);
  });
  it('reopens actual SQLite and deduplicates accepted notice without replaying a dispatch attempt', async () => {
    const ref = adapter.reference('source');
    const first = coordinator.accept(ref);
    db.$client.close();
    db = createDb(path);
    runMigrations(db);
    compose('boot-b');
    expect(coordinator.accept(adapter.reference('source')).receipt.id).toBe(first.receipt.id);
    const prepared = await coordinator.prepare(first.receipt.id);
    coordinator.claim(first.receipt.id, prepared, {
      sessionId: 'original-caller',
      runtime: 'claude-code',
    });
    db.$client.close();
    db = createDb(path);
    runMigrations(db);
    compose('boot-c');
    expect(coordinator.recoverUnobservedAttempts()).toBe(1);
    expect(() =>
      coordinator.claim(first.receipt.id, prepared, {
        sessionId: 'original-caller',
        runtime: 'claude-code',
      })
    ).toThrow();
    expect(outbox.readOwned('source', 'casey-author')?.noticeReceiptId).toBe(first.receipt.id);
  });
  it('refuses deleted/recreated SAME caller id before first notice acceptance, while unchanged control succeeds', () => {
    const originalRef = adapter.reference('source');
    db.delete(sessionMetadata).where(eq(sessionMetadata.sessionId, 'original-caller')).run();
    db.insert(sessionMetadata)
      .values({
        sessionId: 'original-caller',
        runtime: 'claude-code',
        agentPath: '/owned/casey',
        launchOrigin: 'interactive',
        createdAt: '2026-11-16T12:01:00.000Z',
      })
      .run();
    expect(() => coordinator.accept(originalRef)).toThrow('no longer available');
    expect(db.select().from(sessionMessageQueue).all()).toEqual([]);
    expect(outbox.readOwned('source', 'casey-author')?.noticeState).toBe('ready');
    db.update(sessionMetadata)
      .set({ createdAt: NOW.toISOString() })
      .where(eq(sessionMetadata.sessionId, 'original-caller'))
      .run();
    expect(coordinator.accept(originalRef).created).toBe(true);
  });
  it('refuses actual recipient retarget after prepare and retains accepted receipt identity', async () => {
    const accepted = coordinator.accept(adapter.reference('source'));
    const prepared = await coordinator.prepare(accepted.receipt.id);
    db.update(sessionMetadata)
      .set({ agentPath: '/owned/other' })
      .where(eq(sessionMetadata.sessionId, 'original-caller'))
      .run();
    expect(() =>
      coordinator.claim(accepted.receipt.id, prepared, {
        sessionId: 'original-caller',
        runtime: 'claude-code',
      })
    ).toThrow('no longer available');
    expect(outbox.readOwned('source', 'casey-author')?.noticeReceiptId).toBe(accepted.receipt.id);
  });
  it('cannot strip frozen marks by forging prepared extras, and rejects durable carry changes', async () => {
    const accepted = coordinator.accept(adapter.reference('source'));
    const prepared = await coordinator.prepare(accepted.receipt.id);
    const altered = input().envelopeJson.replace('"outsider":true', '"outsider":false');
    db.update(roomHandoffOutbox)
      .set({ envelopeJson: altered })
      .where(eq(roomHandoffOutbox.id, 'source'))
      .run();
    expect(() =>
      coordinator.claim(accepted.receipt.id, prepared, {
        sessionId: 'original-caller',
        runtime: 'claude-code',
      })
    ).toThrow();
    db.update(roomHandoffOutbox)
      .set({ envelopeJson: input().envelopeJson })
      .where(eq(roomHandoffOutbox.id, 'source'))
      .run();
    const forged = { ...prepared, roomHandoffCarry: { outsideWords: false, outsider: false } };
    const claimed = coordinator.claim(accepted.receipt.id, forged, {
      sessionId: 'original-caller',
      runtime: 'claude-code',
    });
    expect(claimed).toMatchObject({ roomHandoffCarry: { outsideWords: true, outsider: true } });
  });
  it('returns original positive carry at real claim and refuses mismatched actual runtime/session binding', async () => {
    const accepted = coordinator.accept(adapter.reference('source'));
    const prepared = await coordinator.prepare(accepted.receipt.id);
    expect(prepared.content).not.toContain(input().draft);
    expect(() =>
      coordinator.claim(accepted.receipt.id, prepared, {
        sessionId: 'other',
        runtime: 'claude-code',
      })
    ).toThrow();
    const claim = coordinator.claim(accepted.receipt.id, prepared, {
      sessionId: 'original-caller',
      runtime: 'claude-code',
    });
    expect(claim).toMatchObject({
      roomHandoffCarry: {
        externalAuthor: true,
        outsider: true,
        outsideWords: true,
        teammate: true,
        permissionCeiling: [
          {
            asks: 'never',
            reach: 'everything',
            teammate: [{ roomId: 'room', authorId: 'casey-author' }],
          },
        ],
      },
    });
  });
});
