/**
 * Bind the entry action set to the room it is acting on.
 *
 * @module features/entry-actions/model/use-entry-actions
 */
import { useMemo } from 'react';
import { AtSign, Copy, Reply, User } from 'lucide-react';
import {
  replyRootFor,
  threadDraftKey,
  useComposerFocusStore,
  useRoomDraftStore,
  useRoomOpenThreadStore,
  type AuthorRef,
  type RoomEntry,
} from '@/layers/entities/room';
import { useCopyFeedback } from '@/layers/shared/lib';
import { ENTRY_ACTION_ORDER, type EntryAction, type EntryActionSlot } from '../lib/entry-actions';

/** The message an action set is being built for. */
export interface EntryActionsInput {
  /** The room the entry lives in. */
  roomId: string;
  /** The entry itself. */
  entry: RoomEntry;
  /** Its author as the roster knows them, or undefined for a former member. */
  author: AuthorRef | undefined;
  /** The reader's own author id in this room, so they are not offered to themselves. */
  viewerAuthorId: string;
  /**
   * Open this message's author's profile, or `undefined` when the roster cannot
   * address them.
   *
   * **This is the KEYBOARD's way to an author's profile, and the reason the
   * face beside the message can stay out of the tab order.** The face is a
   * pointer and touch affordance; a room is a feed that costs one Tab per
   * message by contract (`room-entry-actions.spec.ts`), and a focusable disc
   * per author group broke that — a three-message room went from two presses to
   * cross to five. Routed through here it costs no Tab at all: the capsule is
   * reached with one arrow key from the message and walked with more, exactly
   * as Reply and Copy already are.
   *
   * Resolved by the row, which is the only part that can join the room's author
   * to the fleet — see `profileMemberIdOf`. Absent, the action is simply not
   * offered, the same way Mention is withheld from an author no `@` can reach.
   *
   * Must be referentially stable, like every other value this memo closes over.
   */
  onViewProfile?: (() => void) | undefined;
}

/**
 * Add a mention to a room's draft, leaving anything already typed alone.
 *
 * Appended rather than inserted at the caret: the caret is in the composer and
 * this runs from a message far up the history, so there is no caret position
 * this can honestly claim to know. A trailing space so the next word does not
 * fuse onto the handle, and a leading one so it does not fuse onto the sentence
 * already there.
 *
 * @param roomId - The room whose composer is being written into.
 * @param handle - The verified `handle`, without its `@`.
 */
function appendMention(roomId: string, handle: string): void {
  const drafts = useRoomDraftStore.getState();
  const held = drafts.drafts[roomId] ?? '';
  const lead = held === '' || held.endsWith(' ') || held.endsWith('\n') ? '' : ' ';
  drafts.set(roomId, `${held}${lead}@${handle} `);
}

/**
 * What this reader can do to this message, in the one order every rendering of
 * the surface draws.
 *
 * **Reply always aims at a thread ROOT, and opens that thread.** Answering a
 * reply targets the entry heading its thread ({@link replyRootFor}), because
 * the server refuses to nest deeper — so nothing here can produce a
 * `NESTED_THREAD` refusal, which is why no error path exists for one.
 *
 * What it opens is the side panel (design record §3), asking for the caret as
 * it does — pressing reply is a request to WRITE, and a panel that opened
 * without the caret would make the reader click into a box they just asked for.
 * It replaced a version that re-aimed the room's own composer at the thread,
 * which is the ambiguity the panel exists to remove.
 *
 * **Mention is offered only when it would work.** `handle` is `null` for an
 * author no `@` can reach — a person who has not chosen one, or a member whose
 * agent is gone — and offering a mention that silently addresses nobody is
 * worse than not offering one. The reader is also left off their own message,
 * matching the picker, which never lists them either.
 *
 * @param input - The room, the entry, its author, and who is reading.
 * @returns The actions to draw, in order.
 */
export function useEntryActions({
  roomId,
  entry,
  author,
  viewerAuthorId,
  onViewProfile,
}: EntryActionsInput): EntryAction[] {
  const rootEntryId = replyRootFor(entry);
  const text = entry.body.text;
  const handle = author?.id === viewerAuthorId ? undefined : (author?.handle ?? undefined);
  const authorName = author?.displayName;
  const { copy } = useCopyFeedback({ toastOnSettle: true });

  return useMemo(() => {
    const available: Partial<Record<EntryActionSlot, EntryAction>> = {
      reply: {
        id: 'reply',
        label: 'Reply in thread',
        icon: Reply,
        // Two ways to reach one composer, because the composer may or may not
        // exist yet when this runs. Opening with `focusComposer` covers the
        // press that MOUNTS the box — there is no composer for a focus request
        // to reach on that path. The focus request covers the press made while
        // the panel is already open, most often on a reply INSIDE it, where the
        // box exists and the open is a no-op. Each is silent on the other's
        // path, so both are needed and neither double-focuses.
        run: () => {
          useRoomOpenThreadStore.getState().openThread(roomId, rootEntryId, true);
          useComposerFocusStore.getState().requestFocus(threadDraftKey(roomId, rootEntryId));
        },
      },
      copy: {
        id: 'copy',
        label: 'Copy text',
        icon: Copy,
        // Says so, and says when it did not. Two of the three ways to reach this
        // close on the click — the menu and the drawer are gone before the copy
        // resolves — so there is nowhere on the surface itself to put the
        // answer, and a clipboard write can be refused outright by permissions.
        // `useCopyFeedback`'s toast fallback is the one pattern every such site
        // uses — the same shape `MemoryRecallBlock` uses.
        run: () => void copy(text),
      },
    };

    if (onViewProfile !== undefined) {
      available.profile = {
        id: 'profile',
        label: 'View profile',
        icon: User,
        run: onViewProfile,
      };
    }

    if (handle !== undefined) {
      available.mention = {
        id: 'mention',
        label: authorName === undefined ? 'Mention author' : `Mention ${authorName}`,
        icon: AtSign,
        run: () => {
          appendMention(roomId, handle);
          useComposerFocusStore.getState().requestFocus(roomId);
        },
      };
    }

    // Ordered BY the constant rather than by the shape of the object above, so
    // the capsule's order has one source and not two that agree today. The two
    // reaction slots simply have no command in here — the toolbar fills them,
    // from the same constant.
    return ENTRY_ACTION_ORDER.map((slot) => available[slot]).filter(
      (action): action is EntryAction => action !== undefined
    );
  }, [roomId, rootEntryId, text, handle, authorName, onViewProfile, copy]);
}
