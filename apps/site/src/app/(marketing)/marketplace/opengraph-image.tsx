import { ImageResponse } from 'next/og';
import { siteConfig } from '@/config/site';
import { OG_COLORS, OG_SIZE, OgDescription, OgEyebrow, OgTitle, loadOgFonts } from '@/lib/og';

export const alt = 'DorkOS Marketplace — Browse agents, skills, and extensions';
export const size = OG_SIZE;
export const contentType = 'image/png';

/**
 * Open Graph image for the marketplace browse page (`/marketplace`).
 *
 * Cream brand card built on the shared OG toolkit (real brand font, palette,
 * layout primitives). Mirrors the per-package card at
 * `apps/site/src/app/(marketing)/marketplace/[slug]/opengraph-image.tsx`.
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
      {OgEyebrow({ label: `${siteConfig.name} / Marketplace` })}
      {OgTitle({ children: 'Marketplace' })}
      {OgDescription({
        children: 'Browse agents, skills, commands, and extensions for DorkOS.',
      })}
    </div>,
    { ...size, fonts }
  );
}
