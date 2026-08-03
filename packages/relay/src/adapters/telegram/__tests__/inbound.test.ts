/**
 * Tests for the three gates the Telegram inbound handler runs before publishing.
 *
 * They are different kinds of thing and are tested separately on purpose:
 *
 * - The **bot-loop guard** is a mechanism. It is unconditional, and the tests
 *   below prove it cannot be reached by config — a loop is a property of the
 *   whole conversation, so it can never be left to an agent's judgment
 *   (`.claude/rules/room-conduct.md`, ADR `260726-170127`).
 * - **Group respond gating** is a preference the operator sets, and it only
 *   ever narrows behavior in groups.
 * - The **DM allowlist** is an access rule: a bot handle is public, and a
 *   private message runs a turn on the operator's machine (DOR-788).
 *
 * Entry point is `handleInboundMessage`, the same function
 * `bot.on('message', ...)` calls for a real Telegram update.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context as GrammyContext } from 'grammy';
import { handleInboundMessage } from '../inbound.js';
import { TelegramThreadIdCodec } from '../../../lib/thread-id.js';
import type { TelegramInboundOptions } from '../inbound.js';
import { createDeniedChatNotices } from '../../denied-chat-notices.js';
import type { RelayPublisher, AdapterInboundCallbacks, RelayLogger } from '../../../types.js';
import type { StandardPayload } from '@dorkos/shared/relay-schemas';

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
  /** Caption on a media message. Distinct from `text` — Telegram never sets both. */
  caption?: string;
  entities?: Array<Record<string, unknown>>;
  /** Who wrote the message this one replies to, if any. */
  replyToFrom?: { id: number; is_bot: boolean; first_name: string; username: string };
  /** The id of the message being replied to. Defaults to 0 when a reply shape is present. */
  replyToMessageId?: number;
  /**
   * The chat this message was sent on behalf of. Telegram sets this to the
   * group itself for an anonymous admin, and to the channel for a linked
   * channel's post.
   */
  senderChatId?: number;
  messageId?: number;
  /** The forum topic id, when the message belongs to one. */
  messageThreadId?: number;
  /** Sets `message.forum_topic_created` — this message IS the topic-creation event. */
  forumTopicName?: string;
  /** Sets `message.reply_to_message.forum_topic_created` — a reply to the creation event. */
  replyForumTopicName?: string;
  /** Non-text content, mutually exclusive in real Telegram traffic. */
  photo?: boolean;
  sticker?: boolean;
  voice?: { duration: number; mimeType?: string };
  video?: { duration: number; fileName?: string; mimeType?: string };
  document?: { fileName?: string; mimeType?: string };
  location?: boolean;
}

/** Build a grammy context shaped like a real inbound Telegram update. */
function createCtx(options: CtxOptions = {}): GrammyContext {
  const {
    from = HUMAN,
    chatType = 'group',
    chatId = chatType === 'private' ? PRIVATE_ID : GROUP_ID,
    text = 'anyone around?',
    caption,
    entities,
    replyToFrom,
    replyToMessageId,
    senderChatId,
    messageId = 1,
    messageThreadId,
    forumTopicName,
    replyForumTopicName,
    photo,
    sticker,
    voice,
    video,
    document,
    location,
  } = options;

  const hasMedia = Boolean(photo || sticker || voice || video || document || location);
  const hasReply =
    replyToFrom !== undefined ||
    replyToMessageId !== undefined ||
    replyForumTopicName !== undefined;

  return {
    chat: {
      id: chatId,
      type: chatType,
      title: chatType === 'private' ? undefined : 'Project Team',
    },
    from,
    me: ME,
    message: {
      message_id: messageId,
      // A real Telegram media message carries `caption`, never `text`.
      text: hasMedia ? undefined : text,
      caption,
      message_thread_id: messageThreadId,
      forum_topic_created: forumTopicName ? { name: forumTopicName } : undefined,
      sender_chat:
        senderChatId === undefined ? undefined : { id: senderChatId, type: 'supergroup' },
      entities,
      reply_to_message: hasReply
        ? {
            message_id: replyToMessageId ?? 0,
            from: replyToFrom,
            forum_topic_created: replyForumTopicName ? { name: replyForumTopicName } : undefined,
          }
        : undefined,
      photo: photo ? [{ file_id: 'p1', file_unique_id: 'pu1', width: 90, height: 90 }] : undefined,
      sticker: sticker
        ? {
            file_id: 's1',
            file_unique_id: 'su1',
            type: 'regular',
            width: 512,
            height: 512,
            is_animated: false,
            is_video: false,
          }
        : undefined,
      voice: voice
        ? {
            file_id: 'v1',
            file_unique_id: 'vu1',
            duration: voice.duration,
            mime_type: voice.mimeType,
          }
        : undefined,
      video: video
        ? {
            file_id: 'vd1',
            file_unique_id: 'vdu1',
            width: 100,
            height: 100,
            duration: video.duration,
            file_name: video.fileName,
            mime_type: video.mimeType,
          }
        : undefined,
      document: document
        ? {
            file_id: 'd1',
            file_unique_id: 'du1',
            file_name: document.fileName,
            mime_type: document.mimeType,
          }
        : undefined,
      location: location ? { latitude: 51.5, longitude: -0.1 } : undefined,
    },
  } as unknown as GrammyContext;
}

