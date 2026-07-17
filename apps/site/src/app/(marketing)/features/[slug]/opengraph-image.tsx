import { ImageResponse } from 'next/og';
import { features } from '@/layers/features/marketing';
import { siteConfig } from '@/config/site';
import { OG_COLORS, OG_SIZE, OgDescription, OgEyebrow, OgTitle, loadOgFonts } from '@/lib/og';

export const size = OG_SIZE;
export const contentType = 'image/png';

/**
 * Per-feature `alt` text so shared links describe the specific feature rather
 * than a generic "DorkOS Feature". Falls back to the generic label only when the
 * slug doesn't resolve.
 *
 * @param props - Route params carrying the feature slug.
 */
export async function generateImageMetadata(props: { params: Promise<{ slug: string }> }) {
  const { slug } = await props.params;
  const feature = features.find((f) => f.slug === slug);
  return [
    {
      id: 'default',
      alt: feature ? `${feature.name} — DorkOS` : 'DorkOS Feature',
      size: OG_SIZE,
      contentType: 'image/png',
    },
  ];
}

/**
 * Per-feature Open Graph image — statically generated at build time on the
 * shared OG toolkit (real brand font, palette, layout primitives).
 */
export default async function Image(props: { params: Promise<{ slug: string }> }) {
  const params = await props.params;
  const feature = features.find((f) => f.slug === params.slug);
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
      {OgEyebrow({ label: siteConfig.name })}
      {OgTitle({ children: feature?.name ?? 'Feature', fontSize: 56 })}
      {feature?.tagline ? OgDescription({ children: feature.tagline, maxWidth: 800 }) : null}
    </div>,
    { ...size, fonts }
  );
}
