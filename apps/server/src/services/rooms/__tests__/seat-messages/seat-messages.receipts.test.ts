import { ROOM_RECEIPT_EMOJI, type RoomEntry } from '@dorkos/shared/room-schemas';
import { isRoomStartAnchor } from '../../room-trigger/room-start-anchor.js';
/**
 * DOR-4472 class proof: peer writes must enter a scoped, bounded, marked private
 * aside, never ordinary session dispatch or an automatic public body post.
 */
import { describe, expect, it, vi } from 'vitest';
import { agentKey, deepestClaimOf } from '../../room-claims.js';
import type { RoomTriggerDispatcher } from '../../room-trigger.js';
import type { RoomTurnRequest } from '../../room-turn-port.js';
import { roomSpec } from '../room-test-harness.js';

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
  unboundAliases,
  useSeatMessageRoom,
} from './seat-messages.fixtures.js';

useSeatMessageRoom();

describe('seat receipt ownership and reply classification', () => {
  function askRow(id = 'seat-ask') {
    return receipts.insert({
      id,
      toSessionId: caller.sessionId,
      fromSessionId: 'seat-chat',
      fromAgentPath: '/agents/bo',
      fromAgentId: 'agent-bo',
      fromAgentName: 'Bo',
      fromChatTitle: null,
      kind: 'message',
      text: 'Check this privately.',
      summary: null,
      nonce: '00000000',
      delivery: 'queue',
      status: 'delivered',
      queueMessageId: null,
      ceilingJson: '"none"',
      replyToId: null,
    });
  }

  it('DOR-4621: an empty-room private answer uses the room start and keeps a later ask receipt', async () => {
    askRow();
    expect(harness.store.listEntries(roomId, { limit: 100 })).toEqual([]);
    const { triggers } = harness.service as unknown as { triggers: RoomTriggerDispatcher };
    let asked: RoomEntry | undefined;
    const seen: string[][] = [];
    triggers.deps.runner.run = async (request) => {
      if (!request.sessionId) throw new Error('Seat runner requires a bound session');
      request.onSessionBound(request.sessionId);
      turns.push(request);
      if (turns.length === 1) {
        harness.runner.sayInRoom(request, 'The private answer is ready.');
        expect(harness.runner.refusals).toEqual([]);
        asked = harness.service.post(roomId, {
          authorId: harness.human,
          text: '@bo is the answer ready?',
        });
      } else {
        expect(request.entry.id).toBe(asked?.id);
        seen.push(
          harness.service
            .reactionsFor(roomId, asked!.id)
            .filter((pill) => pill.emoji === ROOM_RECEIPT_EMOJI)
            .flatMap((pill) => pill.authorIds ?? [])
        );
      }
      return { text: null, sessionId: request.sessionId };
    };
    const receipt = await chats.send(caller, {
      to: 'seat-chat',
      message: 'The answer, privately.',
      replyTo: 'seat-ask',
    });
    await seatInbox!.idle();
    await harness.service.triggersIdle();
    expect(receipts.get(receipt.messageId)?.status).toBe('delivered');
    expect(turns).toHaveLength(2);
    expect(asked).toBeDefined();
    // The private turn's end must not clear the 👀 on a message that arrived during it.
    expect(seen).toEqual([[bo]]);
    expect(isRoomStartAnchor(turns[0]!.entry.id)).toBe(true);
    expect(turns[0]!.entry.seq).toBe(0);
    expect(turns[0]!.entry.cascadeRoot).toBe(roomId);
    const posts = harness.store.listEntries(roomId, { limit: 100 });
    const reply = posts.find((entry) => entry.authorId === bo && entry.kind === 'post');
    expect(reply).toBeDefined();
    // The post answers nothing stored, so it names no entry the room never had.
    expect(reply?.body.answersEntryId).toBeUndefined();
    expect(JSON.stringify(posts)).not.toContain('The answer, privately.');
    expect(posts.some((entry) => entry.id === receipt.messageId)).toBe(false);
  });

  it('Code M3/M8: a delivered answer consumes its ask; reusing it produces one notice', async () => {
    askRow();
    const first = await chats.send(caller, {
      to: 'seat-chat',
      message: 'First answer',
      replyTo: 'seat-ask',
    });
    await seatInbox!.idle();
    expect(receipts.get(first.messageId)?.status).toBe('delivered');
    const second = await chats.send(caller, {
      to: 'seat-chat',
      message: 'A new private ask',
      replyTo: 'seat-ask',
    });
    await seatInbox!.idle();
    expect(receipts.get(second.messageId)).toMatchObject({ status: 'delivered', replyToId: null });
    expect(
      harness.store
        .listEntries(roomId, { limit: 100 })
        .filter((e) => e.kind === 'notice' && e.body.text.includes('a private message'))
    ).toHaveLength(1);
  });

  it.each([
    { kind: 'report' as const, status: 'delivered' as const },
    { kind: 'message' as const, status: 'queued' as const },
  ])(
    'Code M3: $kind/$status is not an active ask and cannot suppress notice',
    async ({ kind, status }) => {
      const template = askRow('template-ask');
      receipts.insert({ ...template, id: 'inactive-ask', kind, status });
      const sent = await chats.send(caller, {
        to: 'seat-chat',
        message: 'A new private ask',
        replyTo: 'inactive-ask',
      });
      await seatInbox!.idle();
      expect(receipts.get(sent.messageId)?.replyToId).toBeNull();
      expect(
        harness.store
          .listEntries(roomId, { limit: 100 })
          .filter((e) => e.body.text.includes('a private message'))
      ).toHaveLength(1);
    }
  );

  it('Code M8: two queued answers reserve one ask and create exactly one notice', async () => {
    askRow();
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
      const first = await chats.send(caller, {
        to: 'seat-chat',
        message: 'First queued answer',
        replyTo: 'seat-ask',
      });
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
      const second = await chats.send(caller, {
        to: 'seat-chat',
        message: 'Second queued answer',
        replyTo: 'seat-ask',
      });
      expect(
        harness.store
          .listEntries(roomId, { limit: 100 })
          .filter((e) => e.body.text.includes('a private message'))
      ).toHaveLength(1);
      expect(receipts.get(first.messageId)?.replyToId).toBe('seat-ask');
      expect(receipts.get(second.messageId)?.replyToId).toBeNull();
      expect(receipts.get('seat-ask')?.status).toBe('delivered');
    } finally {
      seatInbox!.stop();
      for (const done of deferredFinishes) done();
      await seatInbox!.idle();
    }
  });

  it('Code M3: a recovered failed answer cannot mark its ask from a late completion', async () => {
    askRow();
    const { triggers } = harness.service as unknown as { triggers: RoomTriggerDispatcher };
    let finish!: () => void;
    triggers.deps.runner.run = async (request) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
        deferredFinishes.add(resolve);
      });
      if (!request.sessionId) throw new Error('Seat runner requires a bound session');
      return { text: null, sessionId: request.sessionId };
    };
    try {
      const answer = await chats.send(caller, {
        to: 'seat-chat',
        message: 'Interrupted answer',
        replyTo: 'seat-ask',
      });
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
      expect(seatInbox!.recoverInterrupted()).toBe(1);
      finish();
      await seatInbox!.idle();
      expect(receipts.get(answer.messageId)?.status).toBe('failed');
      expect(receipts.get('seat-ask')?.status).toBe('delivered');
    } finally {
      finish?.();
    }
  });

  it('Code M3: a thrown ask update rolls back delivery and retains its terminal intent', async () => {
    askRow();
    harness.db.$client.exec(
      "CREATE TRIGGER refuse_ask_reply BEFORE UPDATE OF status ON chat_messages WHEN NEW.id='seat-ask' AND NEW.status='replied' BEGIN SELECT RAISE(ABORT, 'ask update unavailable'); END"
    );
    const writes = vi.spyOn(receipts, 'updatePendingSeatMessage');
    try {
      const answer = await chats.send(caller, {
        to: 'seat-chat',
        message: 'Atomic answer',
        replyTo: 'seat-ask',
      });
      await vi.waitFor(() =>
        expect(
          writes.mock.calls.some(
            ([id, patch]) => id === answer.messageId && patch.status === 'delivered'
          )
        ).toBe(true)
      );
      expect(receipts.get(answer.messageId)?.status).toBe('working');
      expect(receipts.get('seat-ask')?.status).toBe('delivered');
      harness.db.$client.exec('DROP TRIGGER refuse_ask_reply');
      seatInbox!.stop();
      await seatInbox!.idle();
      expect(receipts.get(answer.messageId)?.status).toBe('delivered');
      expect(receipts.get('seat-ask')?.status).toBe('replied');
    } finally {
      harness.db.$client.exec('DROP TRIGGER IF EXISTS refuse_ask_reply');
      seatInbox!.stop();
      await seatInbox!.idle();
    }
  });

  it('Code M3: delivered answers notify the original ask sender across native aliases', async () => {
    askRow();
    harness.store.sessionLedger.rebindBySessionId('seat-chat', 'native-canonical');
    seatInbox!.stop();
    const notify = vi.fn();
    setSeatInbox(harness.service.createSeatMessages(receipts, notify));
    const { triggers } = harness.service as unknown as { triggers: RoomTriggerDispatcher };
    triggers.deps.runner.run = async (request) => {
      notify.mockClear();
      if (!request.sessionId) throw new Error('Seat runner requires a bound session');
      return { text: null, sessionId: request.sessionId };
    };
    const answer = await chats.send(caller, {
      to: 'native-canonical',
      message: 'Answer after a native rename',
      replyTo: 'seat-ask',
    });
    await seatInbox!.idle();
    expect(receipts.get(answer.messageId)?.status).toBe('delivered');
    expect(receipts.get('seat-ask')?.status).toBe('replied');
    expect(notify).toHaveBeenCalledWith('seat-chat');
  });

  it('Code M3: a failed private answer leaves the actual ask unanswered', async () => {
    askRow();
    const { triggers } = harness.service as unknown as { triggers: RoomTriggerDispatcher };
    triggers.deps.runner.run = async (request) => {
      if (!request.sessionId) throw new Error('Seat runner requires a bound session');
      return { text: null, sessionId: request.sessionId, unanswered: 'failed' };
    };
    const answer = await chats.send(caller, {
      to: 'seat-chat',
      message: 'Never delivered',
      replyTo: 'seat-ask',
    });
    await seatInbox!.idle();
    expect(receipts.get(answer.messageId)?.status).toBe('failed');
    expect(receipts.get('seat-ask')?.status).toBe('delivered');
    expect(receipts.latestUnansweredFromAliases(['seat-chat'], caller.sessionId)?.id).toBe(
      'seat-ask'
    );
  });

  it.each(['wrong-seat', 'wrong-recipient'] as const)(
    'Code M3: existing %s reply id is NOT_ALLOWED',
    async (bad) => {
      const template = askRow('template-ask');
      const other = harness.service.createRoom(
        roomSpec('channel', 'Other seat', ['/agents/bo']),
        harness.human
      );
      harness.store.bindRoomSession(other.id, bo, 'other-seat', new Date().toISOString());
      receipts.insert({
        ...template,
        id: bad,
        ...(bad === 'wrong-seat'
          ? { fromSessionId: 'other-seat' }
          : { toSessionId: 'another-chat' }),
      });
      await expect(
        chats.send(caller, { to: 'seat-chat', message: 'Forged answer', replyTo: bad })
      ).rejects.toMatchObject({ code: 'NOT_ALLOWED' });
      expect(turns).toHaveLength(0);
      expect(harness.store.listEntries(roomId, { limit: 100 })).toHaveLength(0);
    }
  );

  it('M3/M8: a valid answer has no notice and marks only its actual ask replied', async () => {
    askRow();
    expect(harness.store.listEntries(roomId, { limit: 100 })).toHaveLength(0);
    const cursor = harness.store.getMember(roomId, bo)?.lastReadSeq;
    const { triggers } = harness.service as unknown as { triggers: RoomTriggerDispatcher };
    triggers.deps.runner.run = async (request) => {
      turns.push(request);
      expect(triggers.claimed.get(agentKey(roomId, bo))?.aside).toBe(true);
      expect(deepestClaimOf(triggers.claimed, bo)).toBeUndefined();
      return { text: null, sessionId: request.sessionId! };
    };
    const receipt = await chats.send(caller, {
      to: 'seat-chat',
      message: 'Private answer.',
      replyTo: 'seat-ask',
    });
    await seatInbox?.idle();
    expect(receipts.get('seat-ask')?.status).toBe('replied');
    expect(receipts.get(receipt.messageId)).toMatchObject({
      status: 'delivered',
      failureReason: null,
    });
    expect(turns).toHaveLength(1);
    expect(turns[0]?.roomContext.triggerEntryId).toBeNull();
    expect(harness.store.getMember(roomId, bo)?.lastReadSeq).toBe(cursor);
    expect(harness.store.listEntries(roomId, { limit: 100 })).toHaveLength(0);
    expect(
      harness.store
        .listEntries(roomId, { limit: 100 })
        .filter((e) => e.body.text.includes('a private message'))
    ).toHaveLength(0);
  });

  it('M3: native session retirement preserves the admitted room seat', async () => {
    harness.store.sessionLedger.rebindBySessionId('seat-chat', 'native-canonical');
    unboundAliases.add('seat-chat');
    const receipt = await chats.send(caller, {
      to: 'seat-chat',
      message: 'Native id changes are still the same seat.',
    });
    await seatInbox?.idle();
    expect(turns).toHaveLength(1);
    expect(turns[0]?.sessionId).toBe('native-canonical');
    expect(receipts.get(receipt.messageId)?.status).toBe('delivered');
  });

  it('M9: shutdown owns terminal status even if a deferred aside later completes', async () => {
    let finish: (() => void) | undefined;
    // The runtime runner is an external port, not a mock of the inbox or its own module.
    const runner = (
      harness.service as unknown as {
        triggers: { deps: { runner: { run: (request: RoomTurnRequest) => Promise<unknown> } } };
      }
    ).triggers.deps.runner;
    runner.run = async (request) => {
      turns.push(request);
      await new Promise<void>((resolve) => {
        finish = resolve;
        deferredFinishes.add(resolve);
      });
      return { text: null, sessionId: request.sessionId };
    };
    const receipt = await chats.send(caller, { to: 'seat-chat', message: 'Will complete later.' });
    for (let n = 0; n < 20 && !finish; n++) await Promise.resolve();
    expect(finish).toBeTypeOf('function');
    seatInbox?.stop();
    expect(receipts.get(receipt.messageId)?.status).toBe('failed');
    finish!();
    await seatInbox?.idle();
    expect(receipts.get(receipt.messageId)?.status).toBe('failed');
  });

  it('M8: committed admission remains accepted when event publication fails', async () => {
    // Room subscribers can throw after the transaction; that cannot undo a committed send.
    const realPublish = harness.service.stream.publish.bind(harness.service.stream);
    const publish = vi.spyOn(harness.service.stream, 'publish').mockImplementation((id, event) => {
      if (event.type === 'entry' && event.entry.body.text.includes('a private message'))
        throw new Error('subscriber gone');
      realPublish(id, event);
    });
    const receipt = await chats.send(caller, { to: 'seat-chat', message: 'Committed safely.' });
    publish.mockRestore();
    await seatInbox?.idle();
    expect(receipts.get(receipt.messageId)?.status).toBe('delivered');
    expect(
      harness.store
        .listEntries(roomId, { limit: 100 })
        .filter((e) => e.body.text.includes('a private message'))
    ).toHaveLength(1);
  });

  it('M6: writing a seat does not grant stopping that seat', async () => {
    await expect(chats.stopChat(caller, { chat: 'seat-chat' })).rejects.toMatchObject({
      code: 'NOT_ALLOWED',
    });
  });
});
