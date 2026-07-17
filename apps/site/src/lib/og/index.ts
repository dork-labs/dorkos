/**
 * @module lib/og
 *
 * Shared toolkit for `ImageResponse` Open Graph routes: the brand palette and
 * canvas size, the bundled brand-font loader, and reusable layout primitives.
 * OG routes compose these instead of repeating hex codes, font wiring, and
 * layout boilerplate.
 */
export { OG_SIZE, OG_COLORS, OG_FONT_MONO, OG_FONT_SANS } from './palette';
export { loadOgFonts, type OgFont } from './fonts';
export {
  OgEyebrow,
  OgTitle,
  OgDescription,
  OgChip,
  OgWordmark,
  OgAccentStripes,
} from './primitives';
