/**
 * The `mention` tag Streamdown renders for each `<mention author_id="...">`
 * `mention-markup.ts` spliced into a room entry's body — resolves the id
 * against the room's roster and draws a {@link MentionPill}.
 *
 * {@link buildMentionComponents} is the actual `components.mention` entry;
 * it only ever hands this component an id the entry's own `mentionSpans`
 * named — see its own doc for why that gate exists.
 *
 * **The id arrives by prop; everything the id RESOLVES TO arrives by context.**
 * That division is what keeps a drawn pill honest as the room changes under it
 * — `mention-roster-context` explains what Streamdown does to anything sent the
 * other way.
 *
 * @module widgets/room-view/ui/MentionPillRenderer
 */
import type { KeyboardEvent, ReactNode } from 'react';
import type { Components } from 'streamdown';
import { IdentityHoverCard, MentionPill } from '@/layers/shared/ui';
import { resolveIdentityFace } from '@/layers/shared/lib';
import { useProfileDeepLink } from '@/layers/shared/model';
import { profileMemberIdOf } from '@/layers/entities/room';
import { MENTION_AUTHOR_ATTR } from '../lib/mention-markup';
import { useAgentInfo } from '../model/agent-info-context';
import { useMentionAuthor } from '../model/mention-roster-context';

interface MentionPillRendererProps {
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
 * **A resolved pill is a link to a profile** (DOR-957): click, tap, or Enter
 * opens the drawer, and the hover card's own footer opens the same one. On a
 * touch screen the tap IS the answer — the card is a pointer affordance, and a
 * finger goes straight to the full version of what it summarises.
 *
 * The pill only becomes interactive when {@link profileMemberIdOf} can name
 * this author to the ROSTER. A pill that could not be named stays exactly as
 * it was before this: hover-only, with the card's footer still reading
 * **soon** — an inert affordance is honest, a click that opens nothing is not.
 */
export function MentionPillRenderer({ authorId, children }: MentionPillRendererProps) {
  // Who this mention names, as of right now. Read from a context rather than
  // from the component map that decided to draw this pill at all, because that
  // map cannot deliver an update: Streamdown's top-level memo comparator
  // (2.5.0) does not include `components`, so a rebuilt map re-renders nothing
  // below it and a pill drawn before somebody was renamed — or before they left
  // — would go on naming them the old way for as long as the message stayed on
  // screen (DOR-989).
  const author = useMentionAuthor(authorId);
  // How this agent runs, if the room's provider could find out — the same
  // channel, for the same reason (DOR-954): a fleet answer that lands after the
  // pill was drawn has no other way in, and every card in a room opened before
  // it came up bare. `undefined` for a human, for an agent nothing resolved, and
  // outside a provider — all one answer, because all three mean the same thing
  // here: draw no chip.
  const agent = useAgentInfo(author?.agentRef);
  const { open: openProfile } = useProfileDeepLink();

  if (!author) {
    // `kind` is ignored on this path — `MentionPill` returns plain text for
    // any kind once `resolved` is false — but the type still asks for one.
    return <MentionPill kind="human" label={handleLabel(children)} resolved={false} />;
  }

  // The same ladder the gutter climbs, with the same override — `agent.visual`
  // is the face resolved off this agent's own manifest, and the card opens off
  // a message whose disc is already wearing it. Reading `author.color` and
  // `author.emoji` straight off the render cache is what left the two
  // disagreeing: 🦊 in the gutter, a grey letter in the card describing it.
  const face = resolveIdentityFace({ record: author, override: agent?.visual });
  const memberId = profileMemberIdOf(author, agent?.memberId);
  const viewProfile = memberId === undefined ? undefined : () => openProfile(memberId);
  // A `<span>` that acts like a button has to say so and be reachable: Radix's
  // hover card gives the trigger focus already, and this is what makes that
  // focus mean something. `Space` as well as `Enter` because a role of button
  // promises both.
  const pillControl = viewProfile
    ? {
        role: 'button',
        tabIndex: 0,
        // Names the ACTION, the same way the Team card and the sidebar face do
        // — the visible text is only who, which is the half a reader can
        // already see. The name stays inside the label, so this still satisfies
        // "label in name" for anyone driving by voice.
        'aria-label': `View ${author.displayName}’s profile`,
        onClick: viewProfile,
        onKeyDown: (event: KeyboardEvent<HTMLSpanElement>) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          viewProfile();
        },
      }
    : {};

  return (
    <IdentityHoverCard
      onViewProfile={viewProfile}
      identity={{
        kind: author.kind,
        displayName: author.displayName,
        handle: author.handle ?? undefined,
        color: face.color,
        emoji: face.emoji,
        // The card and the message gutter draw the same person, so they climb
        // the same ladder. Omitting this is how a photo would show beside
        // somebody's message and an emoji inside the card that describes them.
        imageUrl: face.imageUrl,
        origin: author.origin,
        // The card draws a chip per fact it is handed and nothing at all for
        // one it is not, so an agent whose manifest never resolved reads as
        // name and handle alone rather than as an invented runtime. Spelled
        // out rather than passed whole because `memberId` is a routing fact,
        // not something the card should be able to draw.
        agent: agent && { runtime: agent.runtime, ...(agent.model && { model: agent.model }) },
      }}
    >
      <MentionPill
        kind={author.kind}
        label={author.displayName}
        handle={author.handle ?? undefined}
        // The raw cache on purpose, where the CARD above takes the resolved
        // face. A pill tints a run of text rather than drawing a face, and it
        // falls to `currentColor` for everyone today; giving it a fleet colour
        // is its own decision about inline text, tracked separately.
        color={author.color}
        origin={author.origin}
        resolved
        interactive={viewProfile !== undefined}
        {...pillControl}
      />
    </IdentityHoverCard>
  );
}

/**
 * Build the Streamdown `components` map that wires its `mention` tag to
 * {@link MentionPillRenderer}, closing over the part that keeps this safe: the
 * ids the SERVER actually spanned for this entry.
 *
 * **Structure only — never identity.** This map decides WHETHER a tag becomes a
 * pill; who that pill names arrives separately, through
 * `MentionRosterProvider`. That split is not a style preference: Streamdown's
 * top-level memo comparator (2.5.0) leaves `components` out, so anything
 * delivered through this map is frozen at the moment the message was first
 * drawn. `spannedIds` can live here precisely because it is frozen too — it is
 * derived from the same `mentionSpans` that produce the body text, so it never
 * changes without the text changing with it, and the text IS compared.
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
 * A plain function rather than a hook: the only state involved is
 * `spannedIds`, so the caller memoizes on that (`the room's body renderer` already does,
 * via `useMemo`) instead of this module owning a second copy of that decision.
 *
 * @param spannedIds - Author ids `entry.mentionSpans` actually names for this
 *   entry — the only ids a `<mention>` tag may resolve against.
 */
export function buildMentionComponents(spannedIds: ReadonlySet<string>): Components {
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
        <MentionPillRenderer authorId={authorId}>{props.children as ReactNode}</MentionPillRenderer>
      );
    },
  };
}
