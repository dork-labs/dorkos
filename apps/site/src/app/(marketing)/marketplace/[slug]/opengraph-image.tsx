import { ImageResponse } from 'next/og';
import { siteConfig } from '@/config/site';
import { fetchMarketplaceJson } from '@/layers/features/marketplace';
import type { MergedMarketplaceEntry } from '@dorkos/marketplace';
import { OG_COLORS, OG_FONT_MONO, OG_SIZE, OgDescription, OgEyebrow, loadOgFonts } from '@/lib/og';

export const alt = 'DorkOS Marketplace package';
export const size = OG_SIZE;
export const contentType = 'image/png';

/**
 * Per-package Open Graph image — statically generated at build time and
 * refreshed via ISR. Cream brand card on the shared OG toolkit; mirrors the
 * browse card at `apps/site/src/app/(marketing)/marketplace/opengraph-image.tsx`.
 *
 * The registry fetch is wrapped in try/catch — if the package cannot be
 * resolved (registry unreachable, slug missing) we render a generic
 * "Not found" card instead of throwing, so OG generation never breaks.
 */
export default async function Image(props: { params: Promise<{ slug: string }> }) {
  const { slug } = await props.params;
  const fonts = await loadOgFonts();

  let pkg: MergedMarketplaceEntry | undefined;
  try {
    const marketplace = await fetchMarketplaceJson();
    pkg = marketplace.plugins.find((p) => p.name === slug);
  } catch {
    pkg = undefined;
  }

  const icon = pkg?.dorkos?.icon ?? '📦';
  const title = pkg?.name ?? 'Package not found';
  const description = pkg
    ? (pkg.description ?? 'A DorkOS marketplace package')
    : 'This package could not be located in the marketplace registry.';

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
      <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
        <div style={{ fontSize: 88, lineHeight: 1 }}>{icon}</div>
        <div
          style={{
            fontSize: 64,
            fontWeight: 700,
            color: OG_COLORS.charcoal,
            fontFamily: OG_FONT_MONO,
            lineHeight: 1.1,
            letterSpacing: '-0.02em',
          }}
        >
          {title}
        </div>
      </div>
      {OgDescription({ children: description, clamp: 3, maxWidth: 1000 })}
    </div>,
    { ...size, fonts }
  );
}
