/**
 * T6b (DOR-5503, spec `turns-survive-restarts` §3.5, §8 F32 to F34): a chat
 * message (`chat_send`) starts its turn through the turn port, driven here
 * through the chat-message service itself. A busy machine makes it wait with
 * its place, its words kept in its receipt across a restart, where it used to
 * be refused (a new chat) or held by chat messaging (a chat that exists).
 *
 * The parity cases hold the trust the direct call gave a chat message: the
 * launch path is handed the sender's identity, the receipt's queue row, the
 * new chat's birth record, and nothing the direct call never carried.
 */
import { describe, expect, it, vi } from 'vitest';
import { eq, sessionBirthAllocations, sessionMessageQueue, sessionMetadata } from '@dorkos/db';
import { MACHINE_FULL_NOTE } from '../../session/chat-messages/sending/chat-turn-hand-over.js';
import { uninstallRunRecord } from '../index.js';
import {
  AGENT,
  PARENT,
  SENDER,
  answered,
  chat,
  chatMessaging,
  chats,
  db,
  fillMachine,
  freeMachine,
  installRecord,
  launched,
  messages,
  record,
  useHandOverNow,
} from './hand-over-now.fixture.js';

useHandOverNow();

describe('a busy machine makes a chat message wait, with its place shown', () => {
  it('a chat message opening a new direct chat at a full machine waits, then opens it', async () => {
    // Purpose: fails if LAUNCH_CAP_FULL refuses a chat message's new chat again, or its wait is unseen.
    fillMachine();
    const receipt = await chatMessaging().send(SENDER, { to: AGENT.id, message: 'a fresh hello' });
    chats.push(receipt.chatId);
    expect(receipt).toMatchObject({ status: 'queued', position: 1, note: MACHINE_FULL_NOTE });
    expect(record.view(receipt.chatId)).toEqual([
      expect.objectContaining({ status: 'queued', waitReason: 'machine_full', queuePosition: 1 }),
    ]);
    expect(launched).toEqual([]);
    // Its reservation is kept while it waits, and the chat is not born yet.
    expect(db.select().from(sessionBirthAllocations).all()).toHaveLength(1);

    await freeMachine();
    await vi.waitFor(() => expect(answered).toEqual([expect.stringContaining('a fresh hello')]));
    const runId = messages.get(receipt.messageId)!.queueMessageId!;
    expect(record.store.get(runId)).toMatchObject({ status: 'running', waitReason: null });
    expect(
      db.select().from(sessionMetadata).where(eq(sessionMetadata.sessionId, receipt.chatId)).get()
    ).toMatchObject({ agentPath: AGENT.home, launchOrigin: 'chat-message' });
  });
  it('a chat message to an idle chat at a full machine waits as a run, then starts', async () => {
    // Purpose: fails if chat messaging holds the message outside the port again (its old cap hold).
    fillMachine();
    const target = chat();
    const receipt = await chatMessaging().send(SENDER, { to: target, message: 'when you can' });
    expect(receipt).toMatchObject({ status: 'queued', chatId: target, note: MACHINE_FULL_NOTE });
    expect(record.view(target)).toEqual([
      expect.objectContaining({ status: 'queued', waitReason: 'machine_full', queuePosition: 1 }),
    ]);

    await freeMachine();
    await vi.waitFor(() => expect(answered).toEqual([expect.stringContaining('when you can')]));
    await vi.waitFor(() => expect(messages.get(receipt.messageId)?.status).toBe('working'));
  });
  it('a chat message waiting for a slot keeps its words across a restart', async () => {
    // Purpose: fails if a waiting chat message's words live only in memory (the DOR-5505 case).
    fillMachine();
    const target = chat();
    const first = chatMessaging();
    const receipt = await first.send(SENDER, { to: target, message: 'still here after it' });
    first.stop();
    // A new process: a new run record and chat messaging over the same stores.
    uninstallRunRecord();
    installRecord();
    await chatMessaging().startTurns();

    await freeMachine();
    await vi.waitFor(() =>
      expect(answered).toEqual([expect.stringContaining('still here after it')])
    );
    expect(messages.get(receipt.messageId)?.status).not.toBe('failed');
  });
  it('a message an earlier version held for a slot starts through the port at boot', async () => {
    // Purpose: fails if an upgrade strands what the old cap hold kept (a queued row with no queue id).
    const target = chat();
    const held = messages.insert({
      id: crypto.randomUUID(),
      toSessionId: target,
      fromSessionId: SENDER.sessionId,
      fromAgentPath: SENDER.agentPath,
      fromAgentId: null,
      fromAgentName: 'Ana',
      fromChatTitle: null,
      kind: 'message',
      text: 'held before the upgrade',
      summary: null,
      nonce: '0a1b2c3d4e5f6a7b',
      delivery: 'queue',
      status: 'queued',
      queueMessageId: null,
      ceilingJson: JSON.stringify('runtime-default'),
      replyToId: null,
    });
    await chatMessaging().startTurns();
    await freeMachine();
    await vi.waitFor(() =>
      expect(answered).toEqual([expect.stringContaining('held before the upgrade')])
    );
    expect(launched[0]).toMatchObject({ clientId: `chat:${SENDER.sessionId}` });
    expect(messages.listHeldForSlot()).toEqual([]);
    expect(messages.get(held.id)?.queueMessageId).toBe(launched[0]!.runId);
  });
  it('stopping a chat takes back the chat messages still waiting for a slot there', async () => {
    fillMachine();
    const target = chat();
    const service = chatMessaging();
    const receipt = await service.send(SENDER, { to: target, message: 'never mind' });
    const runId = messages.get(receipt.messageId)!.queueMessageId!;

    await service.stopChat(SENDER, { chat: target });
    expect(messages.get(receipt.messageId)).toMatchObject({ status: 'failed' });
    expect(record.store.get(runId)).toMatchObject({ status: 'cancelled' });
    await freeMachine();
    expect(answered).toEqual([]);
  });
});

