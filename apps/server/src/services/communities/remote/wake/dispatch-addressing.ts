/**
 * Which local agents one space post addresses, on the short-lived dispatch view only: the stored
 * entry keeps the mentions its author wrote. Split out of the stream bridge, which asks it once
 * per post the owner's setting lets through.
 *
 * A teammate's post (anyone in the space but the owner, DOR-2955) addresses only agents whose
 * runtime can hold a teammate's turn to its limits; for the rest it stays history.
 *
 * @module services/communities/remote/wake/dispatch-addressing
 */
import type { MirrorRoomInput, RemoteMirrorStore } from '../mirror-store.js';
import type { CommunityAgentEnrollmentStore } from '../agent-enrollment-store.js';
import type { TeammateWakes } from './teammate-wakes.js';

type SavedEntry = ReturnType<RemoteMirrorStore['importEntries']>[number];

/** Resolves who a space post addresses here, for the stream bridge. */
export class SpaceDispatchAddressing {
  /**
   * Build the resolver over the bridge's own stores.
   *
   * @param mirrors - The mirror store, whose per-room grant is the final fence.
   * @param enrollments - This install's enrolled agents per space.
   * @param resolveLocalAgentAuthor - An enrolled agent's local room author.
   * @param teammates - Which agents may take a teammate's turn.
   */
  constructor(
    private readonly mirrors: RemoteMirrorStore,
    private readonly enrollments: CommunityAgentEnrollmentStore,
    private readonly resolveLocalAgentAuthor: (localAgentId: string) => string | null,
    private readonly teammates: TeammateWakes
  ) {}

  /**
   * Address an answer-in post to every agent this owner enrolled that can read the room, on the
   * short-lived dispatch view only: the stored entry keeps the mentions its author wrote. The
   * turn it starts is the same one a mention from this author would start, external and held to
   * the stranger ceiling.
   */
  answerInEntry(localRoomId: string, room: MirrorRoomInput, entry: SavedEntry, owner: boolean) {
    const enrolled = this.enrollments
      .activeLocalAgentIds(room.communityRef, room.ownerAuthorId)
      .flatMap((localAgentId) => {
        if (!owner && !this.teammates.canAnswer(localAgentId, entry.id)) return [];
        const authorId = this.resolveLocalAgentAuthor(localAgentId);
        return authorId && this.mirrors.canRead(localRoomId, authorId) === true ? [authorId] : [];
      });
    return { ...entry, mentions: [...new Set([...entry.mentions, ...enrolled])] };
  }

  /** Translate remote mention identities only on the short-lived local dispatch view. */
  dispatchEntry(localRoomId: string, room: MirrorRoomInput, saved: SavedEntry, owner: boolean) {
    // The mentions the entry was stored with, not the frame's: a message removed before it was
    // cached is stored as it stands now, and a removed message mentions nobody.
    const mentions = saved.mentions.flatMap((remoteMemberId) => {
      const enrollment = this.enrollments.findLocalAgent(
        room.communityRef,
        remoteMemberId,
        room.ownerAuthorId
      );
      if (!enrollment) return [];
      // A teammate wakes only an agent whose runtime can hold the turn (DOR-2955).
      if (!owner && !this.teammates.canAnswer(enrollment.localAgentId, saved.id)) return [];
      const authorId = this.resolveLocalAgentAuthor(enrollment.localAgentId);
      // Membership is refreshed from the enrolled agent's own remote
      // directory. Keep the persisted per-room grant as the final fence so a
      // late event cannot dispatch an agent removed during reconciliation.
      return authorId && this.mirrors.canRead(localRoomId, authorId) === true ? [authorId] : [];
    });
    return { ...saved, mentions };
  }
}
