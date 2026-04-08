import { ImageResponse } from 'next/og';
import { siteConfig } from '@/config/site';

export const runtime = 'edge';

export const alt = 'DorkOS Marketplace — Browse agents, skills, and extensions';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

/**
 * Open Graph image for the marketplace browse page (`/marketplace`).
 *
 * Static card mirroring the per-feature OG style at
 * `apps/site/src/app/(marketing)/features/[slug]/opengraph-image.tsx`.
 */
export default async function Image() {
  return new ImageResponse(
    <div
      style={{
        background: '#F5F0E8',
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        padding: '80px',
      }}
    >
      <div
        style={{
          fontSize: 16,
          color: '#9B8E7E',
          fontFamily: 'monospace',
          marginBottom: 24,
        }}
      >
        {siteConfig.name} / Marketplace
      </div>
      <div
        style={{
          fontSize: 72,
          fontWeight: 700,
          color: '#1A1714',
          fontFamily: 'monospace',
          lineHeight: 1.05,
        }}
      >
        Dork Hub
      </div>
      <div
        style={{
          fontSize: 28,
          color: '#6B5E4E',
          marginTop: 24,
          maxWidth: 900,
          lineHeight: 1.3,
        }}
      >
        Browse agents, skills, commands, and extensions for DorkOS.
      </div>
    </div>,
    size
  );
}
