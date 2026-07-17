import { ImageResponse } from 'next/og';
import { blog } from '@/lib/source';
import { releaseVersion } from '@/lib/blog-order';
import {
  OG_COLORS,
  OG_FONT_MONO,
  OG_SIZE,
  OgAccentStripes,
  OgChip,
  OgDescription,
  OgEyebrow,
  OgTitle,
  OgWordmark,
  loadOgFonts,
} from '@/lib/og';

export const size = OG_SIZE;
export const contentType = 'image/png';

/** Longest title we render at full size before trusting wrap/clamp to contain it. */
const TITLE_CLAMP = 90;

/** Format a post date as a short UTC label (frontmatter dates are UTC midnight). */
function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Per-post `alt` text so shared blog links describe the specific post.
 *
 * @param props - Route params carrying the post slug.
 */
export async function generateImageMetadata(props: { params: Promise<{ slug: string }> }) {
  const { slug } = await props.params;
  const page = blog.getPage([slug]);
  return [
    {
      id: 'default',
      alt: page?.data.title ?? 'DorkOS Blog',
      size: OG_SIZE,
      contentType: 'image/png',
    },
  ];
}

/**
 * Open Graph image for a blog post. Release posts lead with the version number
 * as the dominant element (a GitHub-release-card feel); other posts lead with
 * the title and a date chip. Built on the shared OG toolkit (real brand font,
 * cream palette, orange/green accents).
 */
export default async function Image(props: { params: Promise<{ slug: string }> }) {
  const { slug } = await props.params;
  const page = blog.getPage([slug]);
  const fonts = await loadOgFonts();

  const title = page?.data.title ?? 'DorkOS Blog';
  const date = page ? formatDate(new Date(page.data.date)) : null;
  const version = page ? releaseVersion(page.data.title, slug) : null;
  const isRelease = Boolean(version) || page?.data.category === 'release';

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
      {isRelease && version ? (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {OgEyebrow({ label: 'DorkOS Release' })}
          <div
            style={{
              fontSize: 150,
              fontWeight: 700,
              fontFamily: OG_FONT_MONO,
              color: OG_COLORS.charcoal,
              lineHeight: 1,
              letterSpacing: '-0.03em',
            }}
          >
            {version}
          </div>
          {OgDescription({ children: cappedTitle, maxWidth: 1000 })}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {OgEyebrow({ label: 'DorkOS Blog' })}
          {OgTitle({ children: cappedTitle, fontSize: 60, maxWidth: 1000 })}
          {date ? (
            <div style={{ display: 'flex', marginTop: 32 }}>{OgChip({ label: date })}</div>
          ) : null}
        </div>
      )}
      {OgWordmark()}
      {OgAccentStripes()}
    </div>,
    { ...size, fonts }
  );
}
