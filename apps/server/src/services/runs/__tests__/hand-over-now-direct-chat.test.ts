/**
 * DOR-5512 (spec `turns-survive-restarts` §3.5, §8 F35): messages sent to an
 * agent while its new direct chat waits to open join that chat, in order,
 * instead of each opening another. Driven through the chat-message service
 * over the real run record, computer face, launch path and dispatcher; only
 * the runtime is a double.
 */
import { describe, expect, it, vi } from 'vitest';
import { sessionBirthAllocations, sessionMessageQueue, sessionMetadata } from '@dorkos/db';
import type { TurnPermissionLevel } from '@dorkos/shared/agent-runtime';
import { MACHINE_FULL_NOTE } from '../../session/chat-messages/sending/chat-turn-hand-over.js';
import { CHAT_NOT_OPENED_REASON } from '../../session/chat-messages/sending/direct-chat-opening.js';
import { uninstallRunRecord } from '../index.js';
import {
  AGENT,
  SENDER,
  answered,
  chatMessaging,
  chats,
  clock,
  db,
  fillMachine,
  freeMachine,
  installRecord,
  launched,
  messages,
  pass,
  record,
  releases,
  slots,
  useHandOverNow,
} from './hand-over-now.fixture.js';

useHandOverNow();

/** The run a receipt's message rides on. */
const runOf = (messageId: string): string => messages.get(messageId)!.queueMessageId!;

/** The chats the launch path bound, by id. */
const bornChats = (): string[] =>
  db
    .select()
    .from(sessionMetadata)
    .all()
    .map((row) => row.sessionId);

/** Let the first message's turn start, then hand over what joined its chat. */
async function openFirst(firstRun: string): Promise<void> {
  await freeMachine();
  await vi.waitFor(() => expect(record.store.get(firstRun)?.status).toBe('running'));
  await pass();
}

/** End the running turn and wait for the next one to start. */
async function endTurn(expectAnswered: number): Promise<void> {
  releases.shift()!();
  await vi.waitFor(() => expect(answered).toHaveLength(expectAnswered));
}

describe('messages to an agent before its new direct chat opens join that chat (F35)', () => {
  it.each([2, 3])('%i messages at a full machine open one chat, and run in order', async (n) => {
    // Purpose: fails if a later message opens a chat of its own, or starts ahead of the first.
    fillMachine();
    const service = chatMessaging();
    const receipts = [];
    for (let i = 1; i <= n; i++) {
      receipts.push(await service.send(SENDER, { to: AGENT.id, message: `part ${i}` }));
    }
    const chatId = receipts[0]!.chatId;
    expect(receipts.map((r) => r.chatId)).toEqual(receipts.map(() => chatId));
    expect(receipts.map((r) => r.position)).toEqual(receipts.map((_, i) => i + 1));
    for (const receipt of receipts) {
      expect(receipt).toMatchObject({ status: 'queued', note: MACHINE_FULL_NOTE });
    }
    expect(db.select().from(sessionBirthAllocations).all()).toHaveLength(1);
    expect(record.view(chatId).map((run) => run.queuePosition)).toEqual(
      receipts.map((_, i) => i + 1)
    );
    expect(launched).toEqual([]);

    await openFirst(runOf(receipts[0]!.messageId));
    chats.push(chatId);
    expect(answered).toEqual([expect.stringContaining('part 1')]);
    expect(bornChats()).toEqual([chatId]);
    // The later ones queue behind the running first, as their sender, in the order sent.
    expect(db.select().from(sessionMessageQueue).all()).toEqual(
      receipts.slice(1).map((r) =>
        expect.objectContaining({
          id: runOf(r.messageId),
          sessionId: chatId,
          clientId: `chat:${SENDER.sessionId}`,
        })
      )
    );
    for (let i = 2; i <= n; i++) {
      await endTurn(i);
      expect(answered[i - 1]).toContain(`part ${i}`);
    }
    expect(bornChats()).toEqual([chatId]);
  });

  it('a message after a restart still joins the chat that waits to open', async () => {
    // Purpose: fails if what marks a chat as waiting to open lives only in memory.
    fillMachine();
    const first = chatMessaging();
    const opening = await first.send(SENDER, { to: AGENT.id, message: 'before the restart' });
    first.stop();
    uninstallRunRecord();
    installRecord();
    const service = chatMessaging();
    await service.startTurns();
    const later = await service.send(SENDER, { to: AGENT.id, message: 'after the restart' });
    expect(later).toMatchObject({ chatId: opening.chatId, status: 'queued', position: 2 });

    await openFirst(runOf(opening.messageId));
    chats.push(opening.chatId);
    await endTurn(2);
    expect(answered[0]).toContain('before the restart');
    expect(answered[1]).toContain('after the restart');
    expect(bornChats()).toEqual([opening.chatId]);
  });
  it('a message sent the moment a slot frees still waits behind the first', async () => {
    // Purpose: fails if a joined message takes the free slot and starts before its chat is born.
    fillMachine();
    const service = chatMessaging();
    const first = await service.send(SENDER, { to: AGENT.id, message: 'the opener' });
    for (const release of slots.splice(0)) release();
    const second = await service.send(SENDER, { to: AGENT.id, message: 'right behind' });
    expect(second).toMatchObject({ chatId: first.chatId, status: 'queued', position: 2 });
    expect(launched).toEqual([]);

    await openFirst(runOf(first.messageId));
    chats.push(first.chatId);
    expect(launched.map((opts) => opts.runId)).toEqual([
      runOf(first.messageId),
      runOf(second.messageId),
    ]);
    await endTurn(2);
    expect(answered[0]).toContain('the opener');
    expect(answered[1]).toContain('right behind');
  });

  it('a joined message backing off is handed over the moment the first starts', async () => {
    // Purpose: fails if a joined message waits out its own backoff once its chat is open.
    fillMachine();
    const service = chatMessaging();
    const first = await service.send(SENDER, { to: AGENT.id, message: 'opener' });
    const second = await service.send(SENDER, { to: AGENT.id, message: 'follower' });
    await pass();
    // A long wait already behind it: only the first's start can make it due again.
    record.effects.reopenStartOf(runOf(second.messageId), clock + 600_000);

    await openFirst(runOf(first.messageId));
    chats.push(first.chatId);
    expect(db.select().from(sessionMessageQueue).all()).toEqual([
      expect.objectContaining({ id: runOf(second.messageId), sessionId: first.chatId }),
    ]);
  });

  it('a message sent to the waiting chat by its id joins it too', async () => {
    // Purpose: fails if a send naming the chat the sender was told is refused while it waits.
    fillMachine();
    const service = chatMessaging();
    const opening = await service.send(SENDER, { to: AGENT.id, message: 'by agent' });
    const byId = await service.send(SENDER, { to: opening.chatId, message: 'by chat id' });
    expect(byId).toMatchObject({ chatId: opening.chatId, status: 'queued', position: 2 });
    expect(db.select().from(sessionBirthAllocations).all()).toHaveLength(1);
  });
});

