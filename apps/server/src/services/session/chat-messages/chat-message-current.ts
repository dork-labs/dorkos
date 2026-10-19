/**
 * The chat-message service wired at boot, for callers outside the composition
 * root (heartbeats, `session_start`).
 *
 * @module services/session/chat-messages/chat-message-current
 */
import type { ChatMessageService } from './chat-message-service.js';

let current: ChatMessageService | undefined;

/**
 * Wire the service at boot (or clear it in a test).
 *
 * @param service - The service, or undefined.
 */
export function setChatMessageService(service: ChatMessageService | undefined): void {
  current = service;
}

/** The wired service, or undefined before boot. */
export function getChatMessageService(): ChatMessageService | undefined {
  return current;
}
