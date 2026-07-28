/**
 * Tests for the two gates the Telegram inbound handler runs before publishing.
 *
 * They are different kinds of thing and are tested separately on purpose:
 *
 * - The **bot-loop guard** is a mechanism. It is unconditional, and the tests
 *   below prove it cannot be reached by config — a loop is a property of the
 *   whole conversation, so it can never be left to an agent's judgment
 *   (`.claude/rules/room-conduct.md`, ADR `260726-170127`).
 * - **Group respond gating** is a preference the operator sets, and it only
 *   ever narrows behavior in groups.
 *
 * Entry point is `handleInboundMessage`, the same function
 * `bot.on('message', ...)` calls for a real Telegram update.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context as GrammyContext } from 'grammy';
import { handleInboundMessage } from '../inbound.js';
import { TelegramThreadIdCodec } from '../../../lib/thread-id.js';
import type { RelayPublisher, AdapterInboundCallbacks } from '../../../types.js';

/** The bot this adapter authenticates as. */
const ME = { id: 777, is_bot: true, first_name: 'DorkBot', username: 'dorkbot' };

/** A person. */
const HUMAN = { id: 42, is_bot: false, first_name: 'Alice', username: 'alice' };

/** A second bot sharing the group — the other half of a reply loop. */
const OTHER_BOT = { id: 888, is_bot: true, first_name: 'OtherBot', username: 'otherbot' };

/**
 * The service account Telegram routes an anonymous admin's message through.
 * `is_bot` is true and the id is arbitrary here on purpose: the carve-out keys
 * on `sender_chat`, never on this account's id.
 */
const ANON_ADMIN = {
  id: 1087968824,
  is_bot: true,
  first_name: 'Group',
  username: 'GroupAnonymousBot',
};

/** The service account behind a linked channel posting into a discussion group. */
const CHANNEL_BOT = { id: 136817688, is_bot: true, first_name: 'Channel', username: 'Channel_Bot' };

const GROUP_ID = -100111222;
const PRIVATE_ID = 12345;

const CODEC = new TelegramThreadIdCodec('tg1');
const GROUP_SUBJECT = `relay.human.telegram.tg1.group.${GROUP_ID}`;
const PRIVATE_SUBJECT = `relay.human.telegram.tg1.${PRIVATE_ID}`;

interface CtxOptions {
  from?: { id: number; is_bot: boolean; first_name: string; username: string };
  chatType?: 'private' | 'group' | 'supergroup' | 'channel';
  chatId?: number;
  text?: string;
  entities?: Array<Record<string, unknown>>;
  /** Who wrote the message this one replies to, if any. */
  replyToFrom?: { id: number; is_bot: boolean; first_name: string; username: string };
  /**
   * The chat this message was sent on behalf of. Telegram sets this to the
   * group itself for an anonymous admin, and to the channel for a linked
   * channel's post.
   */
  senderChatId?: number;
}

/** Build a grammy context shaped like a real inbound Telegram update. */
function createCtx(options: CtxOptions = {}): GrammyContext {
  const {
    from = HUMAN,
    chatType = 'group',
    chatId = chatType === 'private' ? PRIVATE_ID : GROUP_ID,
    text = 'anyone around?',
    entities,
    replyToFrom,
    senderChatId,
  } = options;

  return {
    chat: {
      id: chatId,
      type: chatType,
      title: chatType === 'private' ? undefined : 'Project Team',
    },
    from,
    me: ME,
    message: {
      message_id: 1,
      text,
      sender_chat:
        senderChatId === undefined ? undefined : { id: senderChatId, type: 'supergroup' },
      entities,
      reply_to_message: replyToFrom ? { message_id: 0, from: replyToFrom } : undefined,
    },
  } as unknown as GrammyContext;
}

let relay: RelayPublisher;
let callbacks: AdapterInboundCallbacks;

beforeEach(() => {
  relay = {
    publish: vi.fn().mockResolvedValue({ messageId: 'm1', deliveredTo: 1 }),
    subscribe: vi.fn(),
    onSignal: vi.fn(),
  } as unknown as RelayPublisher;
  callbacks = { trackInbound: vi.fn(), recordError: vi.fn(), onPublished: vi.fn() };
});

/** Run the handler the way `bot.on('message', ...)` does. */
async function deliver(
  ctx: GrammyContext,
  respondMode?: 'always' | 'mention-only' | 'thread-aware'
) {
  await handleInboundMessage(
    ctx,
    relay,
    callbacks,
    undefined,
    CODEC,
    respondMode ? { respondMode } : undefined
  );
}

