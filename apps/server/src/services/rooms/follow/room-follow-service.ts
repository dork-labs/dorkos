/**
 * Following somebody's browser inside a room (spec `canvas-agent-seat` §6).
 *
 * A person turns on "Follow Ana" and their panel goes where Ana's goes. Three
 * rules shape every line below, and each is a mechanism rather than a
 * convention:
 *
 * 1. **Nothing is published until somebody is following.** A claim is a frame on
 *    the room's own stream, so the person being followed LEARNS they are — and
 *    until they do, their client sends nothing at all. A room where nobody
 *    follows anybody carries not one extra byte, which is what keeps "silence is
 *    free" true of bandwidth as well as of turns.
 * 2. **People only.** An agent has no viewport to share and nothing to follow
 *    with; `read_canvas` already tells it what is on the table. Both halves are
 *    refused here rather than hidden in the app, so a hand-written request is
 *    refused too.
 * 3. **Nothing here is durable.** Claims live in this process and nowhere else,
 *    they are never written down, and they lapse on their own. A server that
 *    restarts mid-follow simply has no claims, and the followers' next refresh
 *    re-states theirs.
 *
 * **No timer, anywhere.** A claim carries when it was last refreshed and is
 * judged against that at READ time — the same shape the canvas edit lock uses,
 * and for the same reason: a timer that expires claims is one that has to be
 * cancelled on every release, every room deletion and every shutdown, and the
 * cost of getting that wrong is a follow nobody can turn off. The follower's own
 * client refreshes every {@link FOLLOW_REFRESH_MS}, and each refresh re-publishes
 * the claim, so the person being followed hears it restated on the same beat.
 *
 * @module server/services/rooms/follow/room-follow-service
 */
import { ROOM_LIVE_BEAT_MS, ROOM_LIVE_TTL_MS } from '@dorkos/shared/room-schemas';
import type { RoomSignalView } from '@dorkos/shared/room-schemas';
import { RoomError } from '../room-errors.js';
import type { RoomVisibility } from '../service/room-visibility.js';
import type { RoomPublisher } from '../service/room-publisher.js';
import type { AuthorRegistry } from '../author-registry.js';

/**
 * How often a follower re-states its claim.
 *
 * The room's one ephemeral beat, so the two live indicators in a room age at one
 * rate rather than two — this is an alias for {@link ROOM_LIVE_BEAT_MS}, not a
 * second copy of it. Re-exported under this name because a reader of this file
 * is asking about follow claims, and `room-live-beat.test.ts` pins the two to
 * each other and to the presence republisher.
 */
export const FOLLOW_REFRESH_MS = ROOM_LIVE_BEAT_MS;

/**
 * How long a claim survives without a refresh.
 *
 * Three beats, exactly as the presence indicator's own TTL is, so a follower
 * whose browser was closed, crashed or put to sleep stops being a follower
 * within thirty seconds and the person they were following goes quiet again.
 */
export const FOLLOW_CLAIM_TTL_MS = ROOM_LIVE_TTL_MS;

/** How many claims one process will hold before it refuses to take more. */
const MAX_CLAIMS = 200;

/** One live follow claim. */
interface FollowClaim {
  /** The person being followed. */
  leaderId: string;
  /** When the follower last said it was still there, in epoch ms. */
  refreshedAt: number;
}

/** What a follow service reaches for. */
export interface RoomFollowDeps {
  /** Who may see a room, and who is in it. */
  visibility: RoomVisibility;
  /** The room's live stream. */
  publisher: RoomPublisher;
  /** Person or agent, for the people-only rule. */
  authors: AuthorRegistry;
  /** The clock, so a TTL is testable without waiting thirty seconds. */
  now?: () => number;
}

/**
 * Who is following whom in each room, and the two frames that carry it.
 *
 * One instance per room service. Every method refuses a non-member with the same
 * `ROOM_NOT_FOUND` a room that does not exist gets, so a room id is never a
 * probe.
 */
export class RoomFollowService {
  /** `roomId` → `followerId` → the claim they hold. */
  private readonly claims = new Map<string, Map<string, FollowClaim>>();
  private readonly deps: RoomFollowDeps;
  private readonly now: () => number;

