/**
 * Bind the entry action set to the room it is acting on.
 *
 * @module features/entry-actions/model/use-entry-actions
 */
import { useMemo } from 'react';
import { AtSign, Copy, Reply } from 'lucide-react';
import { toast } from 'sonner';
import {
  replyRootFor,
  useRoomDraftStore,
  useRoomReplyTargetStore,
  type AuthorRef,
  type RoomEntry,
} from '@/layers/entities/room';
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
 * @param handle - The verified `mentionHandle`, without its `@`.
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
 * **Reply is always offered and always aims at a thread ROOT.** Answering a
 * reply targets the entry heading its thread ({@link replyRootFor}), because
 * the server refuses to nest deeper and because one level is what the timeline
 * draws — so the thread the reader is answering into is the one they can see.
 * Nothing here can produce a `NESTED_THREAD` refusal, which is why no error
 * path exists for one.
 *
 * **Mention is offered only when it would work.** `mentionHandle` is absent for
 * an author no `@` can reach — every name they answer to either contains a
 * space or belongs to an earlier member — and offering a mention that silently
 * addresses nobody is worse than not offering one. The reader is also left off
 * their own message, matching the picker, which never lists them either.
 *
 * @param input - The room, the entry, its author, and who is reading.
 * @returns The actions to draw, in order.
 */
export function useEntryActions({
  roomId,
  entry,
  author,
  viewerAuthorId,
}: EntryActionsInput): EntryAction[] {
  const rootEntryId = replyRootFor(entry);
  const text = entry.body.text;
  const handle = author?.id === viewerAuthorId ? undefined : author?.mentionHandle;
  const authorName = author?.displayName;

  return useMemo(() => {
    const available: Partial<Record<EntryActionSlot, EntryAction>> = {
      reply: {
        id: 'reply',
        label: 'Reply in thread',
        icon: Reply,
        run: () => useRoomReplyTargetStore.getState().replyTo(roomId, rootEntryId),
      },
      copy: {
        id: 'copy',
        label: 'Copy text',
        icon: Copy,
        // Says so, and says when it did not. Two of the three ways to reach this
        // close on the click — the menu and the drawer are gone before the copy
        // resolves — so there is nowhere on the surface itself to put the
        // answer, and a clipboard write can be refused outright by permissions.
        // The same shape `MemoryRecallBlock` uses.
        run: () => {
          void navigator.clipboard
            ?.writeText(text)
            .then(() => toast.success('Copied to clipboard'))
            .catch(() => toast.error('Failed to copy'));
        },
      },
    };

    if (handle !== undefined) {
      available.mention = {
        id: 'mention',
        label: authorName === undefined ? 'Mention author' : `Mention ${authorName}`,
        icon: AtSign,
        run: () => {
          appendMention(roomId, handle);
          useRoomReplyTargetStore.getState().requestFocus(roomId);
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
  }, [roomId, rootEntryId, text, handle, authorName]);
}
