/**
 * The chat-message service wired at boot, for callers outside the composition
 * root (heartbeats, `session_start`).
 *
 * @module services/session/chat-messages/chat-message-current
 */
import type { RoomSeatReports } from '../../rooms/handoff/seat-report.js';
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

/** What report-back asks of the rooms: whether a chat is a seat, and a report into one. */
export type RoomSeatReportsPort = Pick<RoomSeatReports, 'seatOf' | 'deliver'>;

let seatReports: RoomSeatReportsPort | undefined;

/**
 * Wire the rooms' seat reports at boot (or clear them in a test), so a spin-off
 * started from a room's seat reports back into it (DOR-3488).
 *
 * @param port - The room service's seat reports, or undefined.
 */
export function setRoomSeatReports(port: RoomSeatReportsPort | undefined): void {
  seatReports = port;
}

/** The wired seat reports, or undefined before the rooms boot. */
export function getRoomSeatReports(): RoomSeatReportsPort | undefined {
  return seatReports;
}
