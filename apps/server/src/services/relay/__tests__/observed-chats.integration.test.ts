/**
 * A chat a connection has carried shows up in its observed chats (DOR-2590).
 *
 * The chat picker in the binding dialog and the "last message" line on a bound
 * connection both read `TraceStore.getObservedChats`. That query used to look
 * for `adapterId` and `chatId` in each span's metadata — two fields no writer
 * ever put there — so the list was empty for every connection, however much
 * traffic it carried. The chat is named in the span's SUBJECT, which the
 * publish pipeline records on every message.
 *
 * Driven through the real `RelayCore` publish and the real `TraceStore` over an
 * in-memory database: seeding the store by hand is exactly how the old tests
 * passed while production stayed empty, because they seeded the metadata shape
 * nothing writes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RelayCore } from '@dorkos/relay';
import { createTestDb } from '@dorkos/test-utils/db';
import { TraceStore } from '../trace-store.js';

describe('observed chats come from the messages a connection carried', () => {
  let dataDir: string;
  let relay: RelayCore;
  let traces: TraceStore;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-observed-chats-'));
    traces = new TraceStore(createTestDb());
    relay = new RelayCore({ dataDir, traceStore: traces });
    // The binding router listens on every human subject in the running server.
    relay.subscribe('relay.human.>', () => {});
  });

  afterEach(async () => {
    await relay.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('lists a Telegram DM and a group chat that messaged the connection', async () => {
    // Published exactly the way the Telegram adapter publishes an inbound message.
    await relay.publish(
      'relay.human.telegram.tg-main.12345',
      { content: 'hi', senderName: 'Alice', channelType: 'dm' },
      { from: 'relay.human.telegram.tg-main.bot', replyTo: 'relay.human.telegram.tg-main.12345' }
    );
    await relay.publish(
      'relay.human.telegram.tg-main.12345',
      { content: 'again', senderName: 'Alice', channelType: 'dm' },
      { from: 'relay.human.telegram.tg-main.bot', replyTo: 'relay.human.telegram.tg-main.12345' }
    );
    await relay.publish(
      'relay.human.telegram.tg-main.group.-100777',
      { content: 'team', senderName: 'Bob', channelName: 'Dev Team', channelType: 'group' },
      {
        from: 'relay.human.telegram.tg-main.bot',
        replyTo: 'relay.human.telegram.tg-main.group.-100777',
      }
    );

    // The bot being added to the group, published as the Telegram adapter does:
    // no text, so it is not a message the chat sent.
    await relay.publish(
      'relay.human.telegram.tg-main.group.-100777',
      { content: '', senderName: 'Bob', channelName: 'Dev Team', channelType: 'group' },
      {
        from: 'relay.human.telegram.tg-main.bot',
        replyTo: 'relay.human.telegram.tg-main.group.-100777',
      }
    );

    // The agent's turn answers on the same chat subject: a stream event and the
    // final reply. Neither is a message the chat sent, so neither is counted.
    await relay.publish(
      'relay.human.telegram.tg-main.12345',
      { type: 'text_delta', data: { text: 'Hel' } },
      { from: 'agent:session-1' }
    );
    await relay.publish(
      'relay.human.telegram.tg-main.12345',
      { type: 'done', data: {} },
      { from: 'agent:session-1' }
    );

    const chats = traces.getObservedChats('tg-main');

    expect(chats.map((c) => c.chatId).sort()).toEqual(['-100777', '12345']);
    const dm = chats.find((c) => c.chatId === '12345');
    expect(dm).toMatchObject({ channelType: 'dm', messageCount: 2, displayName: 'Alice' });
    const group = chats.find((c) => c.chatId === '-100777');
    expect(group).toMatchObject({ channelType: 'group', messageCount: 1, displayName: 'Dev Team' });
  });

  it("keeps one connection's chats out of another's list", async () => {
    await relay.publish(
      'relay.human.telegram.tg-main.12345',
      { content: 'hi' },
      { from: 'relay.human.telegram.tg-main.bot' }
    );
    await relay.publish(
      'relay.human.slack.slack-work.C0123',
      { content: 'hi' },
      { from: 'relay.human.slack.slack-work.bot' }
    );

    expect(traces.getObservedChats('tg-main').map((c) => c.chatId)).toEqual(['12345']);
    expect(traces.getObservedChats('slack-work').map((c) => c.chatId)).toEqual(['C0123']);
    expect(traces.getObservedChats('tg-other')).toEqual([]);
  });

  it('ignores a message that never touched a chat', async () => {
    await relay.registerEndpoint('relay.agent.session-1');
    await relay.publish('relay.agent.session-1', { content: 'x' }, { from: 'relay.test.sender' });
    // An adapter lifecycle event names the connection but no chat.
    traces.insertAdapterEvent('tg-main', 'adapter.connected', 'Connected to relay');

    expect(traces.getObservedChats('tg-main')).toEqual([]);
  });
});
