/**
 * DOR-4472 class proof: peer writes must enter a scoped, bounded, marked private
 * aside, never ordinary session dispatch or an automatic public body post.
 */
import { describe, expect, it, vi } from 'vitest';
import { ChatMessageService } from '../../../session/chat-messages/chat-message-service.js';
import { agentKey } from '../../room-claims.js';
import type { RoomTriggerDispatcher } from '../../room-trigger.js';
import type { SeatMessagePending } from '../../handoff/seat-message-types.js';
import { SEAT_MESSAGE_GLOBAL_MAX } from '../../handoff/seat-messages.js';
import {
  currentSeatMessageTarget,
  seatBatchStillCurrent,
} from '../../handoff/seat-message-target.js';
import type { RoomCore } from '../../service/room-core.js';

import {
  bo,
  caller,
  chats,
  deferredFinishes,
  harness,
  receipts,
  roomId,
  seatInbox,
  setSeatInbox,
  turns,
  useSeatMessageRoom,
} from './seat-messages.fixtures.js';

useSeatMessageRoom();

it.each(['expiry', 'later-items', 'stop', 'requeue-error'] as const)(
  'M9: post-claim busy retains receipt ownership through %s',
  async (scenario) => {
    vi.useFakeTimers();
    const { triggers } = harness.service as unknown as { triggers: RoomTriggerDispatcher };
    const key = agentKey(roomId, bo);
    const block = () =>
      triggers.claimed.set(key, {
        roomId,
        authorId: bo,
        sessionId: 'seat-chat',
        agentPath: '/agents/bo',
        claimedAt: new Date().toISOString(),
      } as never);
    let finish: (() => void) | undefined;
    let attempts = 0;
    triggers.deps.runner.run = async (request) => {
      turns.push(request);
      attempts++;
      // This is the real room claim boundary, not the pre-claim busy shortcut.
      expect(triggers.claimed.get(key)?.aside).toBe(true);
      expect(receipts.listSentFrom(caller.sessionId).some((row) => row.status === 'working')).toBe(
        true
      );
      if (attempts === 1) {
        await new Promise<void>((resolve) => {
          finish = resolve;
          deferredFinishes.add(resolve);
        });
        return { sessionId: request.sessionId!, text: null, unanswered: 'busy' };
      }
      return { sessionId: request.sessionId!, text: null };
    };
    if (scenario === 'requeue-error') block();
    if (scenario === 'expiry') {
      // A full hour of 30-second rechecks over a small bound proves the same rule as 25 (DOR-4722).
      seatInbox!.stop();
      setSeatInbox(
        harness.service.createSeatMessages(receipts, () => undefined, {
          pendingMax: 3,
          globalMax: SEAT_MESSAGE_GLOBAL_MAX,
        })
      );
    }
    const first = await chats.send(caller, { to: 'seat-chat', message: 'BUSY_FIRST' });
    let second: Awaited<ReturnType<ChatMessageService['send']>> | undefined;
    try {
      if (scenario === 'requeue-error') {
        second = await chats.send(caller, { to: 'seat-chat', message: 'BUSY_SECOND' });
        triggers.claimed.delete(key);
        await vi.advanceTimersByTimeAsync(30_000);
      }
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
      expect(receipts.get(first.messageId)?.status).toBe('working');
      if (scenario === 'later-items' || scenario === 'stop')
        second = await chats.send(caller, { to: 'seat-chat', message: 'BUSY_SECOND' });
      if (scenario === 'requeue-error') {
        harness.db.$client.exec(`CREATE TRIGGER fail_busy_requeue BEFORE UPDATE ON chat_messages
          WHEN OLD.id='${first.messageId}' AND OLD.status='working' AND NEW.status='queued'
          BEGIN SELECT RAISE(ABORT, 'requeue unavailable'); END`);
      }
      if (scenario === 'stop') seatInbox!.stop();
      finish!();
      await vi.advanceTimersByTimeAsync(0);
      if (scenario === 'stop' || scenario === 'requeue-error') {
        await seatInbox!.idle();
        expect(receipts.get(first.messageId)?.status).toBe('failed');
        expect(receipts.get(second!.messageId)?.status).toBe('failed');
        expect((seatInbox as unknown as { count: number }).count).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        if (scenario === 'stop') return;
        await expect(
          chats.send(caller, { to: 'seat-chat', message: 'NO_AFTER_STORAGE_FAILURE' })
        ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
        return;
      } else {
        expect(receipts.get(first.messageId)?.status).toBe('queued');
        if (scenario === 'expiry') {
          block();
          // The requeued first message plus these fill the seat's bound of 3.
          for (let i = 0; i < 2; i++)
            await chats.send(caller, { to: 'seat-chat', message: `WAITING_${i}` });
          await expect(
            chats.send(caller, { to: 'seat-chat', message: 'OVERFLOW' })
          ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
          await vi.advanceTimersByTimeAsync(60 * 60_000 + 1);
          await seatInbox!.idle();
          expect(receipts.listSentFrom(caller.sessionId)).toHaveLength(3);
          expect(
            receipts.listSentFrom(caller.sessionId).every((row) => row.status === 'failed')
          ).toBe(true);
          expect((seatInbox as unknown as { count: number }).count).toBe(0);
          expect(attempts).toBe(1);
          triggers.claimed.delete(key);
        } else {
          expect(receipts.get(second!.messageId)?.status).toBe('queued');
          await vi.advanceTimersByTimeAsync(30_000);
          await seatInbox!.idle();
          expect(receipts.get(first.messageId)?.status).toBe('delivered');
          expect(receipts.get(second!.messageId)?.status).toBe('delivered');
          expect(turns[1]!.prompt.indexOf('BUSY_FIRST')).toBeLessThan(
            turns[1]!.prompt.indexOf('BUSY_SECOND')
          );
          expect((seatInbox as unknown as { count: number }).count).toBe(0);
          expect(attempts).toBe(2);
          return;
        }
      }
      // Expiry or storage failure releases capacity once; a fresh send can finish.
      const next = await chats.send(caller, { to: 'seat-chat', message: 'AFTER_BUSY' });
      await seatInbox!.idle();
      expect(receipts.get(next.messageId)?.status).toBe('delivered');
      expect((seatInbox as unknown as { count: number }).count).toBe(0);
    } finally {
      seatInbox!.stop();
      finish?.();
      await seatInbox!.idle();
    }
  }
);

it.each(['transient', 'persistent', 'stop-flush', 'stop-late', 'expiry'] as const)(
  'M9: terminal write debt remains owned through %s storage failure',
  async (scenario) => {
    vi.useFakeTimers();
    const { triggers } = harness.service as unknown as { triggers: RoomTriggerDispatcher };
    const key = agentKey(roomId, bo);
    let finish: (() => void) | undefined;
    let attempts = 0;
    const writes = vi.spyOn(receipts, 'updatePendingSeatMessage');
    triggers.deps.runner.run = async (request) => {
      turns.push(request);
      attempts++;
      await new Promise<void>((resolve) => {
        finish = resolve;
        deferredFinishes.add(resolve);
      });
      return { sessionId: request.sessionId!, text: null };
    };
    if (scenario === 'expiry')
      triggers.claimed.set(key, {
        roomId,
        authorId: bo,
        sessionId: 'seat-chat',
        agentPath: '/agents/bo',
        claimedAt: new Date().toISOString(),
      } as never);
    const first = await chats.send(caller, { to: 'seat-chat', message: 'PRIVATE_DEBT_FIRST' });
    if (scenario !== 'expiry') await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const second = await chats.send(caller, { to: 'seat-chat', message: 'PRIVATE_DEBT_SECOND' });
    const failedId = scenario === 'stop-late' ? second.messageId : first.messageId;
    harness.db.$client.exec(`CREATE TRIGGER fail_terminal_write BEFORE UPDATE ON chat_messages
      WHEN OLD.id='${failedId}' AND NEW.status IN ('delivered','failed')
      BEGIN SELECT RAISE(ABORT, 'terminal storage unavailable'); END`);
    try {
      if (scenario === 'stop-late' || scenario === 'expiry')
        await vi.advanceTimersByTimeAsync(60 * 60_000 + 1);
      else {
        finish!();
        await vi.advanceTimersByTimeAsync(0);
      }
      // Durable pending rows must still have in-process capacity ownership.
      const pending = () =>
        receipts
          .listSentFrom(caller.sessionId)
          .filter((row) => row.status === 'queued' || row.status === 'working').length;
      expect(pending()).toBeGreaterThan(0);
      expect((seatInbox as unknown as { count: number }).count).toBe(pending());
      await expect(
        chats.send(caller, { to: 'seat-chat', message: 'NO_NEW_WORK' })
      ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
      if (scenario === 'persistent') {
        const before = writes.mock.calls.length;
        await vi.advanceTimersByTimeAsync(90_000);
        expect(writes.mock.calls.length).toBeGreaterThan(before);
        expect((seatInbox as unknown as { count: number }).count).toBe(pending());
        expect(vi.getTimerCount()).toBe(1);
        expect(attempts).toBe(1);
      }
      if (scenario === 'stop-flush') {
        harness.db.$client.exec('DROP TRIGGER fail_terminal_write');
        seatInbox!.stop();
        await seatInbox!.idle();
        expect(receipts.get(first.messageId)?.status).toBe('delivered');
        expect(receipts.get(second.messageId)?.status).toBe('failed');
        expect((seatInbox as unknown as { count: number }).count).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        return;
      }
      if (scenario === 'stop-late') {
        seatInbox!.stop();
        await seatInbox!.idle(); // Must not wait forever for the held old runtime.
        const stoppedWrites = writes.mock.calls.length;
        seatInbox!.stop();
        expect(writes.mock.calls.length).toBe(stoppedWrites);
        expect((seatInbox as unknown as { count: number }).count).toBe(0);
        // Messaging teardown leaves the independently owned live-turn presence interval alone.
        expect(triggers.claimed.get(key)?.aside).toBe(true);
        expect(vi.getTimerCount()).toBe(1);
        await triggers.halt(harness.store.getRoom(roomId)!);
        expect(vi.getTimerCount()).toBe(0);
        harness.db.$client.exec('DROP TRIGGER fail_terminal_write');
        const recovered = harness.service.createSeatMessages(receipts, () => undefined);
        expect(receipts.get(first.messageId)?.status).toBe('failed');
        expect(receipts.get(second.messageId)?.status).toBe('failed');
        recovered.stop();
        harness.db.$client.close();
        finish!();
        await vi.advanceTimersByTimeAsync(0);
        expect(writes.mock.calls.length).toBe(stoppedWrites);
        expect((seatInbox as unknown as { count: number }).count).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        return;
      }
      harness.db.$client.exec('DROP TRIGGER fail_terminal_write');
      await vi.advanceTimersByTimeAsync(30_000);
      await seatInbox!.idle();
      expect(receipts.get(first.messageId)?.status).toBe(
        scenario === 'expiry' ? 'failed' : 'delivered'
      );
      expect(receipts.get(second.messageId)?.status).toBe('failed');
      expect((seatInbox as unknown as { count: number }).count).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(attempts).toBe(scenario === 'expiry' ? 0 : 1);
    } finally {
      if (harness.db.$client.open)
        harness.db.$client.exec('DROP TRIGGER IF EXISTS fail_terminal_write');
      seatInbox!.stop();
      finish?.();
      await seatInbox!.idle();
    }
  }
);

describe('batch target checks (DOR-4722)', () => {
  /** Only `target` and `unsolicited` fed the old per-item answer; nothing else is read. */
  function item(target: SeatMessagePending['target'], unsolicited: boolean): SeatMessagePending {
    return { target, unsolicited } as SeatMessagePending;
  }
  function batchOf(targets: SeatMessagePending['target'][], unsolicited = true) {
    return targets.map((target) => item(target, unsolicited));
  }
  function core(): RoomCore {
    return (harness.service as unknown as { parts: { core: RoomCore } }).parts.core;
  }
  /** The per-item check the batch check replaced, kept as the oracle it must match exactly. */
  function perItem(batch: readonly SeatMessagePending[]): boolean {
    return batch.every(
      (item) =>
        currentSeatMessageTarget(core(), item.target) !== null &&
        (!item.unsolicited || core().bridges.findBridgeByRoom(item.target.roomId) === null)
    );
  }
  function bridgeRoom(): void {
    harness.bridges.createBridge({
      roomId,
      adapterId: 'batch-bridge',
      chatId: 'batch-chat',
      channelType: 'group',
      platformChatType: 'group',
      bindingId: 'batch-binding',
      platformTitle: null,
      deliverNotices: true,
      createdAt: new Date().toISOString(),
    });
  }

  it('M9: a batch sharing one seat reads that seat and its room once', () => {
    const target = seatInbox!.resolveSeatTarget('seat-chat')!;
    const ledger = vi.spyOn(core().store.sessionLedger, 'bindingForSession');
    const bridges = vi.spyOn(core().bridges, 'findBridgeByRoom');
    const batch = batchOf(Array<SeatMessagePending['target']>(8).fill(target));
    expect(seatBatchStillCurrent(core(), batch)).toBe(true);
    expect(ledger).toHaveBeenCalledTimes(1);
    // Once inside the seat check, once for the unsolicited bridge refusal.
    expect(bridges).toHaveBeenCalledTimes(2);
  });

  it('M9: one stale seat among current ones still refuses the whole batch', () => {
    const target = seatInbox!.resolveSeatTarget('seat-chat')!;
    const stale = { ...target, joinedAt: '2000-01-01T00:00:00.000Z' };
    expect(seatBatchStillCurrent(core(), batchOf([target, target, stale, target]))).toBe(false);
    expect(seatBatchStillCurrent(core(), batchOf([target, target], false))).toBe(true);
  });

  it('M9: two queued messages to one seat both refuse once it leaves and rejoins', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-15T12:00:00Z'));
    const before = harness.store.getMember(roomId, bo)!;
    const target = seatInbox!.resolveSeatTarget('seat-chat')!;
    const blocker = harness.service.postNotice(roomId, { text: 'Seat busy marker.' });
    // Hold the seat through the real claim map so both messages wait in one batch.
    const triggers = (harness.service as unknown as { triggers: { claimed: Map<string, unknown> } })
      .triggers;
    triggers.claimed.set(agentKey(roomId, bo), {
      roomId,
      authorId: bo,
      sessionId: 'seat-chat',
      agentPath: '/agents/bo',
      entryId: blocker.id,
    });
    const first = await chats.send(caller, { to: 'seat-chat', message: 'queued one' });
    const second = await chats.send(caller, { to: 'seat-chat', message: 'queued two' });
    expect(seatBatchStillCurrent(core(), batchOf([target, target]))).toBe(true);
    harness.store.removeMember(roomId, bo);
    const rejoinedAt = '2026-11-15T12:00:05.000Z';
    harness.store.addMember({
      roomId,
      authorId: bo,
      responseMode: before.responseMode,
      joinedAt: rejoinedAt,
    });
    harness.store.bindRoomSession(roomId, bo, 'rejoined-seat', rejoinedAt);
    for (const unsolicited of [true, false]) {
      const batch = batchOf([target, target], unsolicited);
      expect(seatBatchStillCurrent(core(), batch)).toBe(false);
      expect(perItem(batch)).toBe(false);
    }
    triggers.claimed.clear();
    await vi.advanceTimersByTimeAsync(30_000);
    await seatInbox?.idle();
    expect(turns).toHaveLength(0);
    for (const receipt of [first, second]) {
      expect(receipts.get(receipt.messageId)).toMatchObject({
        status: 'failed',
        failureReason: expect.stringContaining('NOT_ALLOWED'),
      });
    }
  });

  it('M9: a bridged room gives a mixed unsolicited and solicited batch the old answer', () => {
    const unbridged = seatInbox!.resolveSeatTarget('seat-chat')!;
    bridgeRoom();
    const bridged = seatInbox!.resolveSeatTarget('seat-chat')!;
    expect(bridged.bridgeOwnership).toBeDefined();
    // Same seat, a foreign bridge: the key must keep ownership apart from the real one.
    const forged = { ...bridged, bridgeOwnership: { ...bridged.bridgeOwnership!, chatId: 'x' } };
    const batches: SeatMessagePending[][] = [];
    for (const target of [unbridged, bridged]) {
      batches.push(
        [item(target, false), item(target, true)],
        [item(target, true), item(target, false)],
        [item(target, false), item(target, false)],
        [item(target, true), item(target, true)]
      );
    }
    batches.push(
      [item(bridged, false), item(forged, false)],
      [item(unbridged, false), item(bridged, false), item(forged, true)]
    );
    const oracle = batches.map(perItem);
    // Not vacuous: the old logic refuses some of these batches and runs others.
    expect(new Set(oracle)).toEqual(new Set([true, false]));
    expect(batches.map((batch) => seatBatchStillCurrent(core(), batch))).toEqual(oracle);
    // Any unsolicited item in the now-bridged room refuses; solicited-only still runs.
    expect(seatBatchStillCurrent(core(), [item(bridged, false), item(unbridged, true)])).toBe(
      false
    );
    expect(seatBatchStillCurrent(core(), [item(unbridged, false), item(bridged, false)])).toBe(
      true
    );
    expect(seatBatchStillCurrent(core(), [item(bridged, false), item(forged, false)])).toBe(false);
  });

  // Every field currentSeatMessageTarget compares. A field missing from seatTargetKey would
  // let the stale copy share the real target's key and skip its own check.
  const comparedFields: [
    string,
    (t: SeatMessagePending['target']) => SeatMessagePending['target'],
  ][] = [
    ['sessionId', (t) => ({ ...t, sessionId: 'not-a-seat' })],
    ['roomId', (t) => ({ ...t, roomId: 'other-room' })],
    ['authorId', (t) => ({ ...t, authorId: 'other-author' })],
    ['joinedAt', (t) => ({ ...t, joinedAt: '2000-01-01T00:00:00.000Z' })],
    ['agentPath', (t) => ({ ...t, agentPath: '/agents/other' })],
    [
      'bridgeOwnership.bindingId',
      (t) => ({ ...t, bridgeOwnership: { ...t.bridgeOwnership!, bindingId: 'x' } }),
    ],
    [
      'bridgeOwnership.adapterId',
      (t) => ({ ...t, bridgeOwnership: { ...t.bridgeOwnership!, adapterId: 'x' } }),
    ],
    [
      'bridgeOwnership.chatId',
      (t) => ({ ...t, bridgeOwnership: { ...t.bridgeOwnership!, chatId: 'x' } }),
    ],
  ];

  it.each(comparedFields)(
    'M9: a stale %s behind a current target refuses, matching the per-item answer',
    (_field, mutate) => {
      bridgeRoom();
      const real = seatInbox!.resolveSeatTarget('seat-chat')!;
      expect(real.bridgeOwnership).toBeDefined();
      // Solicited items, so the bridged room's unsolicited refusal cannot mask the seat check.
      const batch = [item(real, false), item(mutate(real), false)];
      expect(perItem(batch)).toBe(false);
      expect(seatBatchStillCurrent(core(), batch)).toBe(perItem(batch));
      expect(seatBatchStillCurrent(core(), [item(real, false), item(real, false)])).toBe(true);
    }
  );
});
