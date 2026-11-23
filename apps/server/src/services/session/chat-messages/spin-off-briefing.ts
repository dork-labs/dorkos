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
 * A parent that is not a sendable chat is never named as a `chat_send` target.
 * A scheduled run, a beat, a Telegram or Slack direct chat, a connector event's
 * chat or a chat from before origins were recorded refuses every send, and the
 * spin-off would conclude the parent is unreachable. A room's seat does take a
 * send since DOR-4472 (as a private aside, refused in a bridged room unless it
 * answers the seat), but each one leaves a note in the room and spends one of
 * the room's turns, so milestones ride the turn-end reports a seat receives as
 * turns of its own (DOR-3488). A spin-off with no report route is pointed at
 * whoever its brief names, and a shared room hears only the three project
 * updates (DOR-4469), never its running status.
 *
 * The wait it suggests is one plain command per call, never a shell loop:
 * Claude Code can't check a loop before it runs, so it asks a person
 * (DOR-3109).
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
        ? 'That chat is its agent’s seat in a room. Each chat_send to it would show a note in ' +
            'the room and spend one of its turns, so put milestones in your turn-end reports: ' +
            'each one wakes it with a turn of its own, and nobody else in the room sees it.'
        : `Send milestones before then with chat_send to ${opts.parentChatId}; nobody has to ` +
            'ask. Do not send your final result that way too: it already goes back on its own.',
      'If you are waiting on CI, a timer or a helper, keep your turn alive (for example ' +
        '`gh pr checks --watch`, or one `sleep 240` per call). A turn that ends only to wait may report ' +
        'before the work is done.'
    );
  } else if (opts.parentTakesMessages) {
    lines.push(
      `It does not hear from you on its own. Send what matters with chat_send to ${opts.parentChatId}.`
    );
  } else {
    lines.push(
      'It does not hear from you on its own, and it is not a chat to message: it refuses ' +
        'messages, or each one would show a note in a room. If your brief names a chat or an ' +
        'agent to tell, send what matters there. In a room you share with it, post with ' +
        'post_to_room only when the work starts, is blocked on a person, or ships, or to ' +
        'answer someone who asked; otherwise say it in your own last message.'
    );
  }
  return lines.join(' ');
}
