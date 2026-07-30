/**
 * Room entity — channels and direct messages (spec `rooms`, ADR
 * 260726-170125). A room is a membership-scoped durable stream: a roster of
 * authors and an append-only log of entries. A thread is a relation between
 * entries in one such log, not a third kind of room (ADR 260728-022013).
 *
 * Every read goes through the `Transport` port, never `fetch`.
 *
 * @module entities/room
 */
export { roomKeys } from './api/query-keys';
export { useRooms, useRoomsByKind } from './model/use-rooms';
export type { RoomsByKind } from './model/use-rooms';
export { useRoom, useRoomEntries, useLoadedRoomEntries } from './model/use-room';
export { useRoomStream, mergeRoomEntry } from './model/use-room-stream';
export type { RoomStreamState } from './model/use-room-stream';
export { useRoomPresence, useRoomPresenceStore, PRESENCE_TICK_MS } from './model/use-room-presence';
export type { RoomPresenceAuthor } from './model/use-room-presence';
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
export { presenceElapsed } from './lib/presence-copy';
export { rungsFor, rungOf, modeForRung, explainRung } from './lib/response-mode';
export type {
  EngagedWindow,
  ResponseRung,
  ResponseRungOption,
  RungExplanation,
} from './lib/response-mode';
export { roomLoudness, previewLoudness, levelOfRung } from './lib/loudness';
export type { LoudnessLevel, RoomLoudness } from './lib/loudness';
export { LoudnessMeter } from './ui/LoudnessMeter';
export { RoomLoudnessLine } from './ui/RoomLoudnessLine';
export { ResponseModeControl } from './ui/ResponseModeControl';
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
