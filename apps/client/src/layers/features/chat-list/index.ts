/**
 * Chat list feature — one agent's chats, sorted for choosing one, drawn by
 * Profile → Sessions and Switch session alike (spec `your-activity-first`
 * D11, D12, D14).
 *
 * Other features render {@link ChatList}; that is UI composition, the one
 * cross-feature reach the layer rules allow. The model stays here, so there
 * is one arrangement and no second copy of it.
 *
 * @module features/chat-list
 */
export { ChatList, CHAT_LIST_SLOT } from './ui/ChatList';
export type { ChatListProps } from './ui/ChatList';
export { CHAT_LIST_ROW_SLOT, CHAT_LIST_SPIN_OFF_TOGGLE_SLOT } from './ui/ChatListRow';
