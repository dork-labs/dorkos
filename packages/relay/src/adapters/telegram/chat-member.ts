/**
 * Telegram "bot added to a group" detection — the group-add claim flow's
 * entry point (chats-as-channels spec §12, design-decisions D-3 item 4;
 * DOR-883).
 *
 * Telegram reports a change to the BOT'S OWN membership through a distinct
 * update, `my_chat_member` — never through `message`. A person adding this
 * bot to a group produces no chat message at all, so waiting on the group's
 * first message (as the claim feed did before this) could show the wrong
 * "who added your bot" name (whoever happened to speak first, not whoever
 * added it) or show nothing at all if the group stays quiet. This handler
 * gives the group-add event its own signal, sourced from Telegram's own
 * record of who performed the add.
 *
 * **This publishes through the exact SAME path a real message uses** —
 * {@link import('./inbound.js').handleInboundMessage}'s subject and payload
 * shape — rather than adding a second route into `BindingRouter`. An unbound
 * chat's `!binding` branch already reads `senderName`/`channelName` generically
 * off the payload (`extractClaimFeedDisplayFields`, `binding-router.ts`), so
 * setting `senderName` to the ADDER's name here, instead of a message
 * author's, is enough — no server-side change was needed to make the claim
 * feed show the right person.
 *
 * Two fields deliberately mark this as "nothing was said," and both matter
 * for what happens when the chat already has a binding (a bot removed and
 * re-added to a group it once left):
 *
 * - No media and `content: ''` — a bound-but-unbridged binding's inbound path
 *   already drops empty content before touching a session
 *   (`BindingRouter.route()`'s `hasEmptyContent` gate, DOR-866).
 * - **No `platformData.messageId`** — a bound-and-BRIDGED binding's `ingest`
 *   refuses ANY inbound with no platform message id
 *   (`missing_message_id`, `chat-bridge/ingest.ts`), silently, writing no
 *   room entry and sending no chat notice. That is exactly the outcome a
 *   re-add needs: nothing enters a bridged room's log over an event that had
 *   nothing to say.
 *
 * Neither downstream path needed to change; this module only had to avoid
 * giving them anything to dispatch on.
 *
 * @module relay/adapters/telegram-chat-member
 */
import type { Context as GrammyContext } from 'grammy';
import type { StandardPayload } from '@dorkos/shared/relay-schemas';
import type { RelayPublisher, AdapterInboundCallbacks, RelayLogger } from '../../types.js';
import { noopLogger } from '../../types.js';
import { TelegramThreadIdCodec } from '../../lib/thread-id.js';
import { buildSubject, extractChannelName } from './inbound.js';

/** Sender name used when the person who added the bot has no resolvable name. */
const UNKNOWN_SENDER = 'unknown';

/** Statuses that mean the bot is NOT currently in the chat. */
const NOT_MEMBER_STATUSES = new Set(['left', 'kicked']);

/** Statuses that mean the bot IS currently in the chat, as an ordinary member or an admin. */
const MEMBER_STATUSES = new Set(['member', 'administrator']);

/** The `my_chat_member` update shape, as grammy exposes it on `ctx.myChatMember`. */
type ChatMemberUpdate = NonNullable<GrammyContext['myChatMember']>;

/**
 * Whether a `my_chat_member` update is the bot being newly added to a chat it
 * was not already in — never a promotion, a demotion, or a removal.
 *
 * `my_chat_member` fires for every change to the bot's own status, so a group
 * merely promoting an already-present bot to admin reaches this handler too;
 * that update carries nothing the claim feed needs (the group is already
 * known, one way or another), so it is filtered out here rather than
 * upstream, keeping {@link handleChatMemberUpdate} the one place that decides
 * "was this an add."
 *
 * @param update - The grammy `ctx.myChatMember` payload.
 */
function isAddedTransition(update: ChatMemberUpdate): boolean {
  return (
    NOT_MEMBER_STATUSES.has(update.old_chat_member.status) &&
    MEMBER_STATUSES.has(update.new_chat_member.status)
  );
}

/**
 * Handle a Telegram `my_chat_member` update. When it is the bot being added
 * to a group, supergroup, or broadcast channel, publishes it through the same
 * unbound-chat path an inbound message uses — see the module doc for why this
 * is safe even when the chat already has a binding.
 *
 * A private chat's `my_chat_member` (a person starting or blocking a DM) is
 * ignored: a DM's claim card already comes from its first message, which
 * arrives immediately when someone opens a chat, so this would add nothing.
 * A broadcast channel's add IS published — the group-add claim flow's own
 * card is what tells a broadcast apart and offers only Ignore/Leave for it
 * (DOR-907's `platformChatType`, read off this same envelope).
 *
 * @param ctx - The grammy context for the inbound update.
 * @param relay - The relay publisher.
 * @param callbacks - Callbacks to mutate adapter state.
 * @param logger - Optional relay logger for debug/warn output (defaults to silent).
 * @param codec - Optional thread ID codec (defaults to an unscoped one).
 */
export async function handleChatMemberUpdate(
  ctx: GrammyContext,
  relay: RelayPublisher,
  callbacks: AdapterInboundCallbacks,
  logger: RelayLogger = noopLogger,
  codec?: TelegramThreadIdCodec
): Promise<void> {
  const update = ctx.myChatMember;
  if (!update) {
    logger.debug('chat-member update skipped: no myChatMember in context');
    return;
  }

  const { chat, from } = update;
  if (chat.type === 'private') {
    logger.debug('chat-member update skipped: private chat carries no group-add signal');
    return;
  }
  if (!isAddedTransition(update)) {
    logger.debug(
      `chat-member update skipped: not an add (${update.old_chat_member.status} -> ` +
        `${update.new_chat_member.status}) in chat ${chat.id}`
    );
    return;
  }

  const resolvedCodec = codec ?? new TelegramThreadIdCodec();
  const subject = buildSubject(resolvedCodec, chat.id, true);
  const adderName =
    [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || UNKNOWN_SENDER;
  const chatTitle = extractChannelName(chat);

  const payload: StandardPayload = {
    content: '',
    senderName: adderName,
    channelName: chatTitle,
    channelType: 'group',
    platformData: {
      chatId: chat.id,
      chatType: chat.type,
      fromId: from.id,
      username: from.username,
    },
  };

  try {
    const result = await relay.publish(subject, payload, {
      from: `${resolvedCodec.prefix}.bot`,
      replyTo: subject,
    });
    if (result.deliveredTo === 0 && result.rejected?.length) {
      const reason = result.rejected[0]?.reason ?? 'unknown';
      callbacks.recordError(new Error(`Publish rejected: ${reason}`));
      logger.warn(`chat-member-update publish rejected for chat ${chat.id}: ${reason}`);
      return;
    }
    callbacks.trackInbound();
    logger.debug(
      `bot added to ${chat.type} ${chat.id} by ${adderName}` +
        (chatTitle ? ` ("${chatTitle}")` : '')
    );
  } catch (err) {
    callbacks.recordError(err);
    logger.warn(
      `chat-member-update publish failed for chat ${chat.id}:`,
      err instanceof Error ? err.message : String(err)
    );
  }
}
