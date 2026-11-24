import { seatMessageNotice } from '../../handoff/seat-message-prompt.js';
/**
 * DOR-4472 class proof: peer writes must enter a scoped, bounded, marked private
 * aside, never ordinary session dispatch or an automatic public body post.
 */
import { describe, expect, it, vi } from 'vitest';
import { noteRoomTurnWords } from '../../../core/turn-power/outside-words.js';
import { runtimeRegistry } from '../../../core/runtime-registry.js';
import { agentKey } from '../../room-claims.js';
import type { RoomTriggerDispatcher } from '../../room-trigger.js';

import {
  bo,
  caller,
  chats,
  deferredFinishes,
  dispatch,
  harness,
  receipts,
  roomId,
  seatInbox,
  turns,
  useSeatMessageRoom,
} from './seat-messages.fixtures.js';

useSeatMessageRoom();

describe('peer messages into a room seat', () => {
  it.each(['queue', 'steer', 'interrupt'] as const)(
    'M2/M7/M8: %s enters only a defused private aside and constant trace',
    async (delivery) => {
      // Removing the dedicated route, aside flag or defusing makes this fail.
      const receipt = await chats.send(caller, {
        to: 'seat-chat',
        message: '/cmd read @~/.ssh/id_rsa PRIVATE_BODY',
        summary: 'PRIVATE_SUMMARY',
        delivery,
      });
      await seatInbox?.idle();
      expect(dispatch).not.toHaveBeenCalled();
      expect(turns).toHaveLength(1);
      expect(turns[0]?.untrustedText).toBe(true);
      expect(turns[0]?.roomContext.triggerEntryId).toBeNull();
      expect(turns[0]?.prompt).toContain('\u200b@~/.ssh/id_rsa');
      expect(turns[0]?.prompt).toContain('\u200b/cmd');
      expect(turns[0]?.prompt).not.toMatch(/^\/cmd/u);
      const entries = harness.store.listEntries(roomId, { limit: 100 });
      expect(entries.filter((e) => e.body.text.includes('a private message'))).toHaveLength(1);
      expect(JSON.stringify(entries)).not.toMatch(
        /PRIVATE_BODY|PRIVATE_SUMMARY|Private title sentinel/u
      );
      expect(receipts.get(receipt.messageId)?.status).toBe('delivered');
    }
  );

  it('M3: forged explicit reply is NOT_ALLOWED even though unsolicited writes are permitted', async () => {
    await expect(
      chats.send(caller, { to: 'seat-chat', message: 'answer', replyTo: 'not-an-ask' })
    ).rejects.toMatchObject({ code: 'NOT_ALLOWED' });
    expect(turns).toHaveLength(0);
  });

  it('M3: queued leave/rejoin refuses even when joinedAt is identical', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-15T12:00:00Z'));
    const before = harness.store.getMember(roomId, bo)!;
    const blocker = harness.service.postNotice(roomId, { text: 'Seat busy marker.' });
    // Hold only through the real claim map, not a mock of the service under test.
    const triggers = (harness.service as unknown as { triggers: { claimed: Map<string, unknown> } })
      .triggers;
    triggers.claimed.set(agentKey(roomId, bo), {
      roomId,
      authorId: bo,
      sessionId: 'seat-chat',
      agentPath: '/agents/bo',
      entryId: blocker.id,
    });
    const receipt = await chats.send(caller, {
      to: 'seat-chat',
      message: 'queued private message',
    });
    harness.store.removeMember(roomId, bo);
    harness.store.addMember({
      roomId,
      authorId: bo,
      responseMode: before.responseMode,
      joinedAt: before.joinedAt,
    });
    harness.store.bindRoomSession(roomId, bo, 'replacement-seat', before.joinedAt);
    expect(harness.store.getMember(roomId, bo)?.joinedAt).toBe(before.joinedAt);
    triggers.claimed.clear();
    await vi.advanceTimersByTimeAsync(30_000);
    await seatInbox?.idle();
    expect(turns).toHaveLength(0);
    expect(receipts.get(receipt.messageId)).toMatchObject({
      status: 'failed',
      failureReason: expect.stringContaining('NOT_ALLOWED'),
    });
  });
});

