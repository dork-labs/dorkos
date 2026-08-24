import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_PKG = path.resolve(__dirname, '..');

/** The app icon, and the one place the "D" glyph is drawn. */
export const APP_ICON_SVG = path.join(DESKTOP_PKG, 'build', 'icon.svg');

/**
 * Geometry of the DMG installer window, in the 1x pixel space that is also
 * Finder's coordinate space for the volume.
 *
 * This is the single source of truth for two things that MUST agree: the art
 * generated here, and the `dmg.contents` / `dmg.iconSize` coordinates in
 * electron-builder.yml. If they drift, the arrow drawn into the background
 * points at empty space — a mistake that is invisible until someone opens a
 * shipped installer. `__tests__/generate-dmg-background.test.ts` reads the yml
 * and fails if the two ever disagree.
 *
 * 540x380 is the size Finder actually opens the window at: electron-builder
 * derives `window.size` from the background image's own pixel dimensions
 * (dmg-builder's `customizeDmg` runs `sips -g pixelWidth` on it) and ignores
 * `dmg.window` entirely whenever a background image is set — which is why that
 * key is deliberately absent from electron-builder.yml.
 *
 * `x`/`y` are icon CENTRES, which is what dmgbuild's `icon_locations` expects.
 *
 * `safeHeight` is the part of that 380 a user can actually SEE, and it is
 * smaller than the canvas. The DS_Store `WindowBounds` dmgbuild writes is the
 * window's OUTER frame, so Finder's ~28pt title bar already eats into the 380,
 * and each optional Finder bar takes another bite. dmgbuild writes
 * `ShowStatusBar: false`, but those are per-user Finder preferences and they
 * win: measured on a real mounted build with the status bar on, 320 of the 380
 * rows were visible and the rest sat under a scrollbar. A path bar as well
 * (~22pt more) is the tightest case worth designing for, hence 298.
 *
 * Anything below `safeHeight` is decoration nobody is guaranteed to see, so
 * nothing that carries meaning may go there. The same applies to
 * electron-builder's own stock template, which is 540x380 too.
 */
export const DMG_LAYOUT = {
  width: 540,
  height: 380,
  safeHeight: 298,
  iconSize: 100,
  iconCenterY: 205,
  appIconCenterX: 140,
  applicationsCenterX: 400,
} as const;

/** The one instruction line drawn under the arrow. */
export const DMG_INSTRUCTION = 'Drag DorkOS into Applications';

/** Where the committed artwork lives — `build/` is electron-builder's buildResources dir. */
export const DMG_BACKGROUND_TIFF = path.join(DESKTOP_PKG, 'build', 'dmg-background.tiff');

// Fixed intermediate names, not temp-unique ones: `tiffutil` records each
// input's filename in the output's ImageDescription tag, so unique names would
// make every regeneration produce a different TIFF and turn the committed
// binary into permanent diff noise.
const PNG_1X = 'dmg-background-1x.png';
const PNG_2X = 'dmg-background-2x.png';

// Near-white rather than pure white so the window reads as a surface the icons
// sit on, and so the drop shadow Finder draws under each icon has something to
// land on. Matches the neutral the product's own light surfaces use.
const BACKDROP = '#FAFAFA';
const INK = '#1A1A1A';
const HAIRLINE = '#B4B4B9';
const CAPTION = '#86868B';

// System-font stack first, then the concrete faces a non-Chromium renderer can
// resolve: librsvg has no notion of `-apple-system`, so without the Helvetica
// fallbacks the caption would render in a serif default.
const SANS =
  "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', Helvetica, Arial, sans-serif";

// Geometry lifted from build/icon.svg so the installer mark and the app icon
// are one drawing at two sizes: a 1024pt chip with a 180pt corner radius,
// holding a 400-unit "D" glyph inset 212pt and scaled 1.5x. Expressed as
// ratios of the chip so MARK_SIZE is the only number to change.
const ICON_CANVAS = 1024;
const ICON_CORNER_RADIUS = 180;
const GLYPH_INSET = 212;
const GLYPH_SCALE = 1.5;

const MARK_SIZE = 26;
const MARK_X = 28;
const MARK_Y = 26;
const WORDMARK_GAP = 9;
const WORDMARK_SIZE = 14;
// Cap height as a fraction of font size, for the Helvetica-class faces this
// stack resolves to.
const CAP_HEIGHT_RATIO = 0.72;

