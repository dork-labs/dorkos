/**
 * The strip's visual theme: the glyph that sits beside what the session is
 * doing, and how it animates.
 *
 * It used to carry a pool of joke verbs too. It does not any more (DOR-1053) —
 * the words are the session's real activity, so a theme decorates the strip
 * without ever speaking for the agent.
 *
 * @module features/chat/ui/status/inference-themes
 */
export interface IndicatorTheme {
  /** Theme id, for pickers and tests. */
  name: string;
  /** The glyph shown while a turn is in flight, e.g. "✨", "❄". */
  icon: string;
  /** CSS `@keyframes` name to animate the glyph with, or null for static. */
  iconAnimation: string | null;
}

/** The theme every session uses unless something says otherwise. */
export const DEFAULT_THEME: IndicatorTheme = {
  name: 'default',
  icon: '✨',
  iconAnimation: 'shimmer-tasks',
};

// Example holiday theme (not active — demonstrates the pluggable theme system):
//
// export const WINTER_THEME: IndicatorTheme = {
//   name: 'winter',
//   icon: '❄',
//   iconAnimation: null,  // static snowflake
// };
