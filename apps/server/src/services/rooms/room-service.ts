/**
 * Room orchestration: create, join, post, read cursor, thread replies.
 *
 * The service owns the rules a room has that the tables cannot state — a reply
 * may not hang off another reply, a channel slug is unique while it is
 * live — and it publishes what happened to the two streams a room fans out on:
 * its own SSE stream for entries and signals, the global `/api/events` stream
 * for lifecycle. Membership lives next door in `room-roster.ts`, and turning a
 * committed post into agent replies lives in `room-trigger.ts`.
 *
 * **This class is the domain's front door and nothing else** (DOR-1697). Every
 * rule it used to hold inline now lives in a collaborator beside it, built
 * once from the shared {@link RoomCore} and reached through the method that
 * always named it. The public surface did not move: what routes, tools, the
 * community adapter and the tests call is exactly what they called before.
 * Each group of delegations below names the module that owns those rules,
 * and they sit in three folders beside this file: `service/` (the shared
 * machinery — the state, the wiring, and who may see or change a room),
 * `manage/` (a room, its people, and the turns running in it), and
 * `messages/` (what is said in one, and how it is read back).
 *
 * @module server/services/rooms/room-service
 */
import type { DbTransaction } from '@dorkos/db';
import type { ResponseMode } from '@dorkos/shared/mesh-schemas';
import type { SignalType } from '@dorkos/shared/relay-schemas';
import type {
  CanvasDocument,
  CreateRoomRequest,
  Room,
  RoomEntry,
  RoomEntryBody,
  RoomEntryListResponse,
  RoomEntryReaction,
  RoomEvent,
  RoomKind,
  RoomMember,
  RoomMergeEvent,
  RoomMoment,
  RoomPresencePayload,
  RoomReactionEvent,
  RoomRosterEntry,
  RoomSessionBinding,
  RoomSummary,
  RoomWithRoster,
  ThreadSummary,
  UpdateRoomRequest,
} from '@dorkos/shared/room-schemas';
import type { RoomExportLine } from '@dorkos/shared/room-export-schemas';
import type { AuthorRecord, AuthorRegistry } from './author-registry.js';
import type { CreateBridgedRoomRequest } from './manage/room-bridge-create.js';
import type { RebridgeRequest } from './manage/room-bridge-lifecycle.js';
import type { ActiveClaimView, HeldView } from './room-claims.js';
import { createRoomCollaborators, type RoomCollaborators } from './service/room-collaborators.js';
import type { RoomCanvasService } from './canvas/room-canvas-service.js';
import type { RoomExternalPostInput } from './messages/room-entry-writer.js';
import type {
  MemberRoomMatch,
  MemberRoomSummary,
  RoomDetail,
  FindMemberRoomsFilter,
} from './manage/room-member-directory.js';
import type { RoomPostInput } from './messages/room-posting.js';
import type { RoomSignalListener } from './service/room-publisher.js';
import type { AddMemberInput } from './room-roster.js';
import type {
  OpenedRoom,
  PostedEntry,
  RoomSearchScope,
  RoomServiceDeps,
} from './service/room-service-deps.js';
import type { RoomBroadcaster } from './room-stream.js';
import type { RoomTriggerDispatcher } from './room-trigger.js';

// Re-exported so every existing importer of this module keeps resolving
// exactly what it resolved before the split (DOR-1697). Each symbol now lives
// in the module that owns the rule it belongs to.
export type {
  PostTrigger,
  OpenedRoom,
  PostedEntry,
  RoomEntryIndexer,
  RoomMessageFinder,
  RoomSearchScope,
  RoomServiceDeps,
} from './service/room-service-deps.js';
export type { CreateBridgedRoomRequest } from './manage/room-bridge-create.js';
export type { RebridgeRequest } from './manage/room-bridge-lifecycle.js';
export type { RoomExternalPostInput } from './messages/room-entry-writer.js';
export type { RoomPostInput } from './messages/room-posting.js';
export type { RoomSignalListener } from './service/room-publisher.js';
export { HISTORY_PAGE_MAX } from './messages/room-reads.js';
export {
  FIND_ROOMS_MAX,
  MEMBER_ROOMS_PAGE_MAX,
  normalizeMemberHandle,
  normalizeRoomNameNeedle,
  type FindMemberRoomsFilter,
  type MemberRoomMatch,
  type MemberRoomSummary,
  type RoomDetail,
  type RoomMemberSummary,
} from './manage/room-member-directory.js';

