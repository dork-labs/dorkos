/**
 * DOR-4472 class proof: peer writes must enter a scoped, bounded, marked private
 * aside, never ordinary session dispatch or an automatic public body post.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatMessageService } from '../../../session/chat-messages/chat-message-service.js';
import { agentKey } from '../../room-claims.js';
import type { RoomTriggerDispatcher } from '../../room-trigger.js';

import {
  bo,
  caller,
  chats,
  deps,
  harness,
  receipts,
  roomId,
  seatInbox,
  turns,
  useSeatMessageRoom,
} from './seat-messages.fixtures.js';

useSeatMessageRoom();

describe('DOR-4547: who may send a seat a private message', () => {
  const anaSeat = { sessionId: 'ana-seat', agentPath: '/agents/ana' };
  const boSeat = { sessionId: 'seat-chat', agentPath: '/agents/bo' };
  const cySeat = { sessionId: 'cy-seat', agentPath: '/agents/cy' };
  const seatOwners: Record<string, string> = {
    'ana-seat': '/agents/ana',
    'cy-seat': '/agents/cy',
  };
  let ana: string;
  let seatChats: ChatMessageService;

  beforeEach(() => {
    ana = harness.authors.resolveAgent('/agents/ana', 'Ana').id;
    harness.store.bindRoomSession(roomId, ana, 'ana-seat', new Date().toISOString());
    const cy = harness.authors.resolveAgent('/agents/cy', 'Cy').id;
    const joinedAt = new Date().toISOString();
    harness.store.addMember({ roomId, authorId: cy, responseMode: 'mention-only', joinedAt });
    harness.store.bindRoomSession(roomId, cy, 'cy-seat', joinedAt);
    // Each seat chat belongs to its own agent, so either seat can write to the other.
    seatChats = new ChatMessageService({
      ...deps,
      describeSession: async (id) => ({
        bound: true,
        roomBound: true,
        launchOrigin: 'room',
        agentPath: seatOwners[id] ?? '/agents/bo',
        startedByExtension: null,
      }),
    });
  });

  afterEach(() => seatChats.stop());

  function boAsks(id: string) {
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

  const notices = () =>
    harness.store
      .listEntries(roomId, { limit: 100 })
      .filter((e) => e.body.text.includes('a private message'));

  /** Hold Bo's seat busy through the real claim map, so messages wait in its queue. */
  function holdBoBusy(): RoomTriggerDispatcher {
    const blocker = harness.service.postNotice(roomId, { text: 'Seat busy marker.' });
    const { triggers } = harness.service as unknown as { triggers: RoomTriggerDispatcher };
    (triggers as unknown as { claimed: Map<string, unknown> }).claimed.set(agentKey(roomId, bo), {
      roomId,
      authorId: bo,
      sessionId: 'seat-chat',
      agentPath: '/agents/bo',
      entryId: blocker.id,
    });
    return triggers;
  }
  function releaseBo(triggers: RoomTriggerDispatcher): void {
    (triggers as unknown as { claimed: Map<string, unknown> }).claimed.clear();
  }

  it('a member can start one; once she leaves the room she can only answer', async () => {
    const member = await chats.send(caller, { to: 'seat-chat', message: 'From a member' });
    await seatInbox!.idle();
    expect(receipts.get(member.messageId)?.status).toBe('delivered');
    expect(turns).toHaveLength(1);
    expect(notices()).toHaveLength(1);

    harness.store.removeMember(roomId, ana);
    await expect(
      chats.send(caller, { to: 'seat-chat', message: 'From outside the room' })
    ).rejects.toMatchObject({
      code: 'NOT_ALLOWED',
      message: "Only room members can start a private note here. Send to the agent's id instead.",
    });
    expect(turns).toHaveLength(1);
    expect(notices()).toHaveLength(1);

    // Naming an ask that already has its answer starts nothing either, and says why.
    boAsks('replied-ask');
    receipts.update('replied-ask', { status: 'replied' });
    await expect(
      chats.send(caller, { to: 'seat-chat', message: 'Late answer', replyTo: 'replied-ask' })
    ).rejects.toMatchObject({
      code: 'NOT_ALLOWED',
      message: 'That message already has an answer. Only room members can start a new one.',
    });
    expect(turns).toHaveLength(1);

    // An answer to what the seat itself asked still lands, member or not (D1).
    boAsks('bo-ask');
    const answer = await chats.send(caller, {
      to: 'seat-chat',
      message: 'The answer',
      replyTo: 'bo-ask',
    });
    await seatInbox!.idle();
    expect(receipts.get(answer.messageId)).toMatchObject({
      status: 'delivered',
      replyToId: 'bo-ask',
    });
    expect(turns).toHaveLength(2);
  });

  it('two seats cannot keep writing to each other: the answer lands, the reply to it stops', async () => {
    const { triggers } = harness.service as unknown as { triggers: RoomTriggerDispatcher };
    const sent: { from: string; id: string }[] = [];
    const refused: { from: string; code: unknown; message: string }[] = [];
    let quiet = false;
    const write = async (from: typeof anaSeat, to: string, message: string) => {
      try {
        const receipt = await seatChats.send(from, { to, message });
        sent.push({ from: from.sessionId, id: receipt.messageId });
      } catch (error) {
        const { code, message: why } = error as { code: unknown; message: string };
        refused.push({ from: from.sessionId, code, message: why });
      }
    };
    triggers.deps.runner.run = async (request) => {
      if (!request.sessionId) throw new Error('Seat runner requires a bound session');
      turns.push(request);
      // A safety stop, so the unguarded loop ends the test instead of hanging it.
      if (!quiet && turns.length <= 6) {
        const me = request.sessionId === 'ana-seat' ? anaSeat : boSeat;
        const other = me === anaSeat ? 'seat-chat' : 'ana-seat';
        await write(me, other, `${me.sessionId} writes back`);
        // A second, fresh note in the same turn is the other half of the loop.
        if (me === boSeat) await write(me, other, 'And one more thing');
      }
      return { text: null, sessionId: request.sessionId };
    };

    const first = await seatChats.send(anaSeat, {
      to: 'seat-chat',
      message: 'Is the build green?',
    });
    await seatInbox!.idle();

    expect(turns.map((t) => t.sessionId)).toEqual(['seat-chat', 'ana-seat']);
    // Bo's answer to Ana's question lands (D1)...
    expect(sent).toHaveLength(1);
    expect(receipts.get(sent[0]!.id)).toMatchObject({
      status: 'delivered',
      replyToId: first.messageId,
    });
    // ...but neither Bo's fresh note nor Ana's reply to the answer starts another turn.
    // The two turns overlap, so the refusals may arrive in either order.
    const over = {
      code: 'NOT_ALLOWED',
      message: 'That answer ended this exchange. End your turn, or post in your room.',
    };
    expect(refused).toHaveLength(2);
    expect(refused).toEqual(
      expect.arrayContaining([
        { from: 'seat-chat', ...over },
        { from: 'ana-seat', ...over },
      ])
    );

    // The answer says it needs no private reply; the question it answered does not.
    expect(turns[1]!.prompt).toContain('It needs no private reply.');
    expect(turns[0]!.prompt).not.toContain('It needs no private reply.');

    // The guard lasts only for the turn: from a later turn, Ana can write to Bo again.
    quiet = true;
    const later = await seatChats.send(anaSeat, { to: 'seat-chat', message: 'One more question' });
    await seatInbox!.idle();
    expect(receipts.get(later.messageId)?.status).toBe('delivered');
    expect(turns).toHaveLength(3);
  });

  it('a reserved answer from a non-member says its message already has an answer', async () => {
    harness.store.removeMember(roomId, ana);
    boAsks('bo-ask');
    vi.useFakeTimers();
    const triggers = holdBoBusy();
    const first = await chats.send(caller, {
      to: 'seat-chat',
      message: 'First answer',
      replyTo: 'bo-ask',
    });
    await expect(
      chats.send(caller, { to: 'seat-chat', message: 'Second answer', replyTo: 'bo-ask' })
    ).rejects.toMatchObject({
      code: 'NOT_ALLOWED',
      message: 'That message already has an answer. Only room members can start a new one.',
    });
    releaseBo(triggers);
    await vi.advanceTimersByTimeAsync(30_000);
    await seatInbox!.idle();
    expect(receipts.get(first.messageId)?.status).toBe('delivered');
  });

  it('a sender who leaves the room before the seat is free loses only its own note', async () => {
    vi.useFakeTimers();
    const triggers = holdBoBusy();
    const fromAna = await seatChats.send(anaSeat, { to: 'seat-chat', message: 'ANA_NOTE' });
    const fromCy = await seatChats.send(cySeat, { to: 'seat-chat', message: 'CY_NOTE' });
    harness.store.removeMember(roomId, ana);
    releaseBo(triggers);
    await vi.advanceTimersByTimeAsync(30_000);
    await seatInbox!.idle();
    expect(turns).toHaveLength(1);
    expect(turns[0]!.prompt).toContain('CY_NOTE');
    expect(turns[0]!.prompt).not.toContain('ANA_NOTE');
    expect(receipts.get(fromCy.messageId)?.status).toBe('delivered');
    expect(receipts.get(fromAna.messageId)).toMatchObject({
      status: 'failed',
      failureReason: 'NOT_ALLOWED: The sender left the room.',
    });
  });

  it("a seat running on one seat's note can still start a note to a third seat", async () => {
    const { triggers } = harness.service as unknown as { triggers: RoomTriggerDispatcher };
    let toCy: string | undefined;
    triggers.deps.runner.run = async (request) => {
      if (!request.sessionId) throw new Error('Seat runner requires a bound session');
      turns.push(request);
      if (request.sessionId === 'seat-chat') {
        toCy = (await seatChats.send(boSeat, { to: 'cy-seat', message: 'Cy, can you look?' }))
          .messageId;
      }
      return { text: null, sessionId: request.sessionId };
    };
    await seatChats.send(anaSeat, { to: 'seat-chat', message: 'Is the build green?' });
    await seatInbox!.idle();
    expect(turns.map((t) => t.sessionId)).toEqual(['seat-chat', 'cy-seat']);
    expect(receipts.get(toCy!)).toMatchObject({ status: 'delivered', replyToId: null });
  });
});