let relay: RelayPublisher;
let callbacks: AdapterInboundCallbacks;
let logger: RelayLogger;
let warnings: string[];

beforeEach(() => {
  warnings = [];
  logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn((...args: unknown[]) => warnings.push(args.map(String).join(' '))),
    error: vi.fn(),
  };
  relay = {
    publish: vi.fn().mockResolvedValue({ messageId: 'm1', deliveredTo: 1 }),
    subscribe: vi.fn(),
    onSignal: vi.fn(),
  } as unknown as RelayPublisher;
  callbacks = { trackInbound: vi.fn(), recordError: vi.fn() };
});

/**
 * Run the handler the way `bot.on('message', ...)` does.
 *
 * @param ctx - The grammy context for this update.
 * @param options - Inbound options, or a bare respond mode for brevity.
 */
async function deliver(
  ctx: GrammyContext,
  options?: 'always' | 'mention-only' | 'thread-aware' | TelegramInboundOptions
) {
  const resolved = typeof options === 'string' ? { respondMode: options } : options;
  await handleInboundMessage(ctx, relay, callbacks, logger, CODEC, resolved);
}

/** Every private chat this helper opens is from {@link HUMAN}. */
const ALLOW_HUMAN: TelegramInboundOptions = {
  dmPolicy: 'allowlist',
  dmAllowlist: [String(HUMAN.id)],
};

/** The subjects the relay was asked to publish to, in order. */
function publishedSubjects(): string[] {
  return (relay.publish as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0] as string);
}

/** The payloads the relay was asked to publish, in order. */
function publishedPayloads(): StandardPayload[] {
  return (relay.publish as ReturnType<typeof vi.fn>).mock.calls.map(
    (call) => call[1] as StandardPayload
  );
}