  /**
   * Build the service over its collaborators.
   *
   * @param deps - Visibility, the stream, the author registry and the clock.
   */
  constructor(deps: RoomFollowDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  /**
   * Start following somebody, or say you are still following them.
   *
   * Idempotent on purpose: the client calls this every
   * {@link FOLLOW_REFRESH_MS}, and each call re-publishes the claim so the person
   * being followed keeps hearing it. Switching to a different person replaces
   * the old claim rather than adding a second — a panel can only be in one place.
   *
   * @param roomId - The room.
   * @param followerId - The person doing the following.
   * @param leaderId - The person being followed.
   * @throws {RoomError} `ROOM_NOT_FOUND` when either of them is not in this
   *   room, `PEOPLE_ONLY` when either of them is not a person,
   *   `CANNOT_FOLLOW_YOURSELF` for a claim on oneself, `TOO_MANY_FOLLOWERS` when
   *   this process already holds as many claims as it will.
   */
  follow(roomId: string, followerId: string, leaderId: string): void {
    this.deps.visibility.requireMembership(roomId, followerId);
    if (followerId === leaderId) {
      throw new RoomError('CANNOT_FOLLOW_YOURSELF', 'You are already where you are.');
    }
    // The leader's membership is asked with the FOLLOWER as the viewer, so a
    // stranger learns nothing about who is in a room they cannot see: the call
    // above already refused them.
    this.deps.visibility.requireMembership(roomId, leaderId);
    this.requirePerson(followerId, 'Only a person can follow somebody.');
    this.requirePerson(leaderId, 'You can only follow a person.');

    const at = this.now();
    this.prune(at);
    const inRoom = this.claims.get(roomId) ?? new Map<string, FollowClaim>();
    if (!this.claims.has(roomId)) this.claims.set(roomId, inRoom);
    if (!inRoom.has(followerId) && this.size() >= MAX_CLAIMS) {
      throw new RoomError(
        'TOO_MANY_FOLLOWERS',
        'Too many people are following somebody right now. Try again in a moment.'
      );
    }
    const previous = inRoom.get(followerId);
    inRoom.set(followerId, { leaderId, refreshedAt: at });
    // A switch tells the person who WAS being followed that nobody is any more,
    // so their client stops publishing rather than waiting out the TTL.
    if (previous && previous.leaderId !== leaderId && !this.isFollowed(roomId, previous.leaderId)) {
      this.deps.publisher.publishFollowClaim(roomId, followerId, null);
    }
    this.deps.publisher.publishFollowClaim(roomId, followerId, leaderId);
  }

  /**
   * Stop following whoever you were following here.
   *
   * Silent when there was nothing to stop: pressing the toggle off twice, or a
   * page closing after its claim already lapsed, is not an error worth a
   * sentence.
   *
   * @param roomId - The room.
   * @param followerId - The person who was following.
   */
  unfollow(roomId: string, followerId: string): void {
    const inRoom = this.claims.get(roomId);
    if (!inRoom?.delete(followerId)) return;
    if (inRoom.size === 0) this.claims.delete(roomId);
    this.deps.publisher.publishFollowClaim(roomId, followerId, null);
  }

  /**
   * Say where you are looking, if anybody is following you.
   *
   * **The gate is here as well as in the app**, because the app's is the one
   * that saves the bandwidth and this one is the one that holds when a client is
   * stale, wrong, or hand-written. A position from somebody nobody follows is
   * dropped and the caller is told so, which is how their client learns to stop.
   *
   * @param roomId - The room.
   * @param leaderId - The person whose view this is.
   * @param view - The document, page and scroll offset they are on.
   * @returns Whether anybody was following, and the frame therefore published.
   * @throws {RoomError} `ROOM_NOT_FOUND` for a non-member, `PEOPLE_ONLY` for an
   *   agent — which has no viewport to report.
   */
  publishView(roomId: string, leaderId: string, view: RoomSignalView): boolean {
    this.deps.visibility.requireMembership(roomId, leaderId);
    this.requirePerson(leaderId, 'Only a person has a view to share.');
    if (!this.isFollowed(roomId, leaderId)) return false;
    this.deps.publisher.publishFollowView(roomId, leaderId, view);
    return true;
  }

  /**
   * Whether anybody is following this person in this room right now.
   *
   * Expiry is evaluated HERE rather than swept: a claim nobody has refreshed
   * within {@link FOLLOW_CLAIM_TTL_MS} simply stops counting, and is dropped on
   * the way past.
   *
   * @param roomId - The room.
   * @param leaderId - The person.
   * @returns Whether a live claim names them.
   */
  isFollowed(roomId: string, leaderId: string): boolean {
    return this.followersOf(roomId, leaderId).length > 0;
  }

  /**
   * Everybody following this person in this room right now.
   *
   * @param roomId - The room.
   * @param leaderId - The person.
   * @returns Their followers' author ids.
   */
  followersOf(roomId: string, leaderId: string): string[] {
    const inRoom = this.claims.get(roomId);
    if (!inRoom) return [];
    const at = this.now();
    const followers: string[] = [];
    for (const [followerId, claim] of inRoom) {
      if (at - claim.refreshedAt >= FOLLOW_CLAIM_TTL_MS) {
        inRoom.delete(followerId);
        continue;
      }
      if (claim.leaderId === leaderId) followers.push(followerId);
    }
    if (inRoom.size === 0) this.claims.delete(roomId);
    return followers;
  }

  /**
   * How many live claims this process is holding.
   *
   * @internal Exported for testing only. The bound is the claim, and a test that
   * could not read the count could only assert whatever follows from it.
   */
  size(): number {
    let total = 0;
    for (const inRoom of this.claims.values()) total += inRoom.size;
    return total;
  }

  /** Refuse anybody who is not a person, by author id. */
  private requirePerson(authorId: string, message: string): void {
    if (this.deps.authors.getById(authorId)?.kind !== 'human') {
      throw new RoomError('PEOPLE_ONLY', message);
    }
  }

  /** Drop every claim nothing has refreshed inside the TTL. */
  private prune(at: number): void {
    for (const [roomId, inRoom] of this.claims) {
      for (const [followerId, claim] of inRoom) {
        if (at - claim.refreshedAt >= FOLLOW_CLAIM_TTL_MS) inRoom.delete(followerId);
      }
      if (inRoom.size === 0) this.claims.delete(roomId);
    }
  }
}
