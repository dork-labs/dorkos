import { tv } from 'tailwind-variants';

/**
 * Multi-slot variant definition for MessageItem layout and styling.
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
      'absolute top-0.5 right-0 hidden text-[10px] leading-none whitespace-nowrap tabular-nums transition-colors duration-150 sm:block',
    body: 'flex min-w-0 flex-1 flex-col',
    header: 'flex items-baseline gap-2',
    authorName: 'truncate text-sm font-medium',
    timestamp: 'text-xs tabular-nums transition-colors duration-150',
    /**
     * Hover action toolbar at the row's top-right (D6). A container, not a
     * single button: reactions and reply-in-thread land here in later phases.
     *
     * `pointer-events-none` while invisible: the toolbar floats above message
     * text that is explicitly selectable (see `content` below), so an
     * unhittable-but-present click target would eat drags that start in its
     * corner. Pointer events come back on hover, and on focus-within so the
     * keyboard path still reaches it without a pointer ever being involved.
     */
    actions:
      'bg-popover shadow-soft pointer-events-none absolute top-1 right-2 z-10 flex items-center gap-0.5 rounded-md border p-0.5 opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100',
    // desktop-darwin:select-text: the desktop shell defaults chrome to
    // non-selectable (index.css), but message bodies — text, code blocks,
    // command output — are exactly what a user copies out of a chat, so this
    // single container re-enables selection for everything a message renders
    // rather than scattering the re-enable across each content type (DOR-253).
    content: 'min-w-0 max-w-[var(--msg-content-max-width)] text-sm desktop-darwin:select-text',
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
  },
  defaultVariants: {
    role: 'assistant',
    position: 'only',
    density: 'comfortable',
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
    },
  },
});
