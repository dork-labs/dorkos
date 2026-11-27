/**
 * DOR-5301: a plain private note to a busy room chat is delivered or refused within the
 * two-minute window a hand-off gets (DOR-4252), and the refusal says what to do, in the sending
 * chat. An answer to the room chat's own question keeps the long wait, because that chat asked.
 */
import { expect, it, vi } from 'vitest';
import { agentKey } from '../../room-claims.js';
import type { RoomTriggerDispatcher } from '../../room-trigger.js';

import {
  bo,
  caller,
  chats,
  harness,
  receipts,
  roomId,
  seatInbox,
  setSeatInbox,
  turns,
  useSeatMessageRoom,
} from './seat-messages.fixtures.js';

useSeatMessageRoom();

const WINDOW_MS = 2 * 60_000;
const NOTE_REASON = 'Bo stayed busy for two minutes. Send it again later.';
const ANSWER_REASON = 'Bo stayed busy for an hour. Send it again later.';

/** The room's dispatcher, reached as the other seat-message suites reach it. */
function triggers(): RoomTriggerDispatcher {
  return (harness.service as unknown as { triggers: RoomTriggerDispatcher }).triggers;
}

/**
 * Hold Bo's room chat busy through the real claim map, as its own room turn would.
 *
 * @returns Ends that turn: drops the claim and wakes every waiter, as a finished turn does.
 */
function holdSeat(): () => void {
  const claim = {
    roomId,
    authorId: bo,
    sessionId: 'seat-chat',
    agentPath: '/agents/bo',
    entryId: 'held-entry',
    claimedAt: new Date().toISOString(),
    dispatchId: 'held',
    depth: 0,
    aside: false,
  };
  const dispatcher = triggers() as unknown as {
    claimed: Map<string, unknown>;
    releaseWaiters: Set<(claim: unknown) => void>;
  };
  dispatcher.claimed.set(agentKey(roomId, bo), claim);
  return () => {
    dispatcher.claimed.delete(agentKey(roomId, bo));
    for (const waiter of [...dispatcher.releaseWaiters]) waiter(claim);
  };
}

/** The question Bo's room chat sent Ana privately, which Ana's answer replies to. */
function boAsksAna(id = 'bo-question'): void {
  receipts.insert({
    id,
    toSessionId: caller.sessionId,
    fromSessionId: 'seat-chat',
    fromAgentPath: '/agents/bo',
    fromAgentId: 'agent-bo',
    fromAgentName: 'Bo',
    fromChatTitle: null,
    kind: 'message',
    text: 'Which branch has the release fix?',
    summary: null,
    nonce: '00000000',
    delivery: 'queue',
    status: 'delivered',
    queueMessageId: null,
    ceilingJson: '"none"',
    replyToId: null,
  });
}

it('a plain note to a room chat busy with its own turn fails at two minutes, and the sending chat hears why', async () => {
  vi.useFakeTimers();
  const told: string[] = [];
  seatInbox!.stop();
  setSeatInbox(harness.service.createSeatMessages(receipts, (id) => told.push(id)));
  holdSeat();
  const receipt = await chats.send(caller, {
    to: 'seat-chat',
    message: 'Can you check the build?',
  });

  await vi.advanceTimersByTimeAsync(WINDOW_MS - 1_000);
  expect(receipts.get(receipt.messageId)?.status).toBe('queued');
  told.length = 0;

  // A settled receipt is written at once; no idle wait, so a note still waiting fails here.
  await vi.advanceTimersByTimeAsync(1_001);
  expect(receipts.get(receipt.messageId)).toMatchObject({
    status: 'failed',
    failureReason: NOTE_REASON,
  });
  expect(told).toContain(caller.sessionId);
  const { sent } = await chats.activityOf(caller.sessionId);
  expect(sent.find((card) => card.id === receipt.messageId)?.failureReason).toBe(NOTE_REASON);
  expect(turns).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
});

