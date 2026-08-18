/**
 * The row's computed look, published once and read by each part.
 *
 * `messageItem` is a multi-slot `tailwind-variants` definition, and calling it
 * is the only place the four dials — role, position, density, anchor — are
 * resolved into classes. `Message.Root` calls it ONCE and puts the result here;
 * `Message.Gutter` reads `gutter`, `Message.Author` reads `header`, and so on.
 * A part that recomputed the variant could disagree with its own row about
 * which anchor it is on, and the disagreement would only show up on screen.
 *
 * `position` rides along with the classes because it is the same call's input
 * and two parts derive one fact from it — "does this row open an author group?"
 * `Message.Gutter` draws the avatar or the hover timestamp from it, and
 * `Message.Author` draws itself or nothing. Both rows in the cockpit today
 * derive that rather than taking it as a prop, for the reason they each write
 * down: two sources for one fact can only ever drift apart.
 *
 * @module features/conversation/ui/message/message-styles-context
 */
import { createContext, useContext, type ReactNode } from 'react';
import { messageItem } from './message-variants';

/** Where a row sits in its author group. */
export type MessagePosition = 'first' | 'middle' | 'last' | 'only';

/** The slot classNames one `messageItem()` call produced. */
export type MessageSlots = ReturnType<typeof messageItem>;

/** What every part of a row reads about how the row is drawn. */
export interface MessageStylesContextValue {
  /** The slot classNames, from the row's single `messageItem()` call. */
  slots: MessageSlots;
  /** Where the row sits in its author group — what "opens a group" is derived from. */
  position: MessagePosition;
}

const MessageStylesContext = createContext<MessageStylesContextValue | null>(null);

/**
 * Publish one row's computed look to its parts.
 *
 * Rendered by `Message.Root` and nothing else — a second provider would mean a
 * second `messageItem()` call, which is the exact thing this context exists to
 * prevent.
 */
export function MessageStylesProvider({
  value,
  children,
}: {
  /** The row's slot classNames and its grouping position. */
  value: MessageStylesContextValue;
  /** The row's parts. */
  children: ReactNode;
}) {
  return <MessageStylesContext.Provider value={value}>{children}</MessageStylesContext.Provider>;
}

/** Read the row's computed look. Throws outside `Message.Root`. */
export function useMessageStyles(): MessageStylesContextValue {
  const value = useContext(MessageStylesContext);
  if (value === null) {
    throw new Error(
      'A Message part must be rendered inside <Message.Root>. Each part draws itself with a slot of the row’s single messageItem() call, and there is no honest default for a row that was never computed.'
    );
  }
  return value;
}

/** True when this position opens an author group — the avatar and the name line. */
export function opensAuthorGroup(position: MessagePosition): boolean {
  return position === 'first' || position === 'only';
}
