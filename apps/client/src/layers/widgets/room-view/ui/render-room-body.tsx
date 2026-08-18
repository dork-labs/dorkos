/**
 * The room's body renderer — what a channel entry actually SAYS.
 *
 * One of the two implementations of {@link ConversationBodyRenderer}; the
 * session's is `features/chat/ui/render-session-body.tsx`. Neither knows about
 * the other, and `features/conversation` imports neither.
 *
 * Everything here is derived from the entry's own words, which is what makes it
 * one module: the markdown handed to Streamdown and the whitelist that decides
 * which `<mention>` tags may become pills change together when the body does,
 * and never when anything else about the row does.
 *
 * The spoof guard lives one door down in `MentionPillRenderer`
 * ({@link buildMentionComponents}) and is untouched: the pill gate is still
 * `entry.mentionSpans`, and this module is the only caller that builds it.
 *
 * @module widgets/room-view/ui/render-room-body
 */
import { useMemo } from 'react';
import type { ConversationBodyRenderer } from '@/layers/features/conversation';
import type { RoomEntry } from '@/layers/entities/room';
import { MarkdownContent } from '@/layers/shared/ui';
import {
  MENTION_ALLOWED_TAGS,
  MENTION_LITERAL_TAG_CONTENT,
  withMentionTags,
} from '../lib/mention-markup';
import type { RosterAuthor } from '../lib/room-timeline';
import { MentionRosterProvider } from '../model/mention-roster-context';
import { buildMentionComponents } from './MentionPillRenderer';

/** What the room's renderer needs beyond the entry itself. */
interface RoomBodyProps {
  /** The entry whose words are being drawn — its text and its mention spans. */
  entry: RoomEntry;
  /**
   * The room's whole roster, keyed by author id — what a `<mention>` resolves
   * against. A mention needs all of it because it can name anybody in the room,
   * not just this row's own author.
   */
  authors: ReadonlyMap<string, RosterAuthor>;
}

/**
 * The words of one room entry, with its mentions spliced through them.
 *
 * A component rather than a plain function because the memoisation is
 * load-bearing: this runs on every row of a feed that re-renders on every
 * arriving reaction, and the answer only changes when the words do.
 */
function RoomBody({ entry, authors }: RoomBodyProps) {
  // The body with every resolved mention spliced in as a literal `<mention>`
  // tag (`mention-markup.ts`), for `MarkdownContent` to draw a pill over.
  const markdown = useMemo(
    () => withMentionTags(entry.body.text, entry.mentionSpans),
    [entry.body.text, entry.mentionSpans]
  );
  // Which author ids the SERVER actually spanned for this entry — the
  // whitelist `buildMentionComponents` gates on. `markdown` only ever splices
  // a `<mention>` tag for one of these, but Streamdown cannot tell a spliced
  // tag from one somebody typed literally in their message: both parse as the
  // same element once `mention` is an allowed tag. Without this set, a body
  // containing `<mention author_id="<a real roster id>">fake</mention>` would
  // resolve and render exactly like a real mention — this is what keeps it
  // inert instead.
  const spannedIds = useMemo(
    () => new Set(entry.mentionSpans?.map((span) => span.authorId) ?? []),
    [entry.mentionSpans]
  );
  // The `mention` tag's renderer, closed over the spans that authorize it —
  // and nothing else. WHO each pill names travels by context instead
  // (`MentionRosterProvider` below), because Streamdown's top-level memo
  // comparator leaves `components` out and would freeze anything delivered
  // this way at the moment the message was first drawn. Built even for a body
  // with no mentions in it — cheap, and it keeps this renderer from having to
  // know in advance whether `markdown` contains any.
  const mentionComponents = useMemo(() => buildMentionComponents(spannedIds), [spannedIds]);

  return (
    // The roster, on the one channel that reaches a pill Streamdown has already
    // drawn. Above the markdown rather than inside it: context propagates
    // through a memo bail-out, so renaming a member or watching one leave
    // redraws every mention of them on screen without re-parsing a word of the
    // message (DOR-989).
    <MentionRosterProvider authors={authors}>
      <MarkdownContent
        content={markdown}
        allowedTags={MENTION_ALLOWED_TAGS}
        literalTagContent={MENTION_LITERAL_TAG_CONTENT}
        components={mentionComponents}
      />
    </MentionRosterProvider>
  );
}

/**
 * Build the room's body renderer for one roster.
 *
 * A factory rather than a bare renderer because the roster is per-room and the
 * renderer signature is deliberately narrow — the timeline hands back the
 * payload it was given and nothing else.
 *
 * **No carve-out for a right-click on a link, and none is needed** — but not for
 * free. Every link form — markdown, autolink, bare URL — renders as a real
 * `<a href>` (DOR-1272, `MarkdownLink`), and only a plain left click is
 * intercepted for the confirmation modal. A right-click on the row still lands
 * on `EntryActionMenu`'s Radix `ContextMenuTrigger` (`Message.Root`), which
 * `preventDefault()`s `contextmenu` unconditionally — so without
 * `MarkdownLink`'s own `onContextMenu={stopPropagation}`, a right-click on a
 * link would open the ROW's menu (no copy-link item) instead of the browser's.
 * With it, the event never reaches the trigger, so the browser's native menu
 * wins — "Copy Link Address" included — same as any other link on the page.
 * Pinned in `RoomMessage.test.tsx`.
 *
 * @param authors - The room's roster, keyed by author id.
 * @returns The renderer this room's rows draw their bodies with.
 */
export function makeRoomBodyRenderer(
  authors: ReadonlyMap<string, RosterAuthor>
): ConversationBodyRenderer {
  return (payload) => <RoomBody entry={payload as RoomEntry} authors={authors} />;
}