/** `platformData` off a published payload, typed as the Telegram adapter builds it. */
function platformData(payload: StandardPayload): Record<string, unknown> {
  return payload.platformData as Record<string, unknown>;
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
    // Allowlisted by id, so the bot guard is the only thing that can drop it.
    await deliver(createCtx({ from: OTHER_BOT, chatType: 'private', text: 'hello' }), {
      dmPolicy: 'allowlist',
      dmAllowlist: [String(OTHER_BOT.id)],
    });

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
    // Respond mode never gates a private chat; the DM allowlist does, so this
    // one names the sender to isolate the behaviour under test.
    await deliver(createCtx({ chatType: 'private', text: 'no mention needed here' }), ALLOW_HUMAN);

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

describe('Telegram inbound — private-chat allowlist (DOR-788)', () => {
  // A Telegram bot handle is public: search finds it, anyone can press Start,
  // and a private message runs an agent turn in the binding's project
  // directory. Groups have been gated since DOR-619; private chats were gated
  // by nothing at all.

  const privateCtx = () => createCtx({ chatType: 'private', text: 'run the deploy' });

  it('drops a private message from someone not on the allowlist', async () => {
    await deliver(privateCtx(), { dmPolicy: 'allowlist', dmAllowlist: ['999'] });

    expect(publishedSubjects()).toEqual([]);
  });

  it('lets an allowlisted sender through', async () => {
    await deliver(privateCtx(), ALLOW_HUMAN);

    expect(publishedSubjects()).toEqual([PRIVATE_SUBJECT]);
  });

  it('defaults to the allowlist when the config never reached the schema', async () => {
    // The same reasoning as Slack's identical field: an integration nobody
    // configured answers nobody, rather than answering the whole world.
    await deliver(privateCtx(), {});

    expect(publishedSubjects()).toEqual([]);
  });

  it("answers anyone when the operator chooses 'open'", async () => {
    await deliver(privateCtx(), { dmPolicy: 'open' });

    expect(publishedSubjects()).toEqual([PRIVATE_SUBJECT]);
  });

  it("does not gate group messages — those are the respond mode's business", async () => {
    // An empty DM allowlist must not silence a group the bot was invited to.
    await deliver(
      createCtx({
        text: '@dorkbot ping',
        entities: [{ type: 'mention', offset: 0, length: 8 }],
      }),
      { dmPolicy: 'allowlist', dmAllowlist: [] }
    );

    expect(publishedSubjects()).toEqual([GROUP_SUBJECT]);
  });

  describe('the refusal is explained, once', () => {
    // At `debug` this was invisible, and a bot that silently ignores you is
    // indistinguishable from a broken one — right after setup, when the
    // allowlist is empty, that is the FIRST thing a person meets.

    it('warns with the id to add and the setting to change', async () => {
      await deliver(privateCtx(), {
        dmPolicy: 'allowlist',
        dmAllowlist: [],
        deniedNotices: createDeniedChatNotices(),
      });

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('Alice');
      expect(warnings[0]).toContain('42'); // the id to paste
      expect(warnings[0]).toContain(String(PRIVATE_ID)); // the chat
      expect(warnings[0]).toContain('DM Allowlist'); // the setting to change
      expect(warnings[0]).toContain('the allowlist is empty');
    });

    it('says it once per chat, however many messages arrive', async () => {
      // One person retrying — or a stranger hammering the bot — must not be
      // able to fill the operator's log.
      const options = {
        dmPolicy: 'allowlist' as const,
        dmAllowlist: [],
        deniedNotices: createDeniedChatNotices(),
      };

      await deliver(privateCtx(), options);
      await deliver(privateCtx(), options);
      await deliver(privateCtx(), options);

      expect(warnings).toHaveLength(1);
      expect(publishedSubjects()).toEqual([]);
    });

    it('explains each distinct chat separately', async () => {
      const options = {
        dmPolicy: 'allowlist' as const,
        dmAllowlist: [],
        deniedNotices: createDeniedChatNotices(),
      };

      await deliver(createCtx({ chatType: 'private', chatId: 111, text: 'hi' }), options);
      await deliver(createCtx({ chatType: 'private', chatId: 222, text: 'hi' }), options);

      expect(warnings).toHaveLength(2);
    });
  });
});

describe('Telegram inbound — non-text content (spec §5.5, §11.2)', () => {
  // §11.2 additive field 3: `platformData.media`, plus lifting the
  // captionless-media drop at inbound.ts:427-430 (A5.7). Every case here uses
  // a private chat so DM-allowlist and group-respond gating stay out of the
  // way of what's actually under test.

  it('publishes a captionless photo with a media descriptor and no text', async () => {
    await deliver(createCtx({ chatType: 'private', photo: true }), ALLOW_HUMAN);

    expect(publishedSubjects()).toEqual([PRIVATE_SUBJECT]);
    const [payload] = publishedPayloads();
    expect(payload!.content).toBe('');
    expect(platformData(payload!).media).toEqual({ type: 'photo' });
  });

  it('publishes a captioned photo with the descriptor plus the caption as content', async () => {
    await deliver(
      createCtx({ chatType: 'private', caption: 'look at this', photo: true }),
      ALLOW_HUMAN
    );

    const [payload] = publishedPayloads();
    expect(payload!.content).toBe('look at this');
    expect(platformData(payload!).media).toEqual({ type: 'photo' });
  });

  it('publishes a captionless sticker with a media descriptor', async () => {
    await deliver(createCtx({ chatType: 'private', sticker: true }), ALLOW_HUMAN);

    const [payload] = publishedPayloads();
    expect(payload!.content).toBe('');
    expect(platformData(payload!).media).toEqual({ type: 'sticker' });
  });

  it('publishes a captionless voice note with duration and mime type', async () => {
    await deliver(
      createCtx({ chatType: 'private', voice: { duration: 14, mimeType: 'audio/ogg' } }),
      ALLOW_HUMAN
    );

    const [payload] = publishedPayloads();
    expect(payload!.content).toBe('');
    expect(platformData(payload!).media).toEqual({
      type: 'voice',
      durationSec: 14,
      mimeType: 'audio/ogg',
    });
  });

  it('publishes a captionless video with duration, filename, and mime type', async () => {
    await deliver(
      createCtx({
        chatType: 'private',
        video: { duration: 30, fileName: 'clip.mp4', mimeType: 'video/mp4' },
      }),
      ALLOW_HUMAN
    );

    const [payload] = publishedPayloads();
    expect(platformData(payload!).media).toEqual({
      type: 'video',
      durationSec: 30,
      fileName: 'clip.mp4',
      mimeType: 'video/mp4',
    });
  });

  it('publishes a captionless document with filename and mime type', async () => {
    await deliver(
      createCtx({
        chatType: 'private',
        document: { fileName: 'report.pdf', mimeType: 'application/pdf' },
      }),
      ALLOW_HUMAN
    );

    const [payload] = publishedPayloads();
    expect(platformData(payload!).media).toEqual({
      type: 'document',
      fileName: 'report.pdf',
      mimeType: 'application/pdf',
    });
  });

  it('publishes a shared location with a media descriptor', async () => {
    await deliver(createCtx({ chatType: 'private', location: true }), ALLOW_HUMAN);

    const [payload] = publishedPayloads();
    expect(payload!.content).toBe('');
    expect(platformData(payload!).media).toEqual({ type: 'location' });
  });

  it('still drops a message with no text, caption, or recognized media', async () => {
    // The negative control for the lift: proves it publishes non-text
    // content because it recognizes a media kind, not because the drop was
    // simply removed. A poll or a contact card — neither modeled by
    // `createCtx` — would hit exactly this path in production.
    await deliver(createCtx({ chatType: 'private', text: '' }), ALLOW_HUMAN);

    expect(publishedSubjects()).toEqual([]);
    expect(callbacks.trackInbound).not.toHaveBeenCalled();
  });

  it('a captionless photo in a group still obeys the respond gate', async () => {
    // The lift lives beneath the gate, not instead of it: an unaddressed
    // group photo under the default respond mode is still filtered.
    await deliver(createCtx({ chatType: 'group', photo: true }));

    expect(publishedSubjects()).toEqual([]);
  });
});

describe('Telegram inbound — reply targeting (spec §5.4, §6.5, §11.2)', () => {
  // §11.2 additive field 1: `platformData.replyToMessageId`.

  it('carries replyToMessageId when the message replies to another', async () => {
    await deliver(
      createCtx({
        chatType: 'private',
        text: 'yes, that one',
        replyToFrom: HUMAN,
        replyToMessageId: 55,
      }),
      ALLOW_HUMAN
    );

    const [payload] = publishedPayloads();
    expect(platformData(payload!).replyToMessageId).toBe(55);
  });

  it('omits replyToMessageId when the message is not a reply', async () => {
    await deliver(createCtx({ chatType: 'private', text: 'hello' }), ALLOW_HUMAN);

    const [payload] = publishedPayloads();
    expect(platformData(payload!).replyToMessageId).toBeUndefined();
  });
});

describe('Telegram inbound — forum topics (spec §5.6, §9.2, §11.2)', () => {
  // §11.2 additive fields 2: `platformData.messageThreadId` and `threadName`.

  it('carries the topic id and name when the message itself is the creation event', async () => {
    await deliver(
      createCtx({
        chatType: 'private',
        text: 'first message',
        messageThreadId: 99,
        forumTopicName: 'Bug Reports',
      }),
      ALLOW_HUMAN
    );

    const [payload] = publishedPayloads();
    expect(platformData(payload!).messageThreadId).toBe(99);
    expect(platformData(payload!).threadName).toBe('Bug Reports');
  });

  it('carries the topic name from a reply to the creation event', async () => {
    await deliver(
      createCtx({
        chatType: 'private',
        text: 'second message',
        messageThreadId: 99,
        replyToMessageId: 98,
        replyForumTopicName: 'Bug Reports',
      }),
      ALLOW_HUMAN
    );

    const [payload] = publishedPayloads();
    expect(platformData(payload!).messageThreadId).toBe(99);
    expect(platformData(payload!).threadName).toBe('Bug Reports');
  });

  it('carries the topic id with no name for a later message that names neither shape', async () => {
    // The honest dotted/absent case: no cheap way to learn the name, so the
    // field is simply absent rather than guessed.
    await deliver(
      createCtx({ chatType: 'private', text: 'third message', messageThreadId: 99 }),
      ALLOW_HUMAN
    );

    const [payload] = publishedPayloads();
    expect(platformData(payload!).messageThreadId).toBe(99);
    expect(platformData(payload!).threadName).toBeUndefined();
  });

  it('omits both fields entirely for a message outside any forum topic', async () => {
    await deliver(createCtx({ chatType: 'private', text: 'hello' }), ALLOW_HUMAN);

    const [payload] = publishedPayloads();
    expect(platformData(payload!).messageThreadId).toBeUndefined();
    expect(platformData(payload!).threadName).toBeUndefined();
  });
});
