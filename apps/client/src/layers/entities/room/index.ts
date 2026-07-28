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
export type { RoomStreamState } from './model/use-room-stream';
export { usePostToRoom } from './model/use-post-to-room';
export type { PostToRoomInput } from './model/use-post-to-room';
export { useRoomDraft, useRoomDraftStore } from './model/room-drafts';
export { useRoomListStream } from './model/use-room-list-stream';
export { useMarkRoomRead, useMarkRoomReadNow } from './model/use-mark-room-read';
export { useCreateChannel, useStartDirectMessage } from './model/use-create-room';
export type { CreateChannelInput, StartDirectMessageInput } from './model/use-create-room';
export {
  useRenameRoom,
  useSetRoomTopic,
  useArchiveRoom,
  useUnarchiveRoom,
} from './model/use-room-settings';
export type {
  RenameRoomInput,
  SetRoomTopicInput,
  UnarchiveRoomInput,
} from './model/use-room-settings';
export {
  useAddRoomMember,
  useRemoveRoomMember,
  useSetMemberResponseMode,
} from './model/use-room-members';
export type {
  AddRoomMemberInput,
  RemoveRoomMemberInput,
  SetResponseModeInput,
} from './model/use-room-members';
export { roomDisplayTitle, directMessageTitle, authorColor, hasUnread } from './lib/room-display';
export { RESPONSE_MODE_OPTIONS } from './lib/response-mode';
export type { ResponseModeOption } from './lib/response-mode';
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
