/**
 * The `mention` tag Streamdown renders for each `<mention author_id="...">`
 * `mention-markup.ts` spliced into a room entry's body — resolves the id
 * against the room's roster and draws a {@link MentionPill}.
 *
 * {@link buildMentionComponents} is the actual `components.mention` entry;
 * it only ever hands this component an id the entry's own `mentionSpans`
 * named — see its own doc for why that gate exists.
 *
 * @module widgets/room-view/ui/MentionPillRenderer
 */
import type { ReactNode } from 'react';
import type { Components } from 'streamdown';
import { IdentityHoverCard, MentionPill } from '@/layers/shared/ui';
import { MENTION_AUTHOR_ATTR } from '../lib/mention-markup';
import type { RosterAuthor } from '../lib/room-timeline';

interface MentionPillRendererProps {
  /**
   * The room's roster, keyed by author id — the only source of truth for who
   * a resolved mention names.
   */
  authors: ReadonlyMap<string, RosterAuthor>;
  /** The `author_id` Streamdown read off the tag, or `undefined` if it was missing. */
  authorId: string | undefined;
  /**
   * The tag's literal content — exactly the `@handle` substring the span
   * matched (`mention-markup.ts`), never re-parsed as markdown
   * (`literalTagContent`). Read only for the unresolved fallback; a resolved
   * pill names itself from the roster instead, so the tag's own text can
   * never be used to make a mention claim something the roster does not back.
   */
  children?: ReactNode;
}

/** The mention's own text with its leading `@` trimmed — `MentionPill` adds one back. */
function handleLabel(children: ReactNode): string {
  return typeof children === 'string' ? children.replace(/^@/, '') : '';
}

/**
 * Draws a resolved mention as {@link MentionPill} wrapped in
 * {@link IdentityHoverCard}, or — for an id the roster no longer holds, a
 * departed member — the pill's own unstyled fallback. Never throws: an id
 * this cannot resolve degrades to plain text rather than taking the message
 * around it down with it.
 *
 * Only ever invoked by {@link buildMentionComponents} for an `authorId` the
 * entry's own `mentionSpans` named — this component trusts that already
 * happened and does not re-check it, so it is not safe to call directly with
 * an arbitrary id from elsewhere.
 *
 * Click is deferred (no profile route exists yet), so the pill renders with
 * `interactive` left at its default `false` — hover-only.
 */
export function MentionPillRenderer({ authors, authorId, children }: MentionPillRendererProps) {
  const author = authorId ? authors.get(authorId) : undefined;

  if (!author) {
    // `kind` is ignored on this path — `MentionPill` returns plain text for
    // any kind once `resolved` is false — but the type still asks for one.
    return <MentionPill kind="human" label={handleLabel(children)} resolved={false} />;
  }

  return (
    <IdentityHoverCard
      identity={{
        kind: author.kind,
        displayName: author.displayName,
        handle: author.mentionHandle,
        color: author.color,
        emoji: author.emoji,
        origin: author.origin,
      }}
    >
      <MentionPill
        kind={author.kind}
        label={author.displayName}
        handle={author.mentionHandle}
        color={author.color}
        origin={author.origin}
        resolved
      />
    </IdentityHoverCard>
  );
}

/**
 * Build the Streamdown `components` map that wires its `mention` tag to
 * {@link MentionPillRenderer}, closing over the room's roster and — the part
 * that keeps this safe — the ids the SERVER actually spanned for this entry.
 *
 * **Why the whitelist, not just `allowedTags`.** Streamdown parses a
 * `<mention author_id="...">` the same way whether `mention-markup.ts`
 * spliced it in or somebody simply typed it into their message — the tag
 * grammar cannot tell the two apart, only where a span record says a real
 * `@handle` occurrence was. Without this gate, a body containing
 * `<mention author_id="<any live roster id>">fake</mention>` would resolve
 * and draw a full, correctly-identified pill for someone the server never
 * actually addressed here. `spannedIds` is that record; `authorId` not in it
 * means "not a real mention in this entry", and the tag renders as its own
 * literal text — never a pill, not even the unresolved-fallback one, which
 * would still dress typed text up with a leading `@` it did not earn.
 *
 * A plain function rather than a hook: the only state involved is `authors`
 * and `spannedIds`, so the caller memoizes on those (`RoomEntryRow` already
 * does, via `useMemo`) instead of this module owning a second copy of that
 * decision.
 *
 * @param authors - The room's roster, keyed by author id.
 * @param spannedIds - Author ids `entry.mentionSpans` actually names for this
 *   entry — the only ids a `<mention>` tag may resolve against.
 */
export function buildMentionComponents(
  authors: ReadonlyMap<string, RosterAuthor>,
  spannedIds: ReadonlySet<string>
): Components {
  return {
    mention: (props: Record<string, unknown>) => {
      const authorIdValue = props[MENTION_AUTHOR_ATTR];
      const authorId = typeof authorIdValue === 'string' ? authorIdValue : undefined;

      if (!authorId || !spannedIds.has(authorId)) {
        // Not a mention the server actually made here — typed, forged, or
        // otherwise unaccounted for. Render exactly the literal text the tag
        // wrapped, same as if `mention` were never an allowed tag at all.
        return <>{props.children as ReactNode}</>;
      }

      return (
        <MentionPillRenderer authors={authors} authorId={authorId}>
          {props.children as ReactNode}
        </MentionPillRenderer>
      );
    },
  };
}
