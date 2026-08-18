/**
 * `Conversation.Root` — the one place a surface says what it is.
 *
 * Everything below it reads {@link useConversation} and branches on
 * `capabilities`. This file is the ONLY file in the slice allowed to hold the
 * word `surface` in a comparison, and `__tests__/no-surface-switches.test.ts`
 * enforces that mechanically.
 *
 * @module features/conversation/ui/ConversationRoot
 */
import { useMemo, type ReactNode } from 'react';
import type { ConversationCapabilities, ConversationSurface } from '../model/capabilities';
import { ConversationContext, type ConversationContextValue } from '../model/conversation-context';
import type { ConversationTarget } from '../model/target';

interface ConversationRootProps {
  /** Which presentation this is. */
  surface: ConversationSurface;
  /** What this conversation can do — the whole of what differs between surfaces. */
  capabilities: ConversationCapabilities;
  /**
   * Where a draft goes. Omitted until the host mounts `Conversation.Composer`,
   * which lands in P4 (DOR-1331).
   */
  target?: ConversationTarget;
  /** How tightly rows are packed. Defaults to `comfortable`. */
  density?: 'comfortable' | 'compact';
  /**
   * Where a row's hover actions are held.
   *
   * `corner` pins them to the row's top right; `rail` hands them to a sticky
   * band that stays reachable on a message longer than the window. This carries
   * the whole visual difference between the two rows the cockpit draws today —
   * see `message-variants.ts`, which explains why each surface wants its own.
   * Defaults to `corner`, matching the variant's own default.
   */
  anchor?: 'corner' | 'rail';
  /** The conversation's own tree — header, timeline, lane, composer, footer. */
  children: ReactNode;
}

/**
 * Provide the conversation every part below reads.
 *
 * It renders no element of its own: a provider that also drew a box would make
 * every host inherit a layout it did not ask for, and the two hosts lay their
 * chrome out differently on purpose (a room's scroller has slots above and
 * below it that a session's does not).
 */
export function ConversationRoot({
  surface,
  capabilities,
  target,
  density = 'comfortable',
  anchor = 'corner',
  children,
}: ConversationRootProps) {
  const value = useMemo<ConversationContextValue>(
    () => ({ surface, capabilities, target: target ?? null, density, anchor }),
    [surface, capabilities, target, density, anchor]
  );

  return <ConversationContext.Provider value={value}>{children}</ConversationContext.Provider>;
}
