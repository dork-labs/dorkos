import { ImageResponse } from 'next/og';
import { siteConfig } from '@/config/site';
import { fetchMarketplaceJson } from '@/layers/features/marketplace';
import type { MarketplaceJsonEntry } from '@dorkos/marketplace';

export const runtime = 'edge';

export const alt = 'DorkOS Marketplace package';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

/**
 * Per-package Open Graph image — statically generated at build time and
 * refreshed via ISR. Mirrors the per-feature OG style at
 * `apps/site/src/app/(marketing)/features/[slug]/opengraph-image.tsx`.
 *
 * The registry fetch is wrapped in try/catch — if the package cannot be
 * resolved (registry unreachable, slug missing) we render a generic
 * "Not found" card instead of throwing, so OG generation never breaks.
 */
export default async function Image(props: { params: Promise<{ slug: string }> }) {
  const { slug } = await props.params;

  let pkg: MarketplaceJsonEntry | undefined;
  try {
    const marketplace = await fetchMarketplaceJson();
    pkg = marketplace.plugins.find((p) => p.name === slug);
  } catch {
    pkg = undefined;
  }

  const icon = pkg?.icon ?? '📦';
  const title = pkg?.name ?? 'Package not found';
  const description = pkg
    ? (pkg.description ?? 'A DorkOS marketplace package')
    : 'This package could not be located in the marketplace registry.';

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
          display: 'flex',
          alignItems: 'center',
          gap: 24,
        }}
      >
        <div
          style={{
            fontSize: 88,
            lineHeight: 1,
          }}
        >
          {icon}
        </div>
        <div
          style={{
            fontSize: 64,
            fontWeight: 700,
            color: '#1A1714',
            fontFamily: 'monospace',
            lineHeight: 1.1,
          }}
        >
          {title}
        </div>
      </div>
      <div
        style={{
          fontSize: 26,
          color: '#6B5E4E',
          marginTop: 24,
          maxWidth: 1000,
          lineHeight: 1.35,
          display: '-webkit-box',
          WebkitLineClamp: 3,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}
      >
        {description}
      </div>
    </div>,
    size
  );
}
