import { ImageResponse } from 'next/og';
import { comparisons, COMPARISON_FRAMING_COPY } from '@/layers/features/marketing';
import { siteConfig } from '@/config/site';
import {
  OG_COLORS,
  OG_SIZE,
  OgAccentStripes,
  OgDescription,
  OgEyebrow,
  OgTitle,
  loadOgFonts,
} from '@/lib/og';

export const size = OG_SIZE;
export const contentType = 'image/png';

/**
 * Per-comparison `alt` text, so a shared link says which two products the card
 * is about. Falls back to a generic label only when the slug doesn't resolve.
 *
 * @param props - Route params carrying the comparison slug.
 */
export async function generateImageMetadata(props: { params: Promise<{ slug: string }> }) {
  const { slug } = await props.params;
  const competitor = comparisons.find((c) => c.slug === slug);
  const headline = competitor
    ? COMPARISON_FRAMING_COPY[competitor.framing].headline(competitor.name)
    : 'DorkOS comparison';
  return [
    {
      id: 'default',
      alt: `${headline} — DorkOS`,
      size: OG_SIZE,
      contentType: 'image/png',
    },
  ];
}

/**
 * Per-comparison Open Graph card, built at build time on the shared OG toolkit.
 * The lockup is set in the brand type — no other company's logo art ships here.
 */
export default async function Image(props: { params: Promise<{ slug: string }> }) {
  const params = await props.params;
  const competitor = comparisons.find((c) => c.slug === params.slug);
  const fonts = await loadOgFonts();
  const headline = competitor
    ? COMPARISON_FRAMING_COPY[competitor.framing].headline(competitor.name)
    : 'Compare';

  return new ImageResponse(
    <div
      style={{
        background: OG_COLORS.cream,
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        padding: '80px',
      }}
    >
      {OgEyebrow({ label: `${siteConfig.name} / Compare` })}
      {OgTitle({ children: headline, fontSize: 64, maxWidth: 900 })}
      {competitor
        ? OgDescription({ children: competitor.oneLiner, maxWidth: 860, clamp: 3 })
        : null}
      {OgAccentStripes({})}
    </div>,
    { ...size, fonts }
  );
}
