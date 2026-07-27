/**
 * Room entity — channels, direct messages and threads (spec `rooms`, ADR
 * 260726-170125). A room is a membership-scoped durable stream: a roster of
 * authors and an append-only log of entries.
 *
 * Every read goes through the `Transport` port, never `fetch`.
 *
 * @module entities/room
 */
export { roomKeys } from './api/query-keys';
export { useRooms, useRoomsByKind } from './model/use-rooms';
export type { RoomsByKind } from './model/use-rooms';
export { useRoom, useRoomEntries } from './model/use-room';
export { useRoomStream, mergeRoomEntry } from './model/use-room-stream';
export { useRoomListStream } from './model/use-room-list-stream';
export { useMarkRoomRead } from './model/use-mark-room-read';
export { useCreateChannel, useStartDirectMessage } from './model/use-create-room';
export type { StartDirectMessageInput } from './model/use-create-room';
export { roomDisplayTitle, authorColor, hasUnread } from './lib/room-display';
export { RoomAvatar } from './ui/RoomAvatar';
export { RoomTitle } from './ui/RoomTitle';
export { MemberList } from './ui/MemberList';
export type {
  AuthorRef,
  Room,
  RoomEntry,
  RoomKind,
  RoomRosterEntry,
  RoomSummary,
  RoomWithRoster,
} from '@dorkos/shared/room-schemas';
