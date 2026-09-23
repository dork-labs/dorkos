/**
 * What you have typed in a Community room but not yet sent.
 *
 * A Community room's composer unmounts whenever you switch to another
 * Community or back to this DorkOS, so a draft held in the composer's own state
 * was gone by the time you came back. This store holds it instead, so A→B→A
 * finds your half-written message where you left it (spec
 * `community-switcher-navigation`: "Restore the target draft from its qualified
 * key") — the same promise `entities/room`'s `room-drafts` makes for this
 * DorkOS's own rooms.
 *
 * Two Communities can use the same room id, and two local owners can sign in
 * to the same browser, so a room id alone is not an address. Every draft is
 * keyed by the full {@link CommunityDraftAddress}: local owner and its
 * authority epoch, connection ref and its generation, room, and thread. A draft
 * can only ever be read back at the exact address it was written under.
 *
 * Nothing here is persisted. Drafts live in memory for this tab and are erased
 * — not merely hidden — when the thing they belong to ends:
 * - {@link CommunityDraftActions.discardCommunity} when one connection is
 *   removed or revoked (`endCommunityConnection`);
 * - {@link CommunityDraftActions.discardAll} when the local owner changes or
 *   signs out (the authority cleanup `eraseCommunityOwnerState` performs).
 *
 * The epoch and generation in the key are the fence that holds before either
 * erasure runs: a bumped epoch or a tombstoned connection makes every older
 * address unreachable at once.
 *
 * @module entities/community/model/community-drafts
 */
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

/** Everything that identifies one Community composer's draft. */
export interface CommunityDraftAddress {
  /** Server-resolved local owner the draft was typed under. */
  ownerKey: string;
  /** Local-owner authority epoch; a sign-out or owner change moves it. */
  epoch: number;
  /** The Community connection ref. */
  ref: string;
  /** The connection's generation; a removal or revocation moves it. */
  generation: number;
  /** The room inside that Community. */
  roomId: string;
  /** The thread root the composer replies to, when it is a thread's composer. */
  threadId?: string;
}

/** One file staged in a draft, before any upload has started. */
export interface CommunityDraftFile {
  /** Stable id for this staged file. */
  id: string;
  /** The browser File the person picked. */
  file: File;
}

/** The unsent content of one composer. */
export interface CommunityDraft {
  /** Typed text. */
  text: string;
  /** Files staged but not yet sent. They stay in memory, never uploaded until Send. */
  files: readonly CommunityDraftFile[];
}

/** A held draft plus the parts of its address the erasures match on. */
interface HeldDraft extends CommunityDraft {
  ownerKey: string;
  ref: string;
}

/** Unsent drafts, by {@link communityDraftKey}. */
interface CommunityDraftState {
  drafts: Record<string, HeldDraft>;
}

/** Ways a Community draft changes. */
export interface CommunityDraftActions {
  /** Record what a composer currently holds; an empty draft is removed. */
  write: (address: CommunityDraftAddress, draft: CommunityDraft) => void;
  /**
   * Read a composer's draft and clear it in one step, for Send.
   *
   * Atomic for the same reason as `room-drafts`' `take`: two Enters before a
   * re-render both see the stale render, so Send reads from here and the second
   * read finds nothing to send twice.
   */
  take: (address: CommunityDraftAddress) => CommunityDraft;
  /** Erase every draft one owner holds for one Community connection. */
  discardCommunity: (ownerKey: string, ref: string) => void;
  /** Erase every Community draft, for a sign-out or local-owner change. */
  discardAll: () => void;
}

/** The draft an address holds when nothing was typed there. */
export const EMPTY_COMMUNITY_DRAFT: CommunityDraft = Object.freeze({
  text: '',
  files: Object.freeze([]) as readonly CommunityDraftFile[],
});

/**
 * The store key for one composer's draft.
 *
 * @param address - The fully qualified composer address.
 */
export function communityDraftKey(address: CommunityDraftAddress): string {
  return JSON.stringify([
    address.ownerKey,
    address.epoch,
    address.ref,
    address.generation,
    address.roomId,
    address.threadId ?? null,
  ]);
}

/** The in-memory Community draft store. */
export const useCommunityDraftStore = create<CommunityDraftState & CommunityDraftActions>()(
  devtools(
    (set, get) => ({
      drafts: {},

      write: (address, draft) =>
        set(
          (state) => {
            const key = communityDraftKey(address);
            const { [key]: _previous, ...rest } = state.drafts;
            if (draft.text === '' && draft.files.length === 0) return { drafts: rest };
            return {
              drafts: {
                ...rest,
                [key]: {
                  text: draft.text,
                  files: draft.files,
                  ownerKey: address.ownerKey,
                  ref: address.ref,
                },
              },
            };
          },
          false,
          'communityDrafts/write'
        ),

      take: (address) => {
        const key = communityDraftKey(address);
        const held = get().drafts[key];
        if (!held) return EMPTY_COMMUNITY_DRAFT;
        set(
          (state) => {
            const { [key]: _taken, ...rest } = state.drafts;
            return { drafts: rest };
          },
          false,
          'communityDrafts/take'
        );
        return { text: held.text, files: held.files };
      },

      discardCommunity: (ownerKey, ref) =>
        set(
          (state) => ({
            drafts: Object.fromEntries(
              Object.entries(state.drafts).filter(
                ([, held]) => held.ownerKey !== ownerKey || held.ref !== ref
              )
            ),
          }),
          false,
          'communityDrafts/discardCommunity'
        ),

      discardAll: () => set({ drafts: {} }, false, 'communityDrafts/discardAll'),
    }),
    { name: 'CommunityDraftStore' }
  )
);

/**
 * Subscribe to one composer's draft.
 *
 * @param address - The composer's address, or `null` while its owner is unconfirmed.
 * @returns The held draft, or {@link EMPTY_COMMUNITY_DRAFT}.
 */
export function useCommunityDraft(address: CommunityDraftAddress | null): CommunityDraft {
  const key = address ? communityDraftKey(address) : null;
  return useCommunityDraftStore((state) =>
    key === null ? EMPTY_COMMUNITY_DRAFT : (state.drafts[key] ?? EMPTY_COMMUNITY_DRAFT)
  );
}