/** The subjects the relay was asked to publish to, in order. */
function publishedSubjects(): string[] {
  return (relay.publish as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0] as string);
}

describe('Telegram inbound — bot-loop guard (DOR-619)', () => {
  // Every case here is one the respond gate would let through, so the bot guard
  // is the only thing that can drop it. A bot message that addresses nobody is
  // deliberately not tested: the respond gate would drop that anyway, so it
  // would stay green with the guard deleted and prove nothing.

  it("drops another bot's reply to this bot", async () => {
    await deliver(createCtx({ from: OTHER_BOT, text: 'I can help with that', replyToFrom: ME }));

    expect(publishedSubjects()).toEqual([]);
    expect(callbacks.trackInbound).not.toHaveBeenCalled();
  });

  it("drops another bot's message that names this bot and replies to it", async () => {
    // The exact shape of a sustained two-bot loop: maximally addressed, and
    // still dropped. If only the respond gate ran, this message would pass it
    // twice over.
    await deliver(
      createCtx({
        from: OTHER_BOT,
        text: '@dorkbot here is my answer',
        entities: [{ type: 'mention', offset: 0, length: 8 }],
        replyToFrom: ME,
      })
    );

    expect(publishedSubjects()).toEqual([]);
  });

  it("drops this bot's own message echoed back", async () => {
    // Under 'always' so the respond gate would publish it, leaving the guard as
    // the only reason it is dropped.
    await deliver(createCtx({ from: { ...ME }, text: 'something I said earlier' }), 'always');

    expect(publishedSubjects()).toEqual([]);
  });

  it("drops a bot's message in a private chat, not just in groups", async () => {
    await deliver(createCtx({ from: OTHER_BOT, chatType: 'private', text: 'hello' }));

    expect(publishedSubjects()).toEqual([]);
  });

  it("respondMode 'always' does not reach the guard — a bot is still dropped", async () => {
    // The guard is a mechanism, not a preference. The most permissive setting a
    // person can choose must not switch it off.
    await deliver(createCtx({ from: OTHER_BOT, text: 'chatty bot noise' }), 'always');

    expect(publishedSubjects()).toEqual([]);
  });

  it('lets an anonymous group admin through, because they are a person', async () => {
    // Telegram routes an anonymous admin through a service bot account, so
    // `from.is_bot` is true and the guard would drop a human being. This message
    // names the bot, so the respond gate would allow it — the carve-out is the
    // only thing deciding the outcome.
    await deliver(
      createCtx({
        from: ANON_ADMIN,
        senderChatId: GROUP_ID,
        text: '@dorkbot what is the status?',
        entities: [{ type: 'mention', offset: 0, length: 8 }],
      })
    );

    expect(publishedSubjects()).toEqual([GROUP_SUBJECT]);
  });

  it('still gates an anonymous group admin who addresses nobody', async () => {
    // Carved out of the bot guard, not waved past the respond gate.
    await deliver(
      createCtx({ from: ANON_ADMIN, senderChatId: GROUP_ID, text: 'just thinking out loud' })
    );

    expect(publishedSubjects()).toEqual([]);
  });

  it('drops a linked channel post, whose sender_chat is a different chat', async () => {
    // Keeps the carve-out narrow: `sender_chat` is set here too, but to the
    // channel rather than to this group, so it is not an admin of this chat.
    await deliver(
      createCtx({
        from: CHANNEL_BOT,
        senderChatId: -100999888,
        text: '@dorkbot new post published',
        entities: [{ type: 'mention', offset: 0, length: 8 }],
      })
    );

    expect(publishedSubjects()).toEqual([]);
  });

  it('still publishes a person’s message in the same group', async () => {
    // The control: the guard drops bots, not everyone.
    await deliver(
      createCtx({
        from: HUMAN,
        text: '@dorkbot are you there?',
        entities: [{ type: 'mention', offset: 0, length: 8 }],
      })
    );

    expect(publishedSubjects()).toEqual([GROUP_SUBJECT]);
    expect(callbacks.trackInbound).toHaveBeenCalledTimes(1);
  });
});

