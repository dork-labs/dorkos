import { ImageResponse } from 'next/og';
import { features } from '@/layers/features/marketing';
import { siteConfig } from '@/config/site';

export const alt = 'DorkOS Feature';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

/**
 * Per-feature Open Graph image — statically generated at build time.
 */
export default async function Image(props: { params: Promise<{ slug: string }> }) {
  const params = await props.params;
  const feature = features.find((f) => f.slug === params.slug);

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
      <div style={{ fontSize: 16, color: '#9B8E7E', fontFamily: 'monospace', marginBottom: 24 }}>
        {siteConfig.name}
      </div>
      <div
        style={{
          fontSize: 56,
          fontWeight: 700,
          color: '#1A1714',
          fontFamily: 'monospace',
          lineHeight: 1.1,
        }}
      >
        {feature?.name ?? 'Feature'}
      </div>
      <div style={{ fontSize: 24, color: '#6B5E4E', marginTop: 20, maxWidth: 800 }}>
        {feature?.tagline}
      </div>
    </div>,
    size
  );
}
