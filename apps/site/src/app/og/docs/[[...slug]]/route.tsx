import { ImageResponse } from 'next/og';
import { source } from '@/lib/source';
import { docsSectionTrail } from '@/lib/metadata';
import {
  OG_COLORS,
  OG_SIZE,
  OgAccentStripes,
  OgEyebrow,
  OgTitle,
  OgWordmark,
  loadOgFonts,
} from '@/lib/og';

// The docs page is an optional catch-all (`[[...slug]]`); Next forbids the child
// segment the file-based `opengraph-image` convention appends after it. So the
// per-page docs card is a route handler instead, referenced explicitly from the
// docs page's `openGraph.images`. Statically generated at build for every docs
// page (parity with the blog/marketplace/feature OG routes).
export const dynamic = 'force-static';

/** Longest title we render at full size before trusting wrap/clamp to contain it. */
const TITLE_CLAMP = 90;

/**
 * Prebuild one OG image per docs page (including the index) so cards are static
 * assets, not per-request renders. Mirrors the docs page's own params.
 */
export function generateStaticParams() {
  return source.generateParams();
}

/** The eyebrow + dominant title for a docs page's Open Graph card. */
interface DocsCard {
  /** Breadcrumb eyebrow, e.g. "Docs / Getting Started" (just "Docs" at the root). */
  eyebrow: string;
  /** The page title, rendered as the dominant element. */
  title: string;
}

/**
 * Resolve a docs page's OG eyebrow and title. Unknown slugs and the docs index
 * (empty slug) both fall back gracefully — the index takes its title from the
 * root page and shows a bare "Docs" eyebrow.
 *
 * @param slug - The catch-all docs slug segments (undefined at the index).
 */
function docsCard(slug: string[] | undefined): DocsCard {
  const page = source.getPage(slug);
  if (!page) return { eyebrow: 'Docs', title: 'DorkOS Documentation' };

  const sections = docsSectionTrail({ url: page.url, slugs: page.slugs }, source.pageTree);
  return {
    eyebrow: ['Docs', ...sections.map((section) => section.name)].join(' / '),
    title: page.data.title,
  };
}

/**
 * Open Graph image for a documentation page. Leads with a breadcrumb eyebrow
 * (the section path, so a zero-context recipient is oriented) and the page title
 * as the dominant element, over the shared brand card (real font, cream palette,
 * orange/green accent stripes, corner wordmark).
 *
 * @param _request - The incoming request (unused; the slug carries the page).
 * @param context - Route context carrying the catch-all docs slug.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ slug?: string[] }> }
): Promise<ImageResponse> {
  const { slug } = await context.params;
  const { eyebrow, title } = docsCard(slug);
  const fonts = await loadOgFonts();

  const cappedTitle =
    title.length > TITLE_CLAMP ? `${title.slice(0, TITLE_CLAMP).trimEnd()}…` : title;

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
        position: 'relative',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {OgEyebrow({ label: eyebrow })}
        {OgTitle({ children: cappedTitle, fontSize: 64, maxWidth: 1000 })}
      </div>
      {OgWordmark()}
      {OgAccentStripes()}
    </div>,
    { ...OG_SIZE, fonts }
  );
}