describe('Telegram inbound — group respond gating (DOR-619)', () => {
  it('answers every message in a private chat', async () => {
    await deliver(createCtx({ chatType: 'private', text: 'no mention needed here' }));

    expect(publishedSubjects()).toEqual([PRIVATE_SUBJECT]);
  });

  it('drops a group message that does not address the bot', async () => {
    await deliver(createCtx({ text: 'just two people talking' }));

    expect(publishedSubjects()).toEqual([]);
    expect(callbacks.trackInbound).not.toHaveBeenCalled();
  });

  it('answers a group message that @mentions the bot', async () => {
    await deliver(
      createCtx({
        text: 'hey @dorkbot can you check this',
        entities: [{ type: 'mention', offset: 4, length: 8 }],
      })
    );

    expect(publishedSubjects()).toEqual([GROUP_SUBJECT]);
  });

  it('answers a /command addressed to the bot', async () => {
    await deliver(
      createCtx({
        text: '/status@dorkbot',
        entities: [{ type: 'bot_command', offset: 0, length: 15 }],
      })
    );

    expect(publishedSubjects()).toEqual([GROUP_SUBJECT]);
  });

  it('answers a bare command that opens the message', async () => {
    // Telegram delivers `/status` to every listening bot in the group, so a
    // command naming no bot is meant for this one too.
    await deliver(
      createCtx({
        text: '/status',
        entities: [{ type: 'bot_command', offset: 0, length: 7 }],
      })
    );

    expect(publishedSubjects()).toEqual([GROUP_SUBJECT]);
  });

  it('drops a command addressed to a different bot', async () => {
    await deliver(
      createCtx({
        text: '/status@otherbot',
        entities: [{ type: 'bot_command', offset: 0, length: 16 }],
      })
    );

    expect(publishedSubjects()).toEqual([]);
  });

  it('drops a command mentioned mid-sentence rather than invoked', async () => {
    // Talk about a command, not a use of one.
    await deliver(
      createCtx({
        text: 'you should run /deploy later',
        entities: [{ type: 'bot_command', offset: 15, length: 7 }],
      })
    );

    expect(publishedSubjects()).toEqual([]);
  });

  it('answers a text_mention entity carrying the bot user id', async () => {
    // How Telegram represents a mention of a user with no public username.
    await deliver(
      createCtx({
        text: 'DorkBot take a look',
        entities: [{ type: 'text_mention', offset: 0, length: 7, user: ME }],
      })
    );

    expect(publishedSubjects()).toEqual([GROUP_SUBJECT]);
  });

  it('drops a group message mentioning somebody else', async () => {
    // Proves the handle match is not a loose substring over the whole text.
    await deliver(
      createCtx({
        text: 'hey @dorkbotanic can you check this',
        entities: [{ type: 'mention', offset: 4, length: 12 }],
      })
    );

    expect(publishedSubjects()).toEqual([]);
  });

  it("answers a reply to one of the bot's own messages", async () => {
    await deliver(createCtx({ text: 'that worked, thanks', replyToFrom: ME }));

    expect(publishedSubjects()).toEqual([GROUP_SUBJECT]);
  });

  it("drops a reply to somebody else's message", async () => {
    await deliver(createCtx({ text: 'agreed', replyToFrom: HUMAN }));

    expect(publishedSubjects()).toEqual([]);
  });

  it('treats a supergroup like a group', async () => {
    await deliver(createCtx({ chatType: 'supergroup', text: 'unaddressed chatter' }));

    expect(publishedSubjects()).toEqual([]);
  });

  it("respondMode 'always' answers an unaddressed group message", async () => {
    await deliver(createCtx({ text: 'just two people talking' }), 'always');

    expect(publishedSubjects()).toEqual([GROUP_SUBJECT]);
  });

  it("respondMode 'mention-only' ignores a reply to the bot", async () => {
    await deliver(createCtx({ text: 'that worked, thanks', replyToFrom: ME }), 'mention-only');

    expect(publishedSubjects()).toEqual([]);
  });

  it("respondMode 'mention-only' still answers a mention", async () => {
    await deliver(
      createCtx({
        text: '@dorkbot ping',
        entities: [{ type: 'mention', offset: 0, length: 8 }],
      }),
      'mention-only'
    );

    expect(publishedSubjects()).toEqual([GROUP_SUBJECT]);
  });

  it('with no respondMode supplied, falls back to the schema default and not to always', async () => {
    // DOR-623: the default is stated once, in `DEFAULT_RESPOND_MODE`. A caller
    // that omits the option gets that, not a more permissive local literal.
    await deliver(createCtx({ text: 'unaddressed chatter' }), undefined);

    expect(publishedSubjects()).toEqual([]);
  });
});