it('an answer to the room chat’s own question waits out a five-minute turn and is delivered', async () => {
  vi.useFakeTimers();
  boAsksAna();
  const endTurn = holdSeat();
  const answer = await chats.send(caller, {
    to: 'seat-chat',
    message: 'The fix is on release/next.',
    replyTo: 'bo-question',
  });
  const note = await chats.send(caller, { to: 'seat-chat', message: 'Also, lunch at noon?' });

  // The plain note beside it still gets only the two minutes.
  await vi.advanceTimersByTimeAsync(WINDOW_MS + 1);
  expect(receipts.get(note.messageId)).toMatchObject({
    status: 'failed',
    failureReason: NOTE_REASON,
  });
  expect(receipts.get(answer.messageId)?.status).toBe('queued');

  await vi.advanceTimersByTimeAsync(5 * 60_000 - WINDOW_MS - 1);
  expect(receipts.get(answer.messageId)?.status).toBe('queued');
  endTurn();
  await vi.advanceTimersByTimeAsync(0);
  await seatInbox!.idle();
  expect(receipts.get(answer.messageId)?.status).toBe('delivered');
  expect(receipts.get('bo-question')?.status).toBe('replied');
  expect(turns).toHaveLength(1);
  expect(turns[0]!.prompt).toContain('The fix is on release/next.');
  expect(turns[0]!.prompt).not.toContain('lunch at noon');
});

it('an answer whose room chat stays busy for the hour fails with copy that says an hour', async () => {
  vi.useFakeTimers();
  boAsksAna();
  holdSeat();
  const answer = await chats.send(caller, {
    to: 'seat-chat',
    message: 'The fix is on release/next.',
    replyTo: 'bo-question',
  });
  await vi.advanceTimersByTimeAsync(WINDOW_MS + 1);
  expect(receipts.get(answer.messageId)?.status).toBe('queued');
  await vi.advanceTimersByTimeAsync(60 * 60_000 - WINDOW_MS);
  expect(receipts.get(answer.messageId)).toMatchObject({
    status: 'failed',
    failureReason: ANSWER_REASON,
  });
});

it('a note the runtime keeps refusing as busy gets its last try just before two minutes, then fails', async () => {
  vi.useFakeTimers();
  const start = Date.now();
  const tries: number[] = [];
  // The runtime refuses the claimed chat as busy every time, as it does while background work runs.
  triggers().deps.runner.run = async (request) => {
    turns.push(request);
    tries.push(Date.now() - start);
    return { sessionId: request.sessionId!, text: null, unanswered: 'busy' };
  };
  const receipt = await chats.send(caller, { to: 'seat-chat', message: 'Is the deploy done?' });

  await vi.advanceTimersByTimeAsync(WINDOW_MS + 30_000);
  // Every 30 seconds, then once a second before the deadline.
  expect(tries).toEqual([0, 30_000, 60_000, 90_000, 119_000]);
  expect(receipts.get(receipt.messageId)).toMatchObject({
    status: 'failed',
    failureReason: NOTE_REASON,
  });
});

it('a note whose runtime frees at 95 seconds, with no release signal, is delivered', async () => {
  vi.useFakeTimers();
  const start = Date.now();
  triggers().deps.runner.run = async (request) => {
    turns.push(request);
    if (Date.now() - start < 95_000)
      return { sessionId: request.sessionId!, text: null, unanswered: 'busy' };
    return { sessionId: request.sessionId!, text: null };
  };
  const receipt = await chats.send(caller, { to: 'seat-chat', message: 'Is the deploy done?' });

  await vi.advanceTimersByTimeAsync(WINDOW_MS + 30_000);
  expect(receipts.get(receipt.messageId)?.status).toBe('delivered');
});

it('a plain note queued behind an answer still gets its last try, so a runtime freed at 115 seconds takes both', async () => {
  vi.useFakeTimers();
  boAsksAna();
  const start = Date.now();
  const tries: number[] = [];
  triggers().deps.runner.run = async (request) => {
    turns.push(request);
    tries.push(Date.now() - start);
    if (Date.now() - start < 115_000)
      return { sessionId: request.sessionId!, text: null, unanswered: 'busy' };
    return { sessionId: request.sessionId!, text: null };
  };
  const answer = await chats.send(caller, {
    to: 'seat-chat',
    message: 'The fix is on release/next.',
    replyTo: 'bo-question',
  });
  const note = await chats.send(caller, { to: 'seat-chat', message: 'Also, lunch at noon?' });

  await vi.advanceTimersByTimeAsync(WINDOW_MS + 30_000);
  // The rechecks follow the note's deadline, the earliest in line, not the answer's.
  expect(tries.at(-1)).toBe(119_000);
  expect(receipts.get(answer.messageId)?.status).toBe('delivered');
  expect(receipts.get(note.messageId)?.status).toBe('delivered');
});
