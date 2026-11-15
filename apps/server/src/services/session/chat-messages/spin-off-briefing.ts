/**
 * Build the instructions a spin-off chat reads when it starts.
 *
 * @module services/session/chat-messages/spin-off-briefing
 */

/**
 * The note a spin-off reads at its start (spec `spin-off-chats` §5): who
 * started it, and how it reports. Every word is DorkOS's own except the
 * parent's title and agent name, which DorkOS also holds.
 *
 * A parent that cannot take chat messages (a room's seat, a bridged chat, a
 * scheduled run) is never named as a `chat_send` target: every such send is
 * refused, and the spin-off would conclude the parent is unreachable. A room's
 * seat still takes reports, as turns of its own (DOR-3488).
 *
 * @param opts - The parent, whether reports go back on their own, whether the
 *   parent takes chat messages at all, and whether it is a room's seat.
 */
export function spinOffBriefing(opts: {
  parentChatId: string;
  parentTitle: string | null;
  parentAgentName: string;
  reportBack: boolean;
  parentTakesMessages: boolean;
  parentIsRoomSeat?: boolean;
}): string {
  const parent = `${opts.parentTitle ? `"${opts.parentTitle}" ` : ''}(chat ${opts.parentChatId}, ${opts.parentAgentName})`;
  const lines = [`This is a spin-off chat. The chat ${parent} started it.`];
  if (opts.reportBack) {
    lines.push(
      'When you end a turn finished, failed, waiting on the person, or paused at a usage ' +
        'limit, your last message goes back to that chat on its own. So end each turn with a ' +
        'short report: what you did and what is left.',
      opts.parentIsRoomSeat
        ? 'That chat is its agent’s seat in a room, so it takes no chat_send: your report wakes ' +
            'it with a turn of its own, and nobody else in the room sees it. Put milestones in ' +
            'your turn-end reports.'
        : `Send milestones before then with chat_send to ${opts.parentChatId}; nobody has to ` +
            'ask. Do not send your final result that way too: it already goes back on its own.',
      'If you are waiting on CI, a timer or a helper, keep your turn alive (for example ' +
        '`gh pr checks --watch` or a short sleep loop). A turn that ends only to wait may report ' +
        'before the work is done.'
    );
  } else if (opts.parentTakesMessages) {
    lines.push(
      `It does not hear from you on its own. Send what matters with chat_send to ${opts.parentChatId}.`
    );
  } else {
    lines.push(
      'It does not hear from you on its own, and it cannot take chat messages. If it works in ' +
        'a room you are in, report there with post_to_room; otherwise say it in your own last ' +
        'message.'
    );
  }
  return lines.join(' ');
}