describe('trust parity: a message that joins a waiting chat keeps its own sender', () => {
  it('runs as its own chat, with its own level, never the first sender’s', async () => {
    // Purpose: fails if a joined message rides on the first message's run, identity or level.
    const other = { ...SENDER, sessionId: '7d1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6' };
    const level: TurnPermissionLevel = {
      asks: 'never',
      reach: 'everything',
      teammate: [{ roomId: 'room-1', authorId: 'author-1' }],
    };
    fillMachine();
    const service = chatMessaging({
      turnLevelOf: (id) => (id === other.sessionId ? level : undefined),
    });
    const a = await service.send(SENDER, { to: AGENT.id, message: 'from the first chat' });
    const b = await service.send(other, { to: AGENT.id, message: 'from the second chat' });
    expect(b.chatId).toBe(a.chatId);
    const [runA, runB] = [runOf(a.messageId), runOf(b.messageId)];
    expect(record.store.get(runA)?.askedByRef).toBe(`dork:chat:${SENDER.sessionId}`);
    expect(record.store.get(runB)?.askedByRef).toBe(`dork:chat:${other.sessionId}`);
    // Each run's level is read from its own receipt alone.
    expect(messages.listByQueueMessage(runB).map((row) => row.id)).toEqual([b.messageId]);
    expect(service.ceilingForQueuedMessage(runA)).toBeUndefined();
    expect(service.ceilingForQueuedMessage(runB)).toEqual([
      expect.objectContaining({ teammate: level.teammate }),
    ]);

    await openFirst(runA);
    chats.push(a.chatId);
    expect(launched.map((opts) => [opts.runId, opts.clientId])).toEqual([
      [runA, `chat:${SENDER.sessionId}`],
      [runB, `chat:${other.sessionId}`],
    ]);
    // Only the first carries the new chat's birth record; the joined one takes no slot.
    expect(launched[0]!.freshDmBirth).toMatchObject({ receiptId: a.messageId });
    expect(launched[1]).toMatchObject({ messageId: runB, countsTowardLaunchCap: false });
    expect(launched[1]!.freshDmBirth).toBeUndefined();
    expect(launched[1]!.permissionCeiling).toBeUndefined();
  });
});

describe('a chat that waits to open, stopped or never opened', () => {
  it('chat_stop takes back the first message and every one that joined it', async () => {
    // Purpose: fails if a stop leaves a joined message waiting, or can't reach the waiting chat.
    fillMachine();
    const service = chatMessaging();
    const sent = [];
    for (const message of ['one', 'two', 'three']) {
      sent.push(await service.send(SENDER, { to: AGENT.id, message }));
    }
    await service.stopChat(SENDER, { chat: sent[0]!.chatId });
    for (const receipt of sent) {
      expect(messages.get(receipt.messageId)).toMatchObject({
        status: 'failed',
        failureReason: expect.stringContaining('before it ran'),
      });
      expect(record.store.get(runOf(receipt.messageId))).toMatchObject({ status: 'cancelled' });
    }
    await freeMachine();
    expect(answered).toEqual([]);
    // The next message opens a new chat rather than waiting on the stopped one.
    const next = await service.send(SENDER, { to: AGENT.id, message: 'fresh start' });
    expect(next.chatId).not.toBe(sent[0]!.chatId);
    await vi.waitFor(() => expect(answered).toEqual([expect.stringContaining('fresh start')]));
    chats.push(next.chatId);
  });

  it('when the first message never starts, the ones that joined it fail and say why', async () => {
    // Purpose: fails if the first's cancel strands the later messages on a chat never born.
    fillMachine();
    const service = chatMessaging();
    const first = await service.send(SENDER, { to: AGENT.id, message: 'first' });
    const joined = await service.send(SENDER, { to: AGENT.id, message: 'joined' });
    record.starts.cancel(runOf(first.messageId), 'start_failed');
    expect(record.store.get(runOf(joined.messageId))).toMatchObject({
      status: 'cancelled',
      endingDetail: expect.objectContaining({ cancelledBecause: 'chat_not_opened' }),
    });
    await vi.waitFor(() =>
      expect(messages.get(joined.messageId)).toMatchObject({
        status: 'failed',
        failureReason: CHAT_NOT_OPENED_REASON,
      })
    );
    await freeMachine();
    expect(answered).toEqual([]);
    expect(launched).toEqual([]);
  });
});