// Clear air on each side of an icon box before the arrow starts.
const ARROW_GAP = 16;
// The chevron's tip sits at the arrow's end; the shaft stops short of it so
// the round line cap doesn't blunt the point.
const ARROW_HEAD = 7;
const ARROW_HALF_HEIGHT = 5.5;
const ARROW_WIDTH = 2;

// Finder draws each icon's name below its box in a ~18px band; the caption has
// to clear that band, not just the icon.
const FINDER_LABEL_BAND = 18;
const CAPTION_GAP = 22;
const CAPTION_SIZE = 13;

/**
 * Pull the "D" glyph's `<path d="…">` out of the app icon.
 *
 * Read rather than copied: `build/README.md` makes `icon.svg` the glyph's
 * single source of truth, and `apps/client/scripts/generate-pwa-icons.ts` reads
 * it the same way for the same reason. A hand-copied path is a copy that goes
 * stale silently — and no test here could catch it, since a stale copy would
 * simply be what both the art and the assertion agree on.
 *
 * @param svg - The source `icon.svg` contents.
 */
export function extractGlyphPath(svg: string): string {
  const match = /<path d="([^"]+)"/.exec(svg);
  if (match === null) {
    throw new Error(`No <path d="…"> found in ${APP_ICON_SVG}`);
  }
  return match[1];
}

/**
 * Compose the installer background as an SVG string.
 *
 * Rasteriser-free so the layout can be asserted on every platform, including
 * the Linux CI runner that has no way to render it.
 */
