import { tv } from 'tailwind-variants';

/**
 * Multi-slot variant definition for the one message row's layout and styling.
 *
 * Every author renders in the same left-gutter layout (spec
 * `multi-participant-message-list`, D1): a fixed-width identity column holding
 * the avatar, then the content column. A continuation leaves the gutter empty —
 * so its content stays flush under the group start — and its timestamp appears
 * there on hover. There is no right-aligned bubble: identity comes from the
 * avatar and the name, which keeps working past two participants.
 *
 * Slots: root, gutter, avatarTimestamp, body, header, authorName, timestamp,
 * actions, content.
 * Variants: role (user/assistant — typography only), position
 * (first/middle/last/only — vertical rhythm), density (comfortable/compact).
 */
export const messageItem = tv({
  slots: {
    root: 'group hover:bg-muted rounded-msg relative flex w-full gap-[var(--msg-gap)] px-[var(--msg-padding-x)] transition-colors duration-150',
    /** Identity column — the avatar on a group start, the hover timestamp on a continuation. */
    gutter: 'relative flex w-[var(--msg-gutter-width)] shrink-0 justify-center',
    /**
     * A continuation's timestamp, right-aligned in the gutter. It overflows
     * left into the row's padding, which is where the extra width for a
     * locale's day period ("10:42 AM") comes from. Small-screen-hidden, as the
     * old absolute timestamp was: it is a hover affordance, and touch has none.
     */
    avatarTimestamp:
      'absolute top-0.5 right-0 hidden text-3xs leading-none whitespace-nowrap tabular-nums transition-colors duration-150 sm:block',
    body: 'flex min-w-0 flex-1 flex-col',
    header: 'flex items-baseline gap-2',
    authorName: 'truncate text-sm font-medium',
    timestamp: 'text-xs tabular-nums transition-colors duration-150',
    /**
     * Hover action toolbar for a message row (D6). A container, not a single
     * button — how it is anchored is the `anchor` variant below.
     *
     * `pointer-events-none` while invisible: the toolbar floats above message
     * text that is explicitly selectable (see `content` below), so an
     * unhittable-but-present click target would eat drags that start in its
     * corner. Pointer events come back on hover, and on focus-within so the
     * keyboard path still reaches it without a pointer ever being involved.
     *
     * `bg-popover` is opaque in both themes (`0 0% 100%` / `0 0% 4%`, no alpha),
     * which is what a control drawn ON TOP of a paragraph needs — the words
     * underneath must not show through the icons. `shadow-elevated` rather than
     * `shadow-soft` because this floats over content instead of sitting in the
     * page: it is one rung up the same `--elevation-*` ladder, and that ladder
     * is tuned per theme (0.05 alpha light, 0.5 dark) where a raw `shadow-md`
     * would all but vanish against a near-black background.
     *
     * How it ARRIVES is the `anchor` variant's business, not this slot's — the
     * two anchors reveal at different speeds and only one of them moves.
     */
    actions:
      'bg-popover shadow-elevated pointer-events-none z-10 flex items-center gap-0.5 rounded-md border p-0.5 opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100',
    // desktop:select-text: the desktop shell defaults chrome to non-selectable
    // on every platform (index.css, DOR-562), but message bodies — text, code
    // blocks, command output — are exactly what a user copies out of a chat,
    // so this single container re-enables selection for everything a message
    // renders rather than scattering the re-enable across each content type
    // (DOR-253).
    content: 'min-w-0 max-w-[var(--msg-content-max-width)] text-sm desktop:select-text',
  },
  variants: {
    // Role no longer changes layout — only the weight the two voices read at.
    role: {
      user: { content: 'font-[var(--msg-user-font-weight)]' },
      assistant: { content: 'font-[var(--msg-assistant-font-weight)]' },
    },
    // Vertical rhythm: a group opens and closes with air, its middle stays tight.
    position: {
      first: { root: 'pt-[var(--msg-padding-y-start)] pb-[var(--msg-padding-y-mid)]' },
      middle: { root: 'pt-[var(--msg-padding-y-mid)] pb-[var(--msg-padding-y-mid)]' },
      last: { root: 'pt-[var(--msg-padding-y-mid)] pb-[var(--msg-padding-y-end)]' },
      only: { root: 'pt-[var(--msg-padding-y-start)] pb-[var(--msg-padding-y-end)]' },
    },
    density: {
      comfortable: {},
      compact: {
        root: 'px-3',
        content: 'text-xs',
      },
    },
    /**
     * How the action toolbar is held against the row.
     *
     * `corner` pins it to the row's top-right and is right for session chat,
     * where a message is one turn and the toolbar is never far from the top of
     * what it acts on.
     *
     * `rail` leaves positioning to a `sticky` wrapper the caller supplies, which
     * is what a ROOM needs: a long message scrolled past its own top would put a
     * corner-pinned toolbar off screen, exactly the hole Slack's top-anchored
     * toolbar has. Sticky keeps it at the top of the message while that is
     * visible and clamps it to the viewport edge once the message extends above,
     * with no popper math and nothing to reposition on scroll.
     *
     * `focus-within` is widened to the whole ROW here, so the toolbar shows when
     * the message takes focus and the keyboard can see what it is stepping into
     * — but only on a device with a real pointer. A room's message is focusable,
     * and on a touch screen a TAP focuses it, so an ungated rule paints the
     * toolbar over the message's first line for anyone who merely touched it.
     * Touch gets the long-press drawer and nothing else. `pointer-coarse` is the
     * repo's existing spelling of this split (`StatusLine`), and `hover:` is
     * already gated the same way by Tailwind v4.
     */
    anchor: {
      corner: { actions: 'absolute top-1 right-2 transition-opacity duration-150' },
      rail: {
        actions: [
          'relative',
          'pointer-fine:group-focus-within:pointer-events-auto pointer-fine:group-focus-within:opacity-100',
          // How it arrives (design record §5.1): a 90ms fade with a 5px rise
          // that overshoots about a pixel and settles (`animate-capsule-in`,
          // defined in `index.css`). Leaving is a plain, faster fade with
          // nothing moving — which is why the rise is an ANIMATION and not a
          // transition: an animation only exists while the row is revealed, so
          // there is no return leg to suppress. A transition would slide the
          // capsule back down through the fade, reading as a dismissal.
          //
          // `motion-safe:` gates the rise, and the fade needs no gate of its
          // own: the global reduced-motion rule in `index.css` collapses every
          // transition to a hundredth of a millisecond, so a reader who has
          // asked for less motion gets the capsule in a single frame, already
          // where it settles. Soft for everyone else, instant for them.
          //
          // Repeated per reveal rule rather than shared, because Tailwind only
          // emits classes it can SEE — a variant built by template string is a
          // class that never gets generated.
          'transition-opacity duration-(--msg-actions-fade-out) ease-out',
          'group-hover:motion-safe:animate-capsule-in group-hover:duration-(--msg-actions-fade-in)',
          'focus-within:motion-safe:animate-capsule-in focus-within:duration-(--msg-actions-fade-in)',
          'pointer-fine:group-focus-within:motion-safe:animate-capsule-in pointer-fine:group-focus-within:duration-(--msg-actions-fade-in)',
        ],
      },
    },
  },
  defaultVariants: {
    role: 'assistant',
    position: 'only',
    density: 'comfortable',
    anchor: 'corner',
  },
});

/**
 * Variant for tool call status icon coloring.
 * Maps tool execution state to semantic status token classes.
 */
export const toolStatus = tv({
  variants: {
    status: {
      pending: 'text-status-pending',
      running: 'text-status-info',
      complete: 'text-status-success',
      error: 'text-status-error',
      // Ended, outcome unobserved. The one status with no semantic colour of its
      // own on purpose — success green and error red are both claims, and this
      // state exists precisely because neither was witnessed.
      neutral: 'text-muted-foreground',
    },
  },
});