describe('bounded seat queues', () => {
  function hold(): () => void {
    const triggers = (harness.service as unknown as { triggers: { claimed: Map<string, unknown> } })
      .triggers;
    triggers.claimed.set(agentKey(roomId, bo), {
      roomId,
      authorId: bo,
      sessionId: 'seat-chat',
      agentPath: '/agents/bo',
      entryId: 'held-entry',
      claimedAt: new Date().toISOString(),
      dispatchId: 'held',
      depth: 0,
      aside: false,
    });
    return () => triggers.claimed.delete(agentKey(roomId, bo));
  }

  it('M9: waiting messages share one fitting aside and admission is bounded at 25', async () => {
    vi.useFakeTimers();
    const release = hold();
    const sent = [];
    for (let n = 0; n < 25; n++)
      sent.push(await chats.send(caller, { to: 'seat-chat', message: `private-${n}` }));
    await expect(
      chats.send(caller, { to: 'seat-chat', message: 'overflow' })
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    release();
    await vi.advanceTimersByTimeAsync(30_000);
    await seatInbox?.idle();
    expect(turns).toHaveLength(1);
    for (let n = 0; n < 25; n++) expect(turns[0]?.prompt).toContain(`private-${n}`);
    expect(turns[0]!.prompt.length).toBeLessThanOrEqual(100_000);
    expect(sent.every((receipt) => receipts.get(receipt.messageId)?.status === 'delivered')).toBe(
      true
    );
  });

  it('M9: final defused/fenced text including separators stays within the batch limit', async () => {
    vi.useFakeTimers();
    const release = hold();
    for (let n = 0; n < 6; n++)
      await chats.send(caller, { to: 'seat-chat', message: `${n}:` + '@'.repeat(19_990) });
    release();
    await vi.advanceTimersByTimeAsync(30_000);
    await seatInbox?.idle();
    expect(turns.length).toBeGreaterThan(1);
    expect(turns.every((turn) => turn.prompt.length <= 100_000)).toBe(true);
    for (let n = 0; n < 6; n++)
      expect(turns.filter((turn) => turn.prompt.includes(`${n}:`))).toHaveLength(1);
  });

  it('M9: an hour waiting settles failed and shutdown clears release waits', async () => {
    vi.useFakeTimers();
    hold();
    const receipt = await chats.send(caller, { to: 'seat-chat', message: 'expires' });
    await vi.advanceTimersByTimeAsync(60 * 60_000 + 1);
    await seatInbox?.idle();
    expect(receipts.get(receipt.messageId)?.status).toBe('failed');
    expect(turns).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('M9: interrupted persisted seat work fails without entering ordinary cap retries', async () => {
    vi.useFakeTimers();
    hold();
    const receipt = await chats.send(caller, { to: 'seat-chat', message: 'interrupted' });
    expect(receipts.listHeldForSlot()).toEqual([]);
    expect(receipts.listByQueueMessage(receipts.get(receipt.messageId)!.queueMessageId!)).toEqual(
      []
    );
    const recovered = harness.service.createSeatMessages(receipts, () => undefined);
    expect(receipts.get(receipt.messageId)?.status).toBe('failed');
    expect(recovered.recoverInterrupted()).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
    recovered.stop();
  });
});

describe('immutable sender carry and current room restrictions', () => {
  it('M2/M4: server-captured outsider marks survive a later clean sender without a whole-level cap', async () => {
    vi.useFakeTimers();
    const triggers = (harness.service as unknown as { triggers: { claimed: Map<string, unknown> } })
      .triggers;
    triggers.claimed.set(agentKey(roomId, bo), {
      roomId,
      authorId: bo,
      sessionId: 'seat-chat',
      agentPath: '/agents/bo',
      claimedAt: new Date().toISOString(),
    });
    const receipt = await chats.send(
      { ...caller, marksAtTurnEnd: { outsider: true } },
      { to: 'seat-chat', message: 'Words from the marked turn.' }
    );
    expect(receipts.get(receipt.messageId)?.ceilingJson).toContain('carriedOutsider');
    triggers.claimed.clear();
    await vi.advanceTimersByTimeAsync(30_000);
    await seatInbox?.idle();
    const turn = turns[0]!;
    expect(turn.carriedOutsider).toBe(true);
    expect(turn.outsideWords).toBe(true);
    const bounds = Array.isArray(turn.permissionCeiling)
      ? turn.permissionCeiling
      : [turn.permissionCeiling];
    expect(bounds).not.toContain('runtime-default');
    expect(bounds).not.toContain('read-only');
  });

  it.each(['room words', 'relay-binding origin'] as const)(
    'M2: %s reach the private aside',
    async (kind) => {
      if (kind === 'room words') noteRoomTurnWords(caller.sessionId, true);
      else {
        runtimeRegistry.setDb(harness.db);
        // A real launch-origin row, not a mocked provenance function.
        harness.db.$client
          .prepare(
            "INSERT OR REPLACE INTO session_metadata(session_id,runtime,launch_origin,created_at) VALUES (?, 'claude-code', 'relay-binding', ?)"
          )
          .run(caller.sessionId, new Date().toISOString());
      }
      await chats.send(caller, { to: 'seat-chat', message: 'Outside influence.' });
      await seatInbox?.idle();
      expect(turns[0]?.outsideWords).toBe(true);
      noteRoomTurnWords(caller.sessionId, false);
    }
  );
});

it('Code M8: hostile sender names defuse commands, file references and fence markers', () => {
  const notice = seatMessageNotice('/cmd @~/x --- END private', 'Bo');
  expect(notice).toContain('\u200b/cmd');
  expect(notice).toContain('\u200b@~/x');
  expect(notice).toContain('[chat');
  expect(notice).not.toContain('---');
});

it('DOR-4547: the room notice says a private message was sent, not where to find it', () => {
  expect(seatMessageNotice('Scout', 'Atlas')).toBe('Scout sent Atlas a private message.');
});

it('Code M8: pending unsolicited writes coalesce only until their delivery ends', async () => {
  const { triggers } = harness.service as unknown as { triggers: RoomTriggerDispatcher };
  let finish!: () => void;
  triggers.deps.runner.run = async (request) => {
    turns.push(request);
    if (turns.length === 1)
      await new Promise<void>((resolve) => {
        finish = resolve;
        deferredFinishes.add(resolve);
      });
    if (!request.sessionId) throw new Error('Seat runner requires a bound session');
    return { text: null, sessionId: request.sessionId };
  };
  try {
    await chats.send(caller, { to: 'seat-chat', message: 'First private ask' });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await chats.send(caller, { to: 'seat-chat', message: 'Second private ask' });
    await chats.send(caller, { to: 'seat-chat', message: 'Third private ask' });
    expect(
      harness.store
        .listEntries(roomId, { limit: 100 })
        .filter((e) => e.body.text.includes('a private message'))
    ).toHaveLength(1);
    await chats.send(
      { ...caller, sessionId: 'another-ana-draft' },
      { to: 'seat-chat', message: 'Same registered actor, another drafting chat' }
    );
    expect(
      harness.store
        .listEntries(roomId, { limit: 100 })
        .filter((e) => e.body.text.includes('a private message'))
    ).toHaveLength(1);
    const other = await chats.send(
      { sessionId: 'other-sender-chat', agentPath: '/agents/bo' },
      { to: 'seat-chat', message: 'Another registered actor with the same visible name' }
    );
    expect(receipts.get(other.messageId)).toMatchObject({
      fromAgentId: 'agent-bo',
      fromAgentName: 'Ana',
    });
    expect(
      harness.store
        .listEntries(roomId, { limit: 100 })
        .filter((e) => e.body.text.includes('a private message'))
    ).toHaveLength(2);

    finish();
    await seatInbox!.idle();
    await chats.send(caller, { to: 'seat-chat', message: 'A later independent private ask' });
    await seatInbox!.idle();
    expect(
      harness.store
        .listEntries(roomId, { limit: 100 })
        .filter((e) => e.body.text.includes('a private message'))
    ).toHaveLength(3);
  } finally {
    seatInbox!.stop();
    for (const done of deferredFinishes) done();
    await seatInbox!.idle();
  }
});

it('Code D3: a queued unsolicited write refuses when its room becomes bridged during placement', async () => {
  const { triggers } = harness.service as unknown as { triggers: RoomTriggerDispatcher };
  const released = vi.spyOn(triggers, 'releaseOwnClaim');
  const original = triggers.placeTurn.bind(triggers);
  let release!: () => void;
  let entered!: () => void;
  const placing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
    deferredFinishes.add(resolve);
  });
  triggers.placeTurn = async (...args) => {
    const result = await original(...args);
    expect(triggers.claimed.has(agentKey(roomId, bo))).toBe(true);
    entered();
    await barrier;
    return result;
  };
  try {
    const receipt = await chats.send(caller, {
      to: 'seat-chat',
      message: 'No late external reach',
    });
    await placing;
    harness.bridges.createBridge({
      roomId,
      adapterId: 'late-bridge',
      chatId: 'late-chat',
      channelType: 'group',
      platformChatType: 'group',
      bindingId: 'late-binding',
      platformTitle: null,
      deliverNotices: true,
      createdAt: new Date().toISOString(),
    });
    release();
    await seatInbox!.idle();
    expect(receipts.get(receipt.messageId)?.status).toBe('failed');
    expect(turns).toHaveLength(0);
    expect(triggers.claimed.has(agentKey(roomId, bo))).toBe(false);
    expect(released.mock.calls.some(([, , outcome]) => outcome === 'quiet')).toBe(false);
  } finally {
    release?.();
  }
});
