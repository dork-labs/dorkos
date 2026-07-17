/**
 * @module lib/og/primitives
 *
 * Reusable layout pieces for `ImageResponse` Open Graph cards: an eyebrow label,
 * a dominant title, a body description, a small metadata chip, a corner-anchored
 * wordmark, and the bottom accent stripes. These are plain element builders
 * (not React components with hooks) because satori renders a static tree; each
 * returns inline-styled elements that OG routes compose. Keeping them here means
 * new OG routes compose the brand identity instead of copy-pasting hex + font.
 */
import type { CSSProperties, ReactElement } from 'react';
import { OG_COLORS, OG_FONT_MONO, OG_FONT_SANS } from './palette';

/** Default bottom stripe thickness, in px. */
const STRIPE_THICKNESS = 8;

/**
 * Small monospace eyebrow label above a title (e.g. "DorkOS / Marketplace").
 *
 * @param label - The eyebrow text.
 * @param color - Text color; defaults to the muted warm gray.
 */
export function OgEyebrow({
  label,
  color = OG_COLORS.warmGrayLight,
}: {
  label: string;
  color?: string;
}): ReactElement {
  return (
    <div
      style={{
        fontSize: 18,
        color,
        fontFamily: OG_FONT_MONO,
        letterSpacing: '0.06em',
        marginBottom: 24,
      }}
    >
      {label}
    </div>
  );
}

/**
 * Dominant monospace title — the visual anchor of a card.
 *
 * @param children - Title text.
 * @param fontSize - Font size in px; defaults to 72.
 * @param color - Text color; defaults to charcoal.
 * @param maxWidth - Optional max width in px so long titles wrap.
 */
export function OgTitle({
  children,
  fontSize = 72,
  color = OG_COLORS.charcoal,
  maxWidth,
}: {
  children: string;
  fontSize?: number;
  color?: string;
  maxWidth?: number;
}): ReactElement {
  return (
    <div
      style={{
        fontSize,
        fontWeight: 700,
        color,
        fontFamily: OG_FONT_MONO,
        lineHeight: 1.05,
        letterSpacing: '-0.02em',
        ...(maxWidth ? { maxWidth } : {}),
      }}
    >
      {children}
    </div>
  );
}

/**
 * Body description in the brand sans, optionally clamped to a line count.
 *
 * @param children - Description text.
 * @param clamp - Optional max line count before truncating with an ellipsis.
 * @param maxWidth - Max width in px; defaults to 900.
 */
export function OgDescription({
  children,
  clamp,
  maxWidth = 900,
}: {
  children: string;
  clamp?: number;
  maxWidth?: number;
}): ReactElement {
  const clampStyle: CSSProperties = clamp
    ? {
        display: '-webkit-box',
        WebkitLineClamp: clamp,
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
      }
    : { display: 'flex' };
  return (
    <div
      style={{
        fontSize: 28,
        color: OG_COLORS.warmGray,
        fontFamily: OG_FONT_SANS,
        marginTop: 24,
        maxWidth,
        lineHeight: 1.35,
        ...clampStyle,
      }}
    >
      {children}
    </div>
  );
}

/**
 * Small rounded metadata chip (e.g. a post date).
 *
 * @param label - Chip text.
 */
export function OgChip({ label }: { label: string }): ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        alignSelf: 'flex-start',
        fontSize: 20,
        fontFamily: OG_FONT_MONO,
        color: OG_COLORS.warmGray,
        background: 'rgba(107, 94, 78, 0.1)',
        padding: '8px 18px',
        borderRadius: 999,
      }}
    >
      {label}
    </div>
  );
}

/**
 * Corner-anchored "DorkOS" wordmark, absolutely positioned bottom-right.
 *
 * @param color - Text color; defaults to charcoal.
 */
export function OgWordmark({ color = OG_COLORS.charcoal }: { color?: string } = {}): ReactElement {
  return (
    <div
      style={{
        position: 'absolute',
        bottom: 44,
        right: 64,
        fontSize: 26,
        fontWeight: 700,
        fontFamily: OG_FONT_MONO,
        color,
        letterSpacing: '-0.02em',
      }}
    >
      DorkOS
    </div>
  );
}

/**
 * Bottom brand accent stripes (orange over green), absolutely positioned.
 *
 * @param thickness - Height of each stripe in px; defaults to 8.
 */
export function OgAccentStripes({
  thickness = STRIPE_THICKNESS,
}: {
  thickness?: number;
} = {}): ReactElement {
  return (
    <div
      style={{
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{ height: thickness, background: OG_COLORS.brandOrange }} />
      <div style={{ height: thickness, background: OG_COLORS.brandGreen }} />
    </div>
  );
}
