/**
 * The chat list's two modified `↵` keys, and how a key finds its row.
 *
 * @module features/chat-list/model/use-chat-list-keys
 */
import { useCallback, useRef, type KeyboardEvent, type Ref } from 'react';

/** What {@link useChatListKeys} hands the list. */
export interface ChatListKeys {
  /** A ref for one row's button, so a key pressed on it knows its chat. */
  registerRow: (sessionId: string) => Ref<HTMLButtonElement>;
  /** Put on the list's root: `⌘↵` starts a new chat, `⇧↵` forks the row you are on. */
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

/**
 * `⌘↵` and `⇧↵`, caught before the browser turns them into a click. A focused
 * button activates on Enter whatever modifiers are held, so both would open
 * the focused chat unless taken here. Plain `↵` is the row's own.
 *
 * Keys pressed outside the list's own DOM are ignored: a row's menu renders in
 * a portal, and React still bubbles its keydowns through the list, so `⌘↵` on
 * a menu item would otherwise start a chat. Text fields keep their Enter.
 *
 * Rows are found by ELEMENT in a WeakMap: a row moving between sections mounts
 * its new node before the old one detaches, and an id-keyed map cleaned up on
 * detach would lose the entry the fresh node just wrote.
 *
 * @param onNewChat - Start a new chat.
 * @param onFork - Fork the chat a row belongs to.
 */
export function useChatListKeys(
  onNewChat: () => void,
  onFork: (sessionId: string) => void
): ChatListKeys {
  const rowSessions = useRef(new WeakMap<HTMLButtonElement, string>());
  const registerRow = useCallback(
    (sessionId: string) => (element: HTMLButtonElement | null) => {
      if (element !== null) rowSessions.current.set(element, sessionId);
    },
    []
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.key !== 'Enter') return;
      const target = event.target;
      if (!(target instanceof Node) || !event.currentTarget.contains(target)) return;
      if (target instanceof HTMLInputElement) return;
      if (event.metaKey || event.ctrlKey) {
        event.preventDefault();
        onNewChat();
        return;
      }
      if (!event.shiftKey || !(target instanceof HTMLButtonElement)) return;
      const sessionId = rowSessions.current.get(target);
      if (sessionId === undefined) return;
      event.preventDefault();
      onFork(sessionId);
    },
    [onFork, onNewChat]
  );

  return { registerRow, onKeyDown };
}
