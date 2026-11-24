/**
 * A chat a connection has carried shows up in its observed chats (DOR-2590).
 * The query once read metadata fields no writer sets, so the list was empty for
 * every connection; driven here through the real `RelayCore` publish.
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
    relay.subscribe('relay.human.>', () => {});
  });

  afterEach(async () => {
    await relay.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('lists a Telegram DM and a group chat that messaged the connection', async () => {
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

    await relay.publish(
      'relay.human.telegram.tg-main.group.-100777',
      { content: '', senderName: 'Bob', channelName: 'Dev Team', channelType: 'group' },
      {
        from: 'relay.human.telegram.tg-main.bot',
        replyTo: 'relay.human.telegram.tg-main.group.-100777',
      }
    );

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
});