export function buildDmgBackgroundSvg(): string {
  const { width, height, iconSize, iconCenterY, appIconCenterX, applicationsCenterX } = DMG_LAYOUT;
  const iconHalf = iconSize / 2;

  const arrowStartX = appIconCenterX + iconHalf + ARROW_GAP;
  const arrowEndX = applicationsCenterX - iconHalf - ARROW_GAP;
  // Where the chevron's two strokes begin, and where the shaft stops so its
  // round cap does not blunt the tip.
  const arrowHeadBackX = arrowEndX - ARROW_HEAD;

  const captionY = iconCenterY + iconHalf + FINDER_LABEL_BAND + CAPTION_GAP;

  const glyphPath = extractGlyphPath(readFileSync(APP_ICON_SVG, 'utf-8'));
  const markRadius = (MARK_SIZE * ICON_CORNER_RADIUS) / ICON_CANVAS;
  const glyphInset = (MARK_SIZE * GLYPH_INSET) / ICON_CANVAS;
  const glyphScale = (MARK_SIZE * GLYPH_SCALE) / ICON_CANVAS;
  const wordmarkX = MARK_X + MARK_SIZE + WORDMARK_GAP;
  // Optically centred against the chip: SVG places text by its baseline, so
  // drop half a cap-height below the chip's midline.
  const wordmarkY = MARK_Y + MARK_SIZE / 2 + (WORDMARK_SIZE * CAP_HEIGHT_RATIO) / 2;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="drag" x1="${arrowStartX}" y1="0" x2="${arrowEndX}" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${HAIRLINE}" stop-opacity="0"/>
      <stop offset="0.45" stop-color="${HAIRLINE}" stop-opacity="0.6"/>
      <stop offset="1" stop-color="${HAIRLINE}" stop-opacity="1"/>
    </linearGradient>
  </defs>

  <rect width="${width}" height="${height}" fill="${BACKDROP}"/>

  <g transform="translate(${MARK_X}, ${MARK_Y})">
    <rect width="${MARK_SIZE}" height="${MARK_SIZE}" rx="${markRadius}" fill="${INK}"/>
    <g transform="translate(${glyphInset}, ${glyphInset}) scale(${glyphScale})">
      <path d="${glyphPath}" fill="${BACKDROP}"/>
    </g>
  </g>
  <text x="${wordmarkX}" y="${wordmarkY}" font-family="${SANS}" font-size="${WORDMARK_SIZE}" font-weight="600" fill="${INK}">DorkOS</text>

  <path d="M${arrowStartX} ${iconCenterY} H${arrowHeadBackX}" fill="none" stroke="url(#drag)" stroke-width="${ARROW_WIDTH}" stroke-linecap="round"/>
  <path d="M${arrowHeadBackX} ${iconCenterY - ARROW_HALF_HEIGHT} L${arrowEndX} ${iconCenterY} L${arrowHeadBackX} ${iconCenterY + ARROW_HALF_HEIGHT}" fill="none" stroke="${HAIRLINE}" stroke-width="${ARROW_WIDTH}" stroke-linecap="round" stroke-linejoin="round"/>

  <text x="${width / 2}" y="${captionY}" text-anchor="middle" font-family="${SANS}" font-size="${CAPTION_SIZE}" fill="${CAPTION}">${DMG_INSTRUCTION}</text>
</svg>
`;
}

/**
 * Rasterise the background at 1x and 2x and combine the pair into the
 * multi-representation TIFF electron-builder hands to dmgbuild.
 *
 * macOS-only: `tiffutil` is the only tool that writes the HiDPI-paired TIFF
 * Finder needs, and it ships with macOS. That costs nothing, because a macOS
 * DMG can only be built on macOS anyway.
 *
 * `sharp` does the rasterising because it is the only option here that renders
 * an SVG at exact pixel dimensions. The macOS built-ins were both measured and
 * rejected: `sips` cannot read SVG at all, and `qlmanage -t -s 540` pads its
 * output to a 540x540 square rather than honouring the 540x380 viewBox.
 * `rsvg-convert` works but is a Homebrew install, not a repo dependency.
 * sharp is imported lazily so the layout above stays assertable without
 * loading a native image codec.
 *
 * @param options.outFile Absolute path for the combined TIFF.
 * @param options.workDir Directory for the two intermediate PNGs.
 */
export async function generateDmgBackground(options: {
  outFile: string;
  workDir: string;
}): Promise<{ png1x: string; png2x: string; tiff: string }> {
  const { outFile, workDir } = options;
  // Checked up front so a non-Mac gets one readable sentence rather than the
  // bare ENOENT that spawning a missing `tiffutil` would otherwise raise, a
  // dozen frames deep and naming nothing a reader could act on.
  if (process.platform !== 'darwin') {
    throw new Error(
      `Generating the DMG background requires macOS (tiffutil); this is ${process.platform}.`
    );
  }

  const { width, height } = DMG_LAYOUT;
  const svg = Buffer.from(buildDmgBackgroundSvg());

  const { default: sharp } = await import('sharp');

  // `density` makes librsvg rasterise the vectors at 2x natively rather than
  // upscaling a 1x bitmap; the explicit `resize` is a guard against a rounding
  // difference, since `tiffutil -cathidpicheck` rejects anything that is not
  // exactly double. `flatten` drops the alpha channel — a DMG background is
  // opaque by definition, and Finder composites it more predictably without one.
  const DEFAULT_DPI = 72;
  const renders: Array<{ file: string; scale: number }> = [
    { file: PNG_1X, scale: 1 },
    { file: PNG_2X, scale: 2 },
  ];
  for (const { file, scale } of renders) {
    await sharp(svg, { density: DEFAULT_DPI * scale })
      .resize(width * scale, height * scale)
      .flatten({ background: BACKDROP })
      .png({ compressionLevel: 9 })
      .toFile(path.join(workDir, file));
  }

  // Relative input names with `cwd: workDir` so the ImageDescription tags
  // record bare filenames instead of a machine-specific absolute path.
  execFileSync('tiffutil', ['-cathidpicheck', PNG_1X, PNG_2X, '-out', outFile], {
    cwd: workDir,
    stdio: 'pipe',
  });

  return { png1x: path.join(workDir, PNG_1X), png2x: path.join(workDir, PNG_2X), tiff: outFile };
}

/**
 * Regenerate the committed `build/dmg-background.tiff`.
 *
 * The TIFF is committed rather than generated during packaging so that a
 * release build needs no image toolchain, and so that a change to the art is
 * reviewable as a diff of this file.
 */
async function main(): Promise<void> {
  const workDir = mkdtempSync(path.join(tmpdir(), 'dorkos-dmg-bg-'));
  try {
    writeFileSync(path.join(workDir, 'dmg-background.svg'), buildDmgBackgroundSvg());
    await generateDmgBackground({ outFile: DMG_BACKGROUND_TIFF, workDir });
    console.log(`✓ Wrote ${path.relative(DESKTOP_PKG, DMG_BACKGROUND_TIFF)}`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

// Guarded: this module is imported by its own test, which must not regenerate
// the committed artwork as a side effect of loading it. Chained rather than
// top-level-awaited because this package is CJS, so tsx compiles these scripts
// to CommonJS, where a top-level `await` is a build error.
if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
