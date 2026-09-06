/**
 * The wiring: every collaborator a room service is made of, built once in
 * dependency order.
 *
 * It lives beside `room-service.ts` rather than inside it so the front door
 * stays a list of verbs. Nothing here decides anything — read it to find out
 * WHICH module answers a question, and read that module to find out how.
 *
 * **The three write-back hooks stay the service's, not this module's.** They
 * are handed in rather than pointed at the collaborators directly, because the
 * dispatcher's reply has always been written by `RoomService.post` and its
 * refusals by `RoomService.postNotice` — the front door, not the module behind
 * it. Routing them anywhere else would change what a caller that wraps those
 * methods observes, which is the one thing a split of this class may not do.
 *
 * @module server/services/rooms/service/room-collaborators
 */
import { RoomAuthority } from './room-authority.js';
import { RoomBridgeCreation } from '../manage/room-bridge-create.js';
import { RoomBridgeLifecycle } from '../manage/room-bridge-lifecycle.js';
import { createRoomCore, type RoomCore, type RoomWriteBack } from './room-core.js';
import { RoomDirectory } from '../manage/room-directory.js';
import { RoomEntryWriter } from '../messages/room-entry-writer.js';
import { RoomLifecycle } from '../manage/room-lifecycle.js';
import { RoomMemberDirectory } from '../manage/room-member-directory.js';
import { RoomMembership } from '../manage/room-membership.js';
import { RoomMessageNotifier } from '../messages/room-message-notifier.js';
import { RoomPosting } from '../messages/room-posting.js';
import { RoomProjection } from './room-projection.js';
import { RoomPublisher } from './room-publisher.js';
import { RoomReactions } from '../messages/room-reactions.js';
import { RoomReads } from '../messages/room-reads.js';
import { RoomSearch } from '../messages/room-search.js';
import type { RoomServiceDeps } from './room-service-deps.js';
import { RoomSystemPosts } from '../messages/room-system-posts.js';
import { RoomTurnControl } from '../manage/room-turn-control.js';
import { RoomUpdates } from '../manage/room-updates.js';
import { RoomVisibility } from './room-visibility.js';

/** Every part of one room service, and the state they all share. */
export interface RoomCollaborators {
  /** The shared state — the stores, the ports and the live config reads. */
  readonly core: RoomCore;
  /** May you see this room, may you read its log, may you touch its files. */
  readonly visibility: RoomVisibility;
  /** May you change it. */
  readonly authority: RoomAuthority;
  /** Rows in, what a reader is handed out. */
  readonly projection: RoomProjection;
  /** The two streams a room fans out on, and the bridge's two listeners. */
  readonly publisher: RoomPublisher;
  /** Patching a room that already exists. */
  readonly updates: RoomUpdates;
  /** Opening one. */
  readonly lifecycle: RoomLifecycle;
  /** Whether a committed entry earns the operator a notification. */
  readonly notifier: RoomMessageNotifier;
  /** The shared write half of every post that reaches a room's log. */
  readonly writer: RoomEntryWriter;
  /** The two doors a message comes through, and the files it may bring. */
  readonly posting: RoomPosting;
  /** The room speaking in its own voice — a milestone, a merge, a notice. */
  readonly systemPosts: RoomSystemPosts;
  /** The room half of bridging a platform chat for the first time. */
  readonly bridgeCreation: RoomBridgeCreation;
  /** Disconnecting, re-bridging, and the bridge's own small writes. */
  readonly bridgeLifecycle: RoomBridgeLifecycle;
  /** Who is in a room. */
  readonly membership: RoomMembership;
  /** The lists the app draws, and where each reader has got to in them. */
  readonly directory: RoomDirectory;
  /** The rooms an agent can find its own way around. */
  readonly memberDirectory: RoomMemberDirectory;
  /** Every way a room's own log is read back. */
  readonly reads: RoomReads;
  /** Every search this domain answers, and the scope each runs under. */
  readonly search: RoomSearch;
  /** Putting an emoji on a message, and taking it back. */
  readonly reactions: RoomReactions;
  /** What a room is working on, and the three ways a person steers it. */
  readonly turnControl: RoomTurnControl;
}

/**
 * Build one room service's parts, in the order their dependencies allow.
 *
 * @param deps - Everything the service was constructed from.
 * @param writeBack - How the trigger dispatcher reaches back into the service.
 * @returns Every collaborator, sharing one {@link RoomCore}.
 */
export function createRoomCollaborators(
  deps: RoomServiceDeps,
  writeBack: RoomWriteBack
): RoomCollaborators {
  const core = createRoomCore(deps, writeBack);
  const visibility = new RoomVisibility(core);
  const authority = new RoomAuthority(core);
  const projection = new RoomProjection(core);
  const publisher = new RoomPublisher(core);
  const updates = new RoomUpdates(core, visibility, authority, projection);
  const lifecycle = new RoomLifecycle(core, visibility, authority, projection, updates);
  const notifier = new RoomMessageNotifier(core);
  const writer = new RoomEntryWriter(core, publisher, notifier);
  const posting = new RoomPosting(core, visibility, writer);
  const systemPosts = new RoomSystemPosts(core, visibility, publisher, posting);
  const bridgeCreation = new RoomBridgeCreation(core, projection);
  const bridgeLifecycle = new RoomBridgeLifecycle(
    core,
    visibility,
    authority,
    projection,
    updates,
    systemPosts
  );
  const membership = new RoomMembership(core, visibility, authority, systemPosts);
  return {
    core,
    visibility,
    authority,
    projection,
    publisher,
    updates,
    lifecycle,
    notifier,
    writer,
    posting,
    systemPosts,
    bridgeCreation,
    bridgeLifecycle,
    membership,
    directory: new RoomDirectory(core, visibility, projection),
    memberDirectory: new RoomMemberDirectory(core, visibility),
    reads: new RoomReads(core, visibility, projection),
    search: new RoomSearch(core, visibility, projection),
    reactions: new RoomReactions(core, visibility, publisher),
    turnControl: new RoomTurnControl(core, visibility),
  };
}
