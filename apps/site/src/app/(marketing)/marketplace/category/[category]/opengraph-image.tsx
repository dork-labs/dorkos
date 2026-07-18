import { ImageResponse } from 'next/og';
import {
  CATEGORY_LABELS,
  MARKETPLACE_CATEGORIES,
  asMarketplaceCategory,
} from '@dorkos/marketplace';
import { siteConfig } from '@/config/site';
import { OG_COLORS, OG_SIZE, OgDescription, OgEyebrow, OgTitle, loadOgFonts } from '@/lib/og';

export const alt = 'DorkOS Marketplace category';
export const size = OG_SIZE;
export const contentType = 'image/png';

/**
 * One OG card per controlled category, prerendered alongside the category
 * landing pages so each `/marketplace/category/[slug]` route ships its own
 * share image with the category label.
 */
export function generateStaticParams() {
  return MARKETPLACE_CATEGORIES.map((category) => ({ category }));
}

/**
 * Open Graph image for a marketplace category page
 * (`/marketplace/category/[category]`).
 *
 * Cream brand card built on the shared OG toolkit — mirrors the browse-page
 * card at `apps/site/src/app/(marketing)/marketplace/opengraph-image.tsx`,
 * swapping the title for the category label.
 */
export default async function Image(props: { params: Promise<{ category: string }> }) {
  const { category: slug } = await props.params;
  const category = asMarketplaceCategory(slug);
  const label = category ? CATEGORY_LABELS[category] : 'Marketplace';
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
      {OgTitle({ children: label })}
      {OgDescription({ children: `Browse ${label} packages for DorkOS.` })}
    </div>,
    { ...size, fonts }
  );
}
