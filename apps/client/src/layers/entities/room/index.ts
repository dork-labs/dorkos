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
export { useThreads } from './model/use-threads';
export type { RoomsByKind } from './model/use-rooms';
export { useRoom, useRoomEntries, useLoadedRoomEntries } from './model/use-room';
export { useRoomStream, mergeRoomEntry } from './model/use-room-stream';
export type { RoomStreamState } from './model/use-room-stream';
export {
  useRoomPresence,
  useRoomPresenceAuthorIds,
  useRoomPresenceStore,
  PRESENCE_TICK_MS,
} from './model/use-room-presence';
export type { PresenceScope, RoomPresenceAuthor } from './model/use-room-presence';
export { useRoomWorking, useRoomWorkingStore, useOpenRoomWorking } from './model/use-room-working';
export { usePostToRoom } from './model/use-post-to-room';
export type { PostToRoomInput } from './model/use-post-to-room';
export { useHaltRoom } from './model/use-halt-room';
export type { HaltRoomInput } from './model/use-halt-room';
export {
  usePendingPosts,
  usePendingPostStore,
  newPendingId,
  findLandedEcho,
  PENDING_SLOW_MS,
  PENDING_ECHO_WINDOW_MS,
} from './model/pending-posts';
export type { PendingPost, PendingPostStatus } from './model/pending-posts';
export { useReplyInThread } from './model/use-reply-in-thread';
export { useToggleReaction } from './model/use-toggle-reaction';
export type { ToggleReactionInput } from './model/use-toggle-reaction';
export {
  REACTION_ROW_LIMIT,
  applyReactionToggle,
  hasReacted,
  mergeRoomReactions,
  reactionSummary,
  splitReactionRow,
} from './lib/reactions';
export { useRoomDraft, useRoomDraftStore, threadDraftKey } from './model/room-drafts';
export { useRoomOpenThread, useRoomOpenThreadStore } from './model/open-thread';
export type { OpenThread } from './model/open-thread';
export { useComposerFocusRequest, useComposerFocusStore } from './model/composer-focus';
export { useRoomListStream } from './model/use-room-list-stream';
export { useMarkRoomRead, useMarkRoomReadNow } from './model/use-mark-room-read';
export { useCreateChannel, useStartDirectMessage } from './model/use-create-room';
export type { CreateChannelInput, StartDirectMessageInput } from './model/use-create-room';
export {
  useRenameRoom,
  useSetRoomTopic,
  useArchiveRoom,
  useUnarchiveRoom,
  useSetDeliverNotices,
} from './model/use-room-settings';
export type {
  RenameRoomInput,
  SetRoomTopicInput,
  UnarchiveRoomInput,
  SetDeliverNoticesInput,
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
export {
  roomDisplayTitle,
  directMessageTitle,
  authorColor,
  hasUnread,
  platformLabel,
} from './lib/room-display';
export { roomIdentityMark, identityMarkFaces } from './lib/identity-mark';
export type { IdentityMark, RoomIdentityMarkInput } from './lib/identity-mark';
export { replyRootFor, threadReplySummary, threadRootIdOf } from './lib/thread';
export type { ThreadReplySummary } from './lib/thread';
export { presenceElapsed } from './lib/presence-copy';
export { RESPONSE_RUNGS, rungOf, modeForRung, explainRung } from './lib/response-mode';
export type {
  EngagedWindow,
  ResponseRung,
  ResponseRungOption,
  RungExplanation,
} from './lib/response-mode';
export { roomLoudness, previewLoudness, levelOfRung } from './lib/loudness';
export type { LoudnessLevel, LoudnessPreview, RoomLoudness } from './lib/loudness';
export { LoudnessMeter } from './ui/LoudnessMeter';
export { RoomLoudnessLine } from './ui/RoomLoudnessLine';
export { ResponseModeControl } from './ui/ResponseModeControl';
export { RoomAvatar } from './ui/RoomAvatar';
export { RoomTitle } from './ui/RoomTitle';
export { MemberList } from './ui/MemberList';
export { OriginMark } from './ui/OriginMark';
export { BridgeVisibilityBadge } from './ui/BridgeVisibilityBadge';
export type {
  AuthorOrigin,
  AuthorRef,
  Room,
  RoomBridgeInfo,
  RoomEntry,
  RoomEntryReaction,
  RoomKind,
  RoomRosterEntry,
  RoomSummary,
  RoomWithRoster,
} from '@dorkos/shared/room-schemas';
