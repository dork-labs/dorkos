import { tv } from 'tailwind-variants';

/**
 * Multi-slot variant definition for MessageItem layout and styling.
 *
 * User messages render as right-aligned rounded bubbles with constrained width.
 * Assistant messages render full-width with no bubble (left-aligned).
 *
 * Slots: root, content, timestamp, divider.
 * Variants: role (user/assistant), position (first/middle/last/only), density (comfortable/compact).
 */
export const messageItem = tv({
  slots: {
    root: 'group relative flex gap-[var(--msg-gap)] transition-colors duration-150',
    content: 'min-w-0 text-sm',
    timestamp: 'absolute top-1 right-4 hidden text-xs transition-colors duration-150 sm:inline',
    divider: 'absolute inset-x-0 top-0 h-px bg-[var(--msg-divider-color)]',
  },
  variants: {
    role: {
      user: {
        root: 'ml-auto max-w-[var(--msg-user-max-width)] rounded-msg bg-user-msg px-4 py-2.5 hover:bg-user-msg/90',
        content: 'font-[var(--msg-user-font-weight)]',
      },
      assistant: {
        root: 'w-full px-[var(--msg-padding-x)] py-[var(--msg-padding-y)] rounded-msg hover:bg-muted',
        content: 'max-w-[var(--msg-content-max-width)] flex-1 font-[var(--msg-assistant-font-weight)]',
      },
    },
    position: {
      first: {},
      middle: {},
      last: {},
      only: {},
    },
    density: {
      comfortable: {},
      compact: {
        root: 'px-3',
        content: 'text-xs',
      },
    },
  },
  compoundVariants: [
    // --- Assistant vertical padding (preserves existing token behavior) ---
    { role: 'assistant', position: 'first', class: { root: 'pt-[var(--msg-padding-y-start)] pb-[var(--msg-padding-y-mid)]' } },
    { role: 'assistant', position: 'middle', class: { root: 'pt-[var(--msg-padding-y-mid)] pb-[var(--msg-padding-y-mid)]' } },
    { role: 'assistant', position: 'last', class: { root: 'pt-[var(--msg-padding-y-mid)] pb-[var(--msg-padding-y-end)]' } },
    { role: 'assistant', position: 'only', class: { root: 'pt-[var(--msg-padding-y-start)] pb-[var(--msg-padding-y-end)]' } },
    // --- User vertical spacing (margin-based for bubble gaps) ---
    { role: 'user', position: 'first', class: { root: 'mt-3 mb-px' } },
    { role: 'user', position: 'middle', class: { root: 'my-px' } },
    { role: 'user', position: 'last', class: { root: 'mt-px mb-3' } },
    { role: 'user', position: 'only', class: { root: 'mt-3 mb-3' } },
    // --- User grouped radius (tight right corners for stacked bubbles) ---
    { role: 'user', position: 'first', class: { root: 'rounded-br-msg-tight' } },
    { role: 'user', position: 'middle', class: { root: 'rounded-r-msg-tight' } },
    { role: 'user', position: 'last', class: { root: 'rounded-tr-msg-tight' } },
  ],
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

