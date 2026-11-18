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

/** Private peer-seat route, composed once its receipt store and rooms both exist. */
let seatMessageFactory:
  import('../../rooms/handoff/seat-message-types.js').RoomSeatMessageFactory | undefined;
let seatMessages:
  import('../../rooms/handoff/seat-message-types.js').RoomSeatMessagesPort | undefined;
let seatMessageStore: import('./chat-message-store.js').ChatMessageStore | undefined;
let seatMessageEmit: ((sessionId: string) => void) | undefined;
let seatLifetime: object | undefined;

/** Dispose the current peer route coherently; stale lifetime owners cannot dispose a successor. */
export function disposeRoomSeatMessages(expected?: object): void {
  if (expected && expected !== seatLifetime) return;
  const previous = seatMessages;
  seatMessages = undefined;
  seatMessageStore = undefined;
  seatMessageEmit = undefined;
  seatMessageFactory = undefined;
  seatLifetime = undefined;
  previous?.stop();
}

/** Register the rooms-owned private route factory before serving chat tools. */
export function setRoomSeatMessageFactory(factory: typeof seatMessageFactory): void {
  if (!factory) {
    disposeRoomSeatMessages();
    return;
  }
  seatMessages?.stop();
  seatMessages = undefined;
  seatMessageFactory = factory;
  if (seatMessageStore && seatMessageEmit) getRoomSeatMessages(seatMessageStore, seatMessageEmit);
}

/** Recover interrupted rows as soon as both halves are wired, in either boot order. */
function getRoomSeatMessages(
  store: import('./chat-message-store.js').ChatMessageStore,
  emit: (sessionId: string) => void
): import('../../rooms/handoff/seat-message-types.js').RoomSeatMessagesPort | undefined {
  if (seatMessageStore && seatMessageStore !== store) {
    seatMessages?.stop();
    seatMessages = undefined;
  }
  seatLifetime ??= {};
  seatMessageStore = store;
  seatMessageEmit = emit;
  return (seatMessages ??= seatMessageFactory?.(store, emit));
}

/** Bind one chat service to its own route lifetime, not a mutable global getter at shutdown. */
export function wireRoomSeatMessageLifetime(
  store: import('./chat-message-store.js').ChatMessageStore,
  emit: (sessionId: string) => void
): {
  get: () => import('../../rooms/handoff/seat-message-types.js').RoomSeatMessagesPort | undefined;
  stop: () => void;
} {
  seatMessages?.stop();
  seatMessages = undefined;
  const token = {};
  seatLifetime = token;
  getRoomSeatMessages(store, emit);
  return {
    get: () => (seatLifetime === token ? getRoomSeatMessages(store, emit) : undefined),
    stop: () => disposeRoomSeatMessages(token),
  };
}

/** Wire both distinct seat routes from the room composition root without growing its façade. */
export function setRoomSeatRoutes(
  service: Pick<
    import('../../rooms/room-service.js').RoomService,
    'handoffs' | 'createSeatMessages'
  >
): void {
  setRoomSeatReports(service.handoffs.reports);
  setRoomSeatMessageFactory((store, emit) => service.createSeatMessages(store, emit));
}
