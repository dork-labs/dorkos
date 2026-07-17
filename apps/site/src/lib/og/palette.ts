/**
 * @module lib/og/palette
 *
 * Shared brand constants for every `ImageResponse` Open Graph route. Centralizes
 * the cream + orange/green identity, the standard 1200x630 canvas, and the two
 * brand font-family names so OG routes compose from one palette instead of
 * hand-repeating hex codes. Colors mirror the site's Tailwind theme tokens
 * (cream, charcoal, warm gray, brand orange/green).
 */

/** The standard Open Graph / Twitter card canvas: 1200x630. */
export const OG_SIZE = { width: 1200, height: 630 } as const;

/** Brand palette used across OG cards. */
export const OG_COLORS = {
  /** Cream card background (marketplace, features, blog). */
  cream: '#F5F0E8',
  /** Dominant title / near-black ink on cream cards. */
  charcoal: '#1A1714',
  /** Body copy on cream cards. */
  warmGray: '#6B5E4E',
  /** Eyebrow labels and muted metadata on cream cards. */
  warmGrayLight: '#9B8E7E',
  /** Primary brand accent. */
  brandOrange: '#E86C3A',
  /** Secondary brand accent. */
  brandGreen: '#5B8C5A',
  /** Ink on dark cards. */
  white: '#FFFFFF',
  /** Dark card gradient start (root card). */
  darkStart: '#1A1A1A',
  /** Dark card gradient end (root card). */
  darkEnd: '#2A2A2A',
  /** Muted tagline on the dark root card. */
  darkMuted: '#9A9A9A',
} as const;

/** Brand monospace display font, registered by {@link loadOgFonts}. Used for eyebrows and dominant titles. */
export const OG_FONT_MONO = 'IBM Plex Mono';

/** Brand sans body font, registered by {@link loadOgFonts}. Used for descriptions and the root hero. */
export const OG_FONT_SANS = 'IBM Plex Sans';