/** Orchestration over the store, the roster, the author registry and the streams. */
export class RoomService {
  private readonly parts: RoomCollaborators;
  /**
   * The trigger dispatcher this service drives.
   *
   * Held at the door rather than only inside the collaborators that use it,
   * because it is this domain's one piece of live in-memory state — the claim
   * map — and the suites that drive a turn reach it by this name.
   */
  private readonly triggers: RoomTriggerDispatcher;

  constructor(deps: RoomServiceDeps) {
    // The dispatcher writes back through THIS class, not through the modules
    // behind it: a reply has always been written by `post` and a refusal by
    // `postNotice`, and anything that wraps either — a test, a future
    // decorator — has to keep seeing them. `progress` is bound here, so the one
    // signal name presence may use is not a decision the dispatcher can get
    // wrong.
    this.parts = createRoomCollaborators(deps, {
      post: (roomId, input) => this.post(roomId, input),
      postNotice: (roomId, body, cascade, replyTo) =>
        this.postNotice(roomId, body, cascade, replyTo),
      publishPresence: (roomId, authorId, presence) =>
        this.publishSignal(roomId, 'progress', authorId, presence),
    });
    this.triggers = this.parts.core.triggers;
  }

  /** The live subscription source behind `GET /api/rooms/:id/events`. */
  get stream(): RoomBroadcaster {
    return this.parts.core.broadcaster;
  }
  /** The author registry, for callers that need to resolve their own identity. */
  get authorRegistry(): AuthorRegistry {
    return this.parts.core.authors;
  }
  /**
   * The room's shared canvas — the table, and the single writer that changes it.
   *
   * Reachable from the front door because the one coalesced entry a turn writes
   * is a room entry, and this class owns the single write path into a room's log
   * (spec `room-canvas` §3).
   */
  get canvas(): RoomCanvasService {
    return this.parts.canvas;
  }
  /** Every room turn in flight right now. See {@link RoomTurnControl.listActiveClaims}. */
  listActiveClaims(): ActiveClaimView[] {
    return this.parts.turnControl.listActiveClaims();
  }
  /** Every workspace with a room turn in it. See {@link RoomTurnControl.listBusyAgentPaths}. */
  listBusyAgentPaths(): string[] {
    return this.parts.turnControl.listBusyAgentPaths();
  }
  /** One room's agent members, with paths. See {@link RoomTurnControl.listAgentMembers}. */
  listAgentMembers(roomId: string): { authorId: string; agentPath: string; displayName: string }[] {
    return this.parts.turnControl.listAgentMembers(roomId);
  }
  /** Every message waiting on a busy agent. See {@link RoomTurnControl.listHolds}. */
  listHolds(): HeldView[] {
    return this.parts.turnControl.listHolds();
  }
  /**
   * Resolve once every turn a post triggered has finished.
   *
   * A cascade is asynchronous by construction — posting returns before any
   * agent has answered — so this is how a caller waits it out without sleeping.
   */
  triggersIdle(): Promise<void> {
    return this.triggers.idle();
  }
  /**
   * Whether this agent is mid-turn in this room right now.
   *
   * The claim map, asked as a yes-or-no. It is what makes a mechanical presence
   * signal honest: a face only goes on a canvas tab because a turn that is
   * really running read that document, never because an agent with no work in
   * hand called a tool.
   *
   * @param roomId - The room.
   * @param authorId - The agent.
   * @returns True while a claim is held here.
   */
  isWorkingHere(roomId: string, authorId: string): boolean {
    return this.triggers.activeTurnHere(roomId, authorId) !== undefined;
  }
  /** Stop everything running in one room. See {@link RoomTurnControl.haltRoom}. */
  haltRoom(roomId: string, viewerAuthorId: string): Promise<number> {
    return this.parts.turnControl.haltRoom(roomId, viewerAuthorId);
  }
  /** Stop one agent in a room. See {@link RoomTurnControl.haltAgent}. */
  haltAgent(roomId: string, authorId: string, viewerAuthorId: string): Promise<number> {
    return this.parts.turnControl.haltAgent(roomId, authorId, viewerAuthorId);
  }
  /** Ask to be answered first. See {@link RoomTurnControl.promoteHold}. */
  promoteHold(roomId: string, authorId: string, viewerAuthorId: string): boolean {
    return this.parts.turnControl.promoteHold(roomId, authorId, viewerAuthorId);
  }
  /** Ask one agent something the room never posted. See {@link RoomTurnControl.askAside}. */
  askAside(input: {
    roomId: string;
    authorId: string;
    aboutEntryId: string;
    prompt: string;
  }): Promise<string | null> {
    return this.parts.turnControl.askAside(input);
  }
  /** Open a channel or a DM. See {@link RoomLifecycle.createRoom}. */
  createRoom(request: CreateRoomRequest, creatorAuthorId: string): OpenedRoom {
    return this.parts.lifecycle.createRoom(request, creatorAuthorId);
  }
  /** Record a room's fallback seat. See {@link RoomLifecycle.setFallbackSeat}. */
  setFallbackSeat(roomId: string, operatorAuthorId: string, authorId: string | null): Room {
    return this.parts.lifecycle.setFallbackSeat(roomId, operatorAuthorId, authorId);
  }
  /** Get — or open, once — a well-known channel. See {@link RoomLifecycle.ensureSystemChannel}. */
  ensureSystemChannel(
    wellKnown: string,
    seed: { slug: string; topic?: string },
    operatorAuthorId: string
  ): { room: Room; created: boolean } {
    return this.parts.lifecycle.ensureSystemChannel(wellKnown, seed, operatorAuthorId);
  }
  /** Open a room for a claimed chat. See {@link RoomBridgeCreation.createBridgedRoom}. */
  createBridgedRoom(request: CreateBridgedRoomRequest): OpenedRoom {
    return this.parts.bridgeCreation.createBridgedRoom(request);
  }
  /** Disconnect a bridged room. See {@link RoomBridgeLifecycle.archiveBridgedRoom}. */
  archiveBridgedRoom(
    roomId: string,
    operatorAuthorId: string,
    opts: { reason?: string } = {}
  ): void {
    this.parts.bridgeLifecycle.archiveBridgedRoom(roomId, operatorAuthorId, opts);
  }
  /** Re-bridge a surviving chat. See {@link RoomBridgeLifecycle.rebridge}. */
  rebridge(request: RebridgeRequest): OpenedRoom {
    return this.parts.bridgeLifecycle.rebridge(request);
  }
  /** Bind a session adopted at bridge time. See {@link RoomBridgeLifecycle.bindAdoptedSession}. */
  bindAdoptedSession(roomId: string, agentAuthorId: string, sessionId: string): void {
    this.parts.bridgeLifecycle.bindAdoptedSession(roomId, agentAuthorId, sessionId);
  }
  /** Post a bridge's history notice. See {@link RoomBridgeLifecycle.postBridgeHistoryNotice}. */
  postBridgeHistoryNotice(roomId: string, priorSession: boolean): void {
    this.parts.bridgeLifecycle.postBridgeHistoryNotice(roomId, priorSession);
  }
  /** The rooms this viewer may list, with unread counts. See {@link RoomDirectory.listRooms}. */
  listRooms(
    viewerAuthorId: string,
    filter: { kind?: RoomKind; includeArchived?: boolean } = {}
  ): RoomSummary[] {
    return this.parts.directory.listRooms(viewerAuthorId, filter);
  }
  /** Every thread this reader takes part in. See {@link RoomDirectory.listThreads}. */
  listThreads(viewerAuthorId: string, limit: number): ThreadSummary[] {
    return this.parts.directory.listThreads(viewerAuthorId, limit);
  }
  /** One room with its roster. See {@link RoomDirectory.getRoom}. */
  getRoom(roomId: string, viewerAuthorId: string): RoomWithRoster | null {
    return this.parts.directory.getRoom(roomId, viewerAuthorId);
  }
  /** Which session each of a room's agents answers in. See {@link RoomDirectory.listRoomSessions}. */
  listRoomSessions(roomId: string, viewerAuthorId: string): RoomSessionBinding[] {
    return this.parts.directory.listRoomSessions(roomId, viewerAuthorId);
  }
  /** Where a session is answering. See {@link RoomDirectory.roomLabelForSession}. */
  roomLabelForSession(sessionId: string): string | null {
    return this.parts.directory.roomLabelForSession(sessionId);
  }
  /** Patch a room, operator-only. See {@link RoomUpdates.updateRoom}. */
  updateRoom(roomId: string, viewerAuthorId: string, patch: UpdateRoomRequest): RoomWithRoster {
    return this.parts.updates.updateRoom(roomId, viewerAuthorId, patch);
  }
  /** Rename or re-topic a room as an agent. See {@link RoomUpdates.updateRoomFromTool}. */
  updateRoomFromTool(
    roomId: string,
    callerAuthorId: string,
    patch: { title?: string; topic?: string | null }
  ): RoomWithRoster {
    return this.parts.updates.updateRoomFromTool(roomId, callerAuthorId, patch);
  }
  /** Add a member, operator-only. See {@link RoomMembership.addMember}. */
  addMember(roomId: string, viewerAuthorId: string, input: AddMemberInput): RoomRosterEntry {
    return this.parts.membership.addMember(roomId, viewerAuthorId, input);
  }
  /** Add a member because an agent asked. See {@link RoomMembership.addMemberFromTool}. */
  addMemberFromTool(
    roomId: string,
    viewerAuthorId: string,
    input: AddMemberInput
  ): RoomRosterEntry {
    return this.parts.membership.addMemberFromTool(roomId, viewerAuthorId, input);
  }
  /** Change one membership's response mode. See {@link RoomMembership.updateMembership}. */
  updateMembership(
    roomId: string,
    viewerAuthorId: string,
    authorId: string,
    responseMode: ResponseMode
  ): RoomRosterEntry {
    return this.parts.membership.updateMembership(roomId, viewerAuthorId, authorId, responseMode);
  }
  /** Remove a member, operator-only. See {@link RoomMembership.removeMember}. */
  removeMember(roomId: string, viewerAuthorId: string, authorId: string): void {
    this.parts.membership.removeMember(roomId, viewerAuthorId, authorId);
  }
  /** Remove a member because an agent asked. See {@link RoomMembership.removeMemberFromTool}. */
  removeMemberFromTool(roomId: string, viewerAuthorId: string, authorId: string): void {
    this.parts.membership.removeMemberFromTool(roomId, viewerAuthorId, authorId);
  }
  /** Step out of a channel you are in. See {@link RoomMembership.leaveRoom}. */
  leaveRoom(roomId: string, authorId: string): void {
    this.parts.membership.leaveRoom(roomId, authorId);
  }
  /** Advance a member's read cursor. See {@link RoomDirectory.setReadCursor}. */
  setReadCursor(roomId: string, authorId: string, lastReadSeq: number): RoomMember {
    return this.parts.directory.setReadCursor(roomId, authorId, lastReadSeq);
  }
  /** Where one member has read up to. See {@link RoomDirectory.readCursorFor}. */
  readCursorFor(roomId: string, authorId: string): number | null {
    return this.parts.directory.readCursorFor(roomId, authorId);
  }
  /** A page of history, oldest-first. See {@link RoomReads.listEntries}. */
  listEntries(
    roomId: string,
    viewerAuthorId: string,
    opts: { before?: number; limit: number }
  ): RoomEntry[] {
    return this.parts.reads.listEntries(roomId, viewerAuthorId, opts);
  }
  /** A page plus the thread roots it points outside itself. See {@link RoomReads.listEntryPage}. */
  listEntryPage(
    roomId: string,
    viewerAuthorId: string,
    opts: { before?: number; limit: number }
  ): RoomEntryListResponse {
    return this.parts.reads.listEntryPage(roomId, viewerAuthorId, opts);
  }
  /** Write a post. See {@link RoomPosting.post}. */
  post(roomId: string, input: RoomPostInput): PostedEntry {
    return this.parts.posting.post(roomId, input);
  }
  /** Post because the agent decided to. See {@link RoomPosting.postFromTool}. */
  postFromTool(
    roomId: string,
    input: {
      authorId: string;
      text: string;
      replyTo?: string;
      attachmentIds?: readonly string[];
    }
  ): PostedEntry {
    return this.parts.posting.postFromTool(roomId, input);
  }
  /** A page of one room's history for a member. See {@link RoomReads.readHistory}. */
  readHistory(
    roomId: string,
    viewerAuthorId: string,
    opts: { limit: number; before?: number; threadRootEntryId?: string }
  ): RoomEntry[] {
    return this.parts.reads.readHistory(roomId, viewerAuthorId, opts);
  }
  /** The messages in one room that match some words. See {@link RoomSearch.searchHistory}. */
  searchHistory(
    roomId: string,
    viewerAuthorId: string,
    opts: { query: string; limit: number; threadRootEntryId?: string }
  ): RoomEntry[] {
    return this.parts.search.searchHistory(roomId, viewerAuthorId, opts);
  }
  /** How much of the room log one caller may search. See {@link RoomSearch.searchScope}. */
  searchScope(viewerAuthorId: string): RoomSearchScope {
    return this.parts.search.searchScope(viewerAuthorId);
  }
  /** The rooms one member belongs to. See {@link RoomMemberDirectory.listMemberRooms}. */
  listMemberRooms(viewerAuthorId: string): MemberRoomSummary[] {
    return this.parts.memberDirectory.listMemberRooms(viewerAuthorId);
  }
  /** One room in full, roster included. See {@link RoomMemberDirectory.describeRoom}. */
  describeRoom(roomId: string, viewerAuthorId: string): RoomDetail {
    return this.parts.memberDirectory.describeRoom(roomId, viewerAuthorId);
  }
  /** The caller's member rooms that match a filter. See {@link RoomMemberDirectory.findMemberRooms}. */
  findMemberRooms(viewerAuthorId: string, filter: FindMemberRoomsFilter): RoomDetail[] {
    return this.parts.memberDirectory.findMemberRooms(viewerAuthorId, filter);
  }
  /** Turn a `@handle` into an author. See {@link RoomMemberDirectory.findAuthorByHandle}. */
  findAuthorByHandle(token: string): AuthorRecord | null {
    return this.parts.memberDirectory.findAuthorByHandle(token);
  }
  /** Search across every room a member belongs to. See {@link RoomSearch.searchMemberRooms}. */
  searchMemberRooms(
    viewerAuthorId: string,
    opts: { query: string; limit: number }
  ): MemberRoomMatch[] {
    return this.parts.search.searchMemberRooms(viewerAuthorId, opts);
  }
  /** Refuse anyone not on a room's roster. See {@link RoomVisibility.requireMembership}. */
  requireMembership(roomId: string, viewerAuthorId: string): Room {
    return this.parts.visibility.requireMembership(roomId, viewerAuthorId);
  }
  /** A room's whole history as JSONL. See {@link RoomReads.exportRoom}. */
  *exportRoom(roomId: string, viewerAuthorId: string): Generator<RoomExportLine> {
    yield* this.parts.reads.exportRoom(roomId, viewerAuthorId);
  }
  /** Refuse a caller who is not a person. See {@link RoomVisibility.requirePersonAuthor}. */
  requirePersonAuthor(authorId: string, what: string): void {
    this.parts.visibility.requirePersonAuthor(authorId, what);
  }
  /** Refuse anyone who may not attach a file. See {@link RoomVisibility.assertCanAttach}. */
  assertCanAttach(roomId: string, authorId: string): void {
    this.parts.visibility.assertCanAttach(roomId, authorId);
  }
  /** Refuse anyone who may not read a room's files. See {@link RoomVisibility.assertCanReadFiles}. */
  assertCanReadFiles(roomId: string, authorId: string): void {
    this.parts.visibility.assertCanReadFiles(roomId, authorId);
  }
  /** Refuse anyone who may not save a room's files. See {@link RoomVisibility.assertCanWriteFiles}. */
  assertCanWriteFiles(roomId: string, authorId: string): void {
    this.parts.visibility.assertCanWriteFiles(roomId, authorId);
  }
  /** Whether a caller may read one attachment. See {@link RoomVisibility.canReadAttachment}. */
  canReadAttachment(
    roomId: string,
    authorId: string,
    attachment: { entryId: string | null; authorId: string }
  ): boolean {
    return this.parts.visibility.canReadAttachment(roomId, authorId, attachment);
  }
  /** Write a message from outside this machine. See {@link RoomEntryWriter.postExternal}. */
  postExternal(
    roomId: string,
    input: RoomExternalPostInput
  ): { entry: RoomEntry; author: AuthorRecord; joined: boolean } {
    return this.parts.writer.postExternal(roomId, input);
  }
  /** Mark a milestone in a room. See {@link RoomSystemPosts.postMoment}. */
  postMoment(
    roomId: string,
    input: { text: string; moment: RoomMoment; authorId?: string; subjectAuthorId?: string }
  ): RoomEntry {
    return this.parts.systemPosts.postMoment(roomId, input);
  }
  /** Announce merged work. See {@link RoomSystemPosts.postMergeEvent}. */
  postMergeEvent(
    roomId: string,
    input: { text: string; merge: RoomMergeEvent; subjectAuthorId: string }
  ): RoomEntry {
    return this.parts.systemPosts.postMergeEvent(roomId, input);
  }
  /** Write a service notice with its private source receipt in the same transaction; no agent dispatch. */
  postServiceNotification(
    roomId: string,
    entryId: string,
    text: string,
    within: (tx: DbTransaction) => void,
    bind: (tx: DbTransaction, seq: number) => void
  ): RoomEntry {
    return this.parts.systemPosts.postServiceNotification(roomId, entryId, text, within, bind);
  }

