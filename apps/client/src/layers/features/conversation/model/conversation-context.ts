/**
 * The one thing every part of a conversation can read.
 *
 * `Conversation.Root` publishes it; the row, the lane and the composer host read
 * it. It carries what the surface IS (`surface`, for the one place that has to
 * choose a word), what it CAN DO (`capabilities`, which is what behaviour
 * branches on), where words go (`target`), and the two presentation dials
 * (`density`, `anchor`).
 *
 * @module features/conversation/model/conversation-context
 */
import { createContext, useContext } from 'react';
import type { ConversationCapabilities, ConversationSurface } from './capabilities';
import type { ConversationTarget } from './target';

/** Everything a part of a conversation may know about the conversation it is in. */
export interface ConversationContextValue {
  /** Which presentation this is. Never branch behaviour on it — see `capabilities`. */
  surface: ConversationSurface;
  /** What this conversation can do. */
  capabilities: ConversationCapabilities;
  /**
   * Where a draft goes.
   *
   * `null` until the host mounts `Conversation.Composer`, which lands in P4
   * (DOR-1331). Nothing in the row family reads it, and a host that has no
   * composer yet says so rather than handing down a stub whose `send` throws.
   */
  target: ConversationTarget | null;
  /** How tightly rows are packed. */
  density: 'comfortable' | 'compact';
  /** Where a row's hover actions are held — the corner, or a sticky rail. */
  anchor: 'corner' | 'rail';
}

/**
 * The conversation a part belongs to, or `null` outside one.
 *
 * Exported for `Conversation.Root` alone. Everything else reads it through
 * {@link useConversation}, which turns the `null` into a named error instead of
 * letting a part render half-configured.
 */
export const ConversationContext = createContext<ConversationContextValue | null>(null);

/** Read the conversation this part belongs to. Throws outside `Conversation.Root`. */
export function useConversation(): ConversationContextValue {
  const value = useContext(ConversationContext);
  if (value === null) {
    throw new Error(
      'useConversation must be used inside a <Conversation.Root>. A message row, the live lane and the composer host all read the conversation they are in — rendering one outside a Root would leave it guessing at capabilities it must never guess at.'
    );
  }
  return value;
}
