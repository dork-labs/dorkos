/**
 * Typed wrapper for Telegram's unofficial draft-streaming API.
 *
 * Telegram Bot API does not officially expose `sendMessageDraft` in its
 * type definitions, but the method is available on certain clients for
 * real-time draft previews. This module isolates the `as unknown` cast
 * into a single location so callers can use a clean, typed function.
 *
 * @module relay/adapters/telegram/stream-api
 */
import type { Bot } from 'grammy';

/** Shape of the unofficial sendMessageDraft method on Bot.api. */
interface TelegramDraftApi {
  sendMessageDraft: (chatId: number, text: string) => Promise<void>;
}

/**
 * Send a draft message preview to a Telegram chat.
 *
 * Uses the unofficial `sendMessageDraft` method on the Bot API. This
 * method may not be available on all Telegram Bot API implementations;
 * callers should handle errors gracefully.
 *
 * @param bot - The grammy Bot instance
 * @param chatId - The Telegram chat ID to send the draft to
 * @param text - The draft message text to preview
 */
export async function sendMessageDraft(bot: Bot, chatId: number, text: string): Promise<void> {
  await (bot.api as unknown as TelegramDraftApi).sendMessageDraft(chatId, text);
}
