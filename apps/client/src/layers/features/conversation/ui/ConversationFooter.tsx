/**
 * `Conversation.Footer` — the strip under the field.
 *
 * A slot, not a component with an opinion: what goes here is a session's model
 * / permission-mode / git / runtime readout (`ChatStatusSection`), and a
 * channel has none, so the footer holds whatever its host puts in it and
 * nothing of its own.
 *
 * @module features/conversation/ui/ConversationFooter
 */
import { Slot } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '@/layers/shared/lib';

interface ConversationFooterProps {
  /**
   * Render as the child element rather than wrapping it.
   *
   * Load-bearing here rather than decorative: the composer card's markup is
   * pinned by a serialized-DOM baseline (`test-helpers/dom-parity.ts`), and the
   * session's footer content is already a direct child of the card. A wrapper
   * would be a node the baseline does not have, for no reader's benefit.
   */
  asChild?: boolean;
  /** What the footer says. */
  children: ReactNode;
  /** Extra classes, when the footer is drawing its own box. */
  className?: string;
}

/**
 * Draw whatever sits below a conversation's field.
 *
 * @param props - The content, and whether to be it rather than wrap it.
 */
export function ConversationFooter({ asChild, children, className }: ConversationFooterProps) {
  const Comp = asChild === true ? Slot.Root : 'div';
  return (
    <Comp data-slot="conversation-footer" className={cn(className)}>
      {children}
    </Comp>
  );
}
