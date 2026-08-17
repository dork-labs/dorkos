/**
 * What a room entry actually SAYS — the rendered message body, the mentions
 * spliced through it, and the one-line description that stands in for it.
 *
 * Everything here is derived from the entry's own words, which is what makes it
 * one module: the markdown handed to Streamdown, the whitelist that decides
 * which `<mention>` tags may become pills, and the summary a screen reader
 * hears in place of a pasted diff all change together when the body does, and
 * never when anything else about the row does.
 *
 * The spoof guard lives one door down in `MentionPillRenderer`
 * ({@link buildMentionComponents}) and is untouched by this split: the pill
 * gate is still `entry.mentionSpans`, and this module is the only caller that
 * builds it.
 *
 * @module widgets/room-view/ui/RoomEntryBody
 */
import { useMemo } from 'react';
import { cn } from '@/layers/shared/lib';
import { MarkdownContent } from '@/layers/shared/ui';
import type { RoomEntry } from '@/layers/entities/room';
import {
  MENTION_ALLOWED_TAGS,
  MENTION_LITERAL_TAG_CONTENT,
  withMentionTags,
} from '../lib/mention-markup';
import type { RosterAuthor } from '../lib/room-timeline';
import { MentionRosterProvider } from '../model/mention-roster-context';
import { buildMentionComponents } from './MentionPillRenderer';

interface RoomEntryBodyProps {
  /** The entry whose words are being drawn — its text and its mention spans. */
  entry: RoomEntry;
  /**
   * The room's whole roster, keyed by author id — what a `<mention>` resolves
   * against. See `RoomEntryRow`, which takes the same map and says why a
   * mention needs all of it.
   */
  authors: ReadonlyMap<string, RosterAuthor>;
  /** The DOM id on the content region, which the row may describe itself with. */
  contentId: string;
  /**
   * The line that describes this message where the message is too long or too
   * code-heavy to describe itself, or `null` where the words already read as
   * one line. `entrySummary` decides which of those a message is.
   */
  summary: string | null;
  /** The DOM id on that line, which the row describes itself with instead. */
  summaryId: string;
  /** The content column's own layout (`messageItem`'s `content` slot). */
  className: string;
}

/**
 * The message itself, and the description that answers for it.
 *
 * **The article describes itself in a line, not in full.** The description a
 * feed's articles carry is what a reader crossing the feed decides on, and
 * pointing it at the whole rendered body meant a message with a pasted diff in
 * it read the diff out before saying anything about itself. `entrySummary` owns
 * that line and says what it drops; the row points at whichever of the two
 * elements below is the honest description of this message.
 */
export function RoomEntryBody({
  entry,
  authors,
  contentId,
  summary,
  summaryId,
  className,
}: RoomEntryBodyProps) {
  // The body with every resolved mention spliced in as a literal `<mention>`
  // tag (`mention-markup.ts`), for `MarkdownContent` to draw a pill over.
  // Memoised because this runs on every row of a feed that re-renders on every
  // arriving reaction, and the answer only changes when the words do.
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
  // with no mentions in it — cheap, and it keeps this row from having to know
  // in advance whether `markdown` contains any.
  const mentionComponents = useMemo(() => buildMentionComponents(spannedIds), [spannedIds]);

  return (
    <>
      {/*
        No carve-out for a right-click on a link, and none is needed. Under
        `linkSafety`, which this call site passes, every link form — markdown,
        autolink, bare URL — still renders as a real `<a href>` (DOR-1272,
        `MarkdownLink`); only a plain left click is intercepted for the
        confirmation modal. A right-click reaches the browser's own native
        menu — "Copy Link Address" included — same as any other link on the
        page, so our own row menu has nothing to add here.
      */}
      <div
        id={contentId}
        data-slot="message-content"
        className={cn(
          className,
          // A long unbroken token — a URL, a file path, a hash pasted as
          // `code` — is wider than the column and had nowhere to go: the
          // column is `min-w-0`, so the overflow was simply clipped and the
          // end of the token was unreadable and unselectable. Inline code
          // breaks mid-token, which is right for something that is not
          // prose; a fenced block scrolls instead, because breaking a line
          // of code changes what it says.
          '[&_:not(pre)>code]:wrap-anywhere [&_pre]:overflow-x-auto'
        )}
      >
        {/*
          The roster, on the one channel that reaches a pill Streamdown has
          already drawn. Above the markdown rather than inside it: context
          propagates through a memo bail-out, so renaming a member or watching
          one leave redraws every mention of them on screen without re-parsing a
          word of the message (DOR-989).
        */}
        <MentionRosterProvider authors={authors}>
          <MarkdownContent
            content={markdown}
            linkSafety
            allowedTags={MENTION_ALLOWED_TAGS}
            literalTagContent={MENTION_LITERAL_TAG_CONTENT}
            components={mentionComponents}
          />
        </MentionRosterProvider>
      </div>
      {summary !== null && (
        /*
          The article's description, for a message too long or too code-heavy
          to be its own — and deliberately `display:none`.

          A description is resolved from the element it points AT whether or
          not that element is displayed, which is what makes this the one
          place a summary can live without also being read twice: `sr-only`
          would put it back in the row's own contents, so a screen reader
          would hear the summary and then the message.
        */
        <span id={summaryId} className="hidden">
          {summary}
        </span>
      )}
    </>
  );
}
