import { ImageResponse } from 'next/og';
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

export const alt = 'DorkOS compared — honest comparisons with the tools you already run';
export const size = OG_SIZE;
export const contentType = 'image/png';

/**
 * Open Graph image for the comparison hub (`/compare`).
 *
 * Cream brand card built on the shared OG toolkit, matching the per-comparison
 * card at `apps/site/src/app/(marketing)/compare/[slug]/opengraph-image.tsx` so
 * the hub and its pages share one look when shared.
 */
export default async function Image() {
  const fonts = await loadOgFonts();
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
      {OgTitle({ children: 'DorkOS vs the field' })}
      {OgDescription({
        children:
          'Honest comparisons with the coding agents you already run, and the tools you might pick instead.',
      })}
      {OgAccentStripes({})}
    </div>,
    { ...size, fonts }
  );
}
