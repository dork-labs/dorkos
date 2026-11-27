/**
 * What the computer side reads and moves of the chat-message rows (what chats
 * sent each other), without reaching across the wall into the store that keeps
 * them (spec `computer-side-starts-alone` §5.12).
 *
 * The store lives on the space side (`../chat-messages/chat-message-store.ts`).
 * Startup hands this module its narrow view (`../chat-messages/computer-chat-rows.ts`)
 * right after it wires the store, so every process that keeps chat-message
 * rows hands them over and one that keeps none hands nothing. Until then,
 * nothing is read and nothing moves, exactly as when no store is wired: a
 * history shows no other chat's stops, and a rekey carries no chat rows.
 *
 * @module services/session/chat-rows/chat-rows-port
 */

/** One stop another chat made on this chat, as its "Stopped by" line reads. */
export interface RecordedChatStop {
  /** ISO-8601 wall-clock the stop was recorded at, just after the interrupt. */
  createdAt: string;
  /** "Stopped by <agent> · <chat>". */
  byLine: string;
}

/** The chat-message rows as the computer side reads and moves them. */
export interface ChatRowsPort {
  /**
   * Carry what chats sent this one, or sent from it, to the id it was rekeyed
   * to: the Sent cards, the senders on its received messages, its read cursors.
   */
  rekeySession(fromId: string, toId: string): void;
  /** The stops other chats made on this chat that stopped it, oldest first. */
  stopsOf(sessionId: string): RecordedChatStop[];
}

let port: ChatRowsPort | undefined;

/**
 * Register (or clear) the view of the chat-message rows.
 *
 * @param next - The view, or `undefined` to clear it.
 */
export function setChatRowsPort(next: ChatRowsPort | undefined): void {
  port = next;
}

/** The registered view of the chat-message rows, or `undefined` before startup hands it over. */
export function chatRowsPort(): ChatRowsPort | undefined {
  return port;
}
