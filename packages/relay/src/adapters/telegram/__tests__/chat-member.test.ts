/**
 * Tests for the group-add claim flow's entry point (DOR-883, chats-as-channels
 * spec §12, design-decisions D-3 item 4).
 *
 * Entry point is `handleChatMemberUpdate`, the same function `bot.on(
 * 'my_chat_member', ...)` calls for a real Telegram update. These tests pin
 * three things: only an ADD transition publishes (never a promotion, a
 * demotion, or a removal, and never a private chat's own membership change);
 * the published payload carries the ADDER's identity, never a message
 * author's; and the payload carries no `platformData.messageId` — the field
 * `ChatBridge.ingest` refuses on (see the module doc for why that refusal is
 * what keeps this safe to publish on a chat that is already bound or bridged).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context as GrammyContext } from 'grammy';
import { handleChatMemberUpdate } from '../chat-member.js';
import { TelegramThreadIdCodec } from '../../../lib/thread-id.js';
import type { RelayPublisher, AdapterInboundCallbacks, RelayLogger } from '../../../types.js';
import type { StandardPayload } from '@dorkos/shared/relay-schemas';

/** The bot this adapter authenticates as. */
const BOT_USER = { id: 777, is_bot: true, first_name: 'DorkBot', username: 'dorkbot' };

/** The person performing the membership change. */
const ADDER = { id: 42, is_bot: false, first_name: 'Ana', username: 'ana' };

const GROUP_ID = -100999;
const CODEC = new TelegramThreadIdCodec('tg1');
const GROUP_SUBJECT = `relay.human.telegram.tg1.group.${GROUP_ID}`;

type ChatMemberStatus = 'left' | 'kicked' | 'member' | 'administrator' | 'restricted' | 'creator';

interface CtxOptions {
  chatType?: 'private' | 'group' | 'supergroup' | 'channel';
  chatId?: number;
  chatTitle?: string;
  from?: typeof ADDER;
  oldStatus?: ChatMemberStatus;
  newStatus?: ChatMemberStatus;
}

/** Build a grammy context shaped like a real `my_chat_member` update. */
function createCtx(options: CtxOptions = {}): GrammyContext {
  const {
    chatType = 'supergroup',
    chatId = GROUP_ID,
    chatTitle = 'Ops',
    from = ADDER,
    oldStatus = 'left',
    newStatus = 'member',
  } = options;

  return {
    myChatMember: {
      chat: { id: chatId, type: chatType, ...(chatType !== 'private' ? { title: chatTitle } : {}) },
      from,
      date: 0,
      old_chat_member: { status: oldStatus, user: BOT_USER },
      new_chat_member: { status: newStatus, user: BOT_USER },
    },
  } as unknown as GrammyContext;
}

let relay: RelayPublisher;
let callbacks: AdapterInboundCallbacks;
let logger: RelayLogger;

beforeEach(() => {
  logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  relay = {
    publish: vi.fn().mockResolvedValue({ messageId: 'm1', deliveredTo: 1 }),
    subscribe: vi.fn(),
    onSignal: vi.fn(),
  } as unknown as RelayPublisher;
  callbacks = { trackInbound: vi.fn(), recordError: vi.fn() };
});

async function deliver(ctx: GrammyContext) {
  await handleChatMemberUpdate(ctx, relay, callbacks, logger, CODEC);
}

function publishedPayloads(): StandardPayload[] {
  return (relay.publish as ReturnType<typeof vi.fn>).mock.calls.map(
    (call) => call[1] as StandardPayload
  );
}

describe('handleChatMemberUpdate', () => {
  it('publishes when the bot is added to a supergroup, carrying the ADDER as senderName', async () => {
    await deliver(createCtx({ oldStatus: 'left', newStatus: 'member' }));

    expect(relay.publish).toHaveBeenCalledWith(
      GROUP_SUBJECT,
      expect.objectContaining({
        content: '',
        senderName: 'Ana',
        channelName: 'Ops',
        channelType: 'group',
      }),
      { from: 'relay.human.telegram.tg1.bot', replyTo: GROUP_SUBJECT }
    );
    expect(callbacks.trackInbound).toHaveBeenCalledOnce();
  });

  it('carries the raw platform chat type, distinct for a group vs a supergroup vs a broadcast channel', async () => {
    await deliver(createCtx({ chatType: 'group' }));
    expect(publishedPayloads()[0]?.platformData).toMatchObject({ chatType: 'group' });

    vi.mocked(relay.publish).mockClear();
    await deliver(createCtx({ chatType: 'supergroup' }));
    expect(publishedPayloads()[0]?.platformData).toMatchObject({ chatType: 'supergroup' });

    vi.mocked(relay.publish).mockClear();
    await deliver(createCtx({ chatType: 'channel' }));
    expect(publishedPayloads()[0]?.platformData).toMatchObject({ chatType: 'channel' });
  });

  it('never sets platformData.messageId — the field ChatBridge.ingest refuses an inbound with none', async () => {
    await deliver(createCtx());

    const platformData = publishedPayloads()[0]?.platformData as Record<string, unknown>;
    expect(platformData).not.toHaveProperty('messageId');
  });

  it('falls back from first+last name to username, then to "unknown", for the adder display name', async () => {
    await deliver(
      createCtx({ from: { id: 5, is_bot: false, first_name: '', username: 'onlyhandle' } })
    );
    expect(publishedPayloads()[0]?.senderName).toBe('onlyhandle');

    vi.mocked(relay.publish).mockClear();
    await deliver(createCtx({ from: { id: 5, is_bot: false, first_name: '', username: '' } }));
    expect(publishedPayloads()[0]?.senderName).toBe('unknown');
  });

  it.each([
    ['a bot promoted to admin', 'member', 'administrator'],
    ['an admin demoted to member', 'administrator', 'member'],
    ['a bot removed (left)', 'member', 'left'],
    ['a bot removed (kicked)', 'member', 'kicked'],
  ] as const)('does not publish for %s — never an add', async (_label, oldStatus, newStatus) => {
    await deliver(createCtx({ oldStatus, newStatus }));
    expect(relay.publish).not.toHaveBeenCalled();
  });

  it('ignores a private chat my_chat_member update — a DM already gets its card from its first message', async () => {
    await deliver(createCtx({ chatType: 'private', oldStatus: 'left', newStatus: 'member' }));
    expect(relay.publish).not.toHaveBeenCalled();
  });

  it('does nothing when the context carries no myChatMember at all', async () => {
    await handleChatMemberUpdate({} as GrammyContext, relay, callbacks, logger, CODEC);
    expect(relay.publish).not.toHaveBeenCalled();
  });

  it('records the error and does not throw when publish is rejected', async () => {
    vi.mocked(relay.publish).mockResolvedValueOnce({
      messageId: 'm1',
      deliveredTo: 0,
      rejected: [{ endpointHash: 'h', reason: 'rate_limited' }],
    });

    await expect(deliver(createCtx())).resolves.toBeUndefined();
    expect(callbacks.recordError).toHaveBeenCalled();
    expect(callbacks.trackInbound).not.toHaveBeenCalled();
  });

  it('records the error and does not throw when publish itself throws', async () => {
    vi.mocked(relay.publish).mockRejectedValueOnce(new Error('relay unavailable'));

    await expect(deliver(createCtx())).resolves.toBeUndefined();
    expect(callbacks.recordError).toHaveBeenCalledWith(expect.any(Error));
  });
});
