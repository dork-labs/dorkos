import { ImageResponse } from 'next/og';
import {
  OG_COLORS,
  OG_FONT_MONO,
  OG_SIZE,
  OgAccentStripes,
  OgEyebrow,
  OgTitle,
  OgWordmark,
  loadOgFonts,
} from '@/lib/og';

export const alt = 'Install DorkOS: Mac app, one-line terminal install, npm, and the Windows alpha';
export const size = OG_SIZE;
export const contentType = 'image/png';

/** A platform install badge; `tag` is a small honesty label (e.g. "alpha"). */
interface PlatformBadge {
  label: string;
  tag?: string;
}

/**
 * The install paths shown as badges. Windows carries an "alpha" tag: the demo
 * claim gate forbids overstating the Windows desktop maturity.
 */
const PLATFORMS: PlatformBadge[] = [
  { label: 'macOS' },
  { label: 'npm / CLI' },
  { label: 'Windows', tag: 'alpha' },
];

/** Render one platform badge as a plain styled element (satori has no hooks). */
function badge({ label, tag }: PlatformBadge) {
  return (
    <div
      key={label}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        fontSize: 30,
        fontFamily: OG_FONT_MONO,
        fontWeight: 700,
        color: OG_COLORS.charcoal,
        background: 'rgba(107, 94, 78, 0.1)',
        border: `2px solid ${OG_COLORS.brandOrange}`,
        padding: '16px 28px',
        borderRadius: 16,
      }}
    >
      {label}
      {tag ? (
        <div
          style={{
            display: 'flex',
            fontSize: 18,
            fontWeight: 400,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: OG_COLORS.white,
            background: OG_COLORS.brandOrange,
            padding: '4px 12px',
            borderRadius: 8,
          }}
        >
          {tag}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Open Graph image for the install page (`/install`). A cream brand card with
 * platform badges (macOS, npm/CLI, Windows-alpha) built on the shared OG
 * toolkit, so shared install links preview the ways to get DorkOS.
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
        position: 'relative',
      }}
    >
      {OgEyebrow({ label: 'Get started' })}
      {OgTitle({ children: 'Install DorkOS' })}
      <div style={{ display: 'flex', gap: 20, marginTop: 44 }}>
        {PLATFORMS.map((platform) => badge(platform))}
      </div>
      {OgWordmark()}
      {OgAccentStripes()}
    </div>,
    { ...size, fonts }
  );
}