describe('trust parity: a chat message crosses the port with what the direct call carried', () => {
  it('a chat message opening a new direct chat hands the launch path exactly what the direct call did', async () => {
    // Purpose: fails if a chat message loosens through the port: its sender's identity, the queue
    // row its sender's level rides on, its birth record, or a level, mark, launcher or watcher
    // the direct call never carried.
    const receipt = await chatMessaging().send(SENDER, { to: AGENT.id, message: 'parity' });
    chats.push(receipt.chatId);
    const row = messages.get(receipt.messageId)!;
    const [opts] = launched;
    expect(opts).toMatchObject({
      sessionId: row.toSessionId,
      origin: { kind: 'chat-message' },
      clientId: `chat:${SENDER.sessionId}`,
      messageId: row.queueMessageId,
      countsTowardLaunchCap: true,
    });
    expect(opts!.request).toEqual({
      content: expect.stringContaining('parity'),
      agentPath: AGENT.home,
    });
    expect(opts!.freshDmBirth).toEqual({
      kind: 'chat-message',
      delivery: 'live-fresh',
      allocationCreatedAt: row.createdAt,
      receiptId: row.id,
      queueMessageId: row.queueMessageId,
      fromSessionId: SENDER.sessionId,
      fromAgentPath: SENDER.agentPath,
      targetAgent: { id: AGENT.id, path: AGENT.home },
    });
    for (const never of [
      'permissionCeiling',
      'carriedMarks',
      'continuationHold',
      'launcher',
      'unattended',
      'workspaceCaller',
      'personChatSource',
      'wordsAtSource',
    ] as const) {
      expect(opts![never]).toBeUndefined();
    }
    expect(opts!.turnOptions).toEqual({});
    expect(record.store.get(row.queueMessageId!)?.askedByRef).toBe(`dork:chat:${SENDER.sessionId}`);
  });
  it('a chat message into a running chat queues behind it as its sender, taking no slot', async () => {
    const target = chat();
    const service = chatMessaging();
    await service.send(SENDER, { to: target, message: 'first' });
    await vi.waitFor(() => expect(answered).toHaveLength(1));
    const receipt = await service.send(SENDER, { to: target, message: 'second' });
    const row = messages.get(receipt.messageId)!;
    expect(receipt).toMatchObject({ status: 'queued', position: 1 });
    expect(launched[1]).toMatchObject({
      messageId: row.queueMessageId,
      countsTowardLaunchCap: false,
    });
    expect(db.select().from(sessionMessageQueue).all()).toEqual([
      expect.objectContaining({ id: row.queueMessageId, clientId: `chat:${SENDER.sessionId}` }),
    ]);
  });
  it('opens a direct chat only for a chat message, and only from the chat that sent it', async () => {
    const birth = {
      receiptId: 'receipt-1',
      fromSessionId: SENDER.sessionId,
      fromAgentPath: SENDER.agentPath,
      allocationCreatedAt: new Date().toISOString(),
      targetAgent: { id: AGENT.id, path: AGENT.home },
    };
    const base = { content: 'x', tier: 'owner' as const, agentId: AGENT.id, newDirectChat: birth };
    await expect(
      record.handOver({
        ...base,
        sessionId: chat(),
        origin: { kind: 'chat-message' },
        askedByRef: `dork:chat:${PARENT}`,
      })
    ).rejects.toThrow(/only by the chat that sent/u);
    await expect(
      record.handOver({ ...base, sessionId: chat(), origin: { kind: 'agent-launch' } })
    ).rejects.toThrow(/Only a chat message/u);
    expect(launched).toEqual([]);
  });
});