  /** Write the room's own voice. See {@link RoomSystemPosts.postNotice}. */
  postNotice(
    roomId: string,
    body: RoomEntryBody,
    cascade?: { root: string; depth: number },
    replyTo?: string
  ): RoomEntry {
    return this.parts.systemPosts.postNotice(roomId, body, cascade, replyTo);
  }
  /** Turns taken per author in one cascade. See {@link RoomReads.turnsByAuthorInCascade}. */
  turnsByAuthorInCascade(roomId: string, cascadeRoot: string): Map<string, number> {
    return this.parts.reads.turnsByAuthorInCascade(roomId, cascadeRoot);
  }
  /** Put one emoji on one entry, or take it back. See {@link RoomReactions.toggleReaction}. */
  toggleReaction(
    roomId: string,
    entryId: string,
    viewerAuthorId: string,
    emoji: string,
    on?: boolean
  ): { reacted: boolean; frequents: string[] } {
    return this.parts.reactions.toggleReaction(roomId, entryId, viewerAuthorId, emoji, on);
  }
  /** One entry's reactions right now. See {@link RoomReactions.reactionsFor}. */
  reactionsFor(roomId: string, entryId: string): RoomEntryReaction[] {
    return this.parts.reactions.reactionsFor(roomId, entryId);
  }
  /** A room's whole trailing reaction state. See {@link RoomReactions.reactionResync}. */
  reactionResync(roomId: string, historyLimit: number): RoomReactionEvent[] {
    return this.parts.reactions.reactionResync(roomId, historyLimit);
  }
  /** The snapshot a cold SSE connect opens with. See {@link RoomReads.snapshot}. */
  snapshot(
    roomId: string,
    viewerAuthorId: string,
    historyLimit: number
  ): { room: RoomWithRoster; entries: RoomEntry[]; cursor: number; canvas: CanvasDocument[] } {
    return this.parts.reads.snapshot(roomId, viewerAuthorId, historyLimit);
  }
  /**
   * Every live canvas document as its own frame — the resync a stream resume
   * sends. See {@link RoomCanvasService.resync}.
   *
   * @param roomId - The room.
   * @returns One `canvas` frame per live document.
   */
  canvasResync(roomId: string): RoomEvent[] {
    return this.parts.canvas.resync(roomId);
  }
  /** The highest `seq` this room has issued. See {@link RoomReads.maxSeq}. */
  maxSeq(roomId: string): number {
    return this.parts.reads.maxSeq(roomId);
  }
  /** Every entry after a cursor — the SSE replay read. See {@link RoomReads.entriesAfter}. */
  entriesAfter(roomId: string, afterSeq: number): RoomEntry[] {
    return this.parts.reads.entriesAfter(roomId, afterSeq);
  }
  /** Deliver an ephemeral signal. See {@link RoomPublisher.publishSignal}. */
  publishSignal(
    roomId: string,
    signal: SignalType,
    authorId: string,
    presence?: Partial<RoomPresencePayload>
  ): void {
    this.parts.publisher.publishSignal(roomId, signal, authorId, presence);
  }
  /** Register the bridge's presence forwarder. See {@link RoomPublisher.setSignalListener}. */
  setSignalListener(listener: RoomSignalListener | undefined): void {
    this.parts.publisher.setSignalListener(listener);
  }
  /** Register the bridge's inline-delivery hook. See {@link RoomPublisher.setEntryCommitListener}. */
  setEntryCommitListener(listener: ((entry: RoomEntry) => void) | undefined): void {
    this.parts.publisher.setEntryCommitListener(listener);
  }
}
