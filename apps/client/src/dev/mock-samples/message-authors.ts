import type { MessageAuthor } from '@/layers/shared/model';

/**
 * Stand-in participants for a message row's identity gutter, shared by every
 * bench that draws one. One set, so a change to how a face resolves shows up in
 * every showcase at once rather than in whichever one was remembered.
 *
 * @module dev/mock-samples/message-authors
 */
export const HUMAN_AUTHOR: MessageAuthor = { kind: 'human', id: 'human', displayName: 'You' };

/** An agent with a stored emoji and colour — the branded case. */
export const AGENT_AUTHOR: MessageAuthor = {
  kind: 'agent',
  id: 'dorkbot',
  displayName: 'DorkBot',
  emoji: '\u{1F916}',
  color: 'hsl(210, 70%, 55%)',
};
