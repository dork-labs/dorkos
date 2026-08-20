// Generate the cockpit's PWA icons as PNG files from the desktop app's "D"
// glyph, so the web manifest and iOS home-screen link always match the mark
// DorkOS already ships everywhere else it needs an icon.
// Run with: npx tsx apps/client/scripts/generate-pwa-icons.ts
//
// Rasterized with `rsvg-convert` (`brew install librsvg`) rather than a new
// JS image dependency — the same tool apps/desktop/build/README.md already
// requires to regenerate icon.icns and icon.ico from this exact source SVG.
//
// One glyph, three canvases:
//
//   icon-192.png / icon-512.png   the desktop icon.svg rendered as-is (dark
//                                 rounded square, manifest purpose "any") —
//                                 already how the mark looks everywhere else
//                                 it appears.
//   maskable-icon-512.png         the same glyph on a full-bleed square with
//                                 no corner rounding baked in, and pulled in
//                                 a bit further from the edge — so Android's
//                                 own adaptive-icon mask (which can be a
//                                 circle) has room to crop without cutting
//                                 into the letterform (manifest purpose
//                                 "maskable").
//   apple-touch-icon.png          the same full-bleed square at 180px — iOS
//                                 rounds it into a squircle itself, and a
//                                 transparent corner behind that rounding
//                                 renders as a black smudge on older iOS, so
//                                 this one has to ship opaque edge-to-edge.

import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const currentDir = dirname(fileURLToPath(import.meta.url));
const desktopIconSvg = resolve(currentDir, '../../desktop/build/icon.svg');
const publicDir = resolve(currentDir, '../public');

/** The glyph's fill color and canvas background, both taken from the desktop icon.svg. */
const CHARCOAL = '#1A1A1A';
const WHITE = '#FFFFFF';

/**
 * Pulls the "D" glyph's `<path d="…">` out of the desktop app icon, so the
 * full-bleed variant below draws the identical letterform — one glyph, never
 * copied by hand into a second file that could drift from the first.
 *
 * @param svg - The source `icon.svg` contents.
 */
function extractGlyphPath(svg: string): string {
  const match = svg.match(/<path d="([^"]+)"/);
  if (!match?.[1]) {
    throw new Error(`Could not find the glyph path in ${desktopIconSvg}`);
  }
  return match[1];
}

/**
 * A full-bleed 1024×1024 square: the glyph on a solid background with no
 * corner rounding baked in, at a caller-chosen scale so the maskable variant
 * can sit further from the edge than the apple-touch-icon needs to.
 *
 * @param glyphPath - The "D" glyph's SVG path data.
 * @param scale - How large the glyph renders relative to its own 400×400 box.
 */
function flatSquareSvg(glyphPath: string, scale: number): string {
  const glyphSize = 400 * scale;
  const inset = (1024 - glyphSize) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" fill="none">
  <rect width="1024" height="1024" fill="${CHARCOAL}"/>
  <g transform="translate(${inset}, ${inset}) scale(${scale})">
    <path d="${glyphPath}" fill="${WHITE}"/>
  </g>
</svg>`;
}

/** One PNG this script produces, and where its SVG source comes from. */
interface IconTarget {
  file: string;
  size: number;
  svg: string;
}

const desktopSvgContent = readFileSync(desktopIconSvg, 'utf-8');
const glyphPath = extractGlyphPath(desktopSvgContent);

// Same scale (1.5, centered) as the desktop icon itself — the apple-touch
// variant only needs the corners filled in, not extra margin.
const APPLE_TOUCH_SVG = flatSquareSvg(glyphPath, 1.5);
// A smaller scale (1.2) keeps every corner of the glyph's bounding box
// inside Android's ~80%-diameter maskable safe zone, with room to spare.
const MASKABLE_SVG = flatSquareSvg(glyphPath, 1.2);

const TARGETS: IconTarget[] = [
  { file: 'icon-192.png', size: 192, svg: desktopIconSvg },
  { file: 'icon-512.png', size: 512, svg: desktopIconSvg },
  { file: 'maskable-icon-512.png', size: 512, svg: MASKABLE_SVG },
  { file: 'apple-touch-icon.png', size: 180, svg: APPLE_TOUCH_SVG },
];

/**
 * Runs `rsvg-convert`, turning a missing binary into a message that names
 * the fix (`brew install librsvg`) instead of a raw `ENOENT` stack trace —
 * the only failure mode this script can't do anything about itself.
 *
 * @param args - Arguments to pass to `rsvg-convert`.
 * @param input - SVG piped over stdin, when the source isn't a file on disk.
 */
function runRsvgConvert(args: string[], input: string | undefined): void {
  try {
    execFileSync('rsvg-convert', args, { input });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new Error(
        'rsvg-convert was not found on PATH. Install it with `brew install librsvg` ' +
          "(macOS) or your package manager's librsvg/rsvg-convert package, then re-run " +
          'this script.',
        { cause: error }
      );
    }
    throw error;
  }
}

for (const target of TARGETS) {
  const outputPath = resolve(publicDir, target.file);
  const args = ['-w', String(target.size), '-h', String(target.size), '-o', outputPath];
  const isFilePath = target.svg === desktopIconSvg;
  runRsvgConvert(isFilePath ? [...args, target.svg] : args, isFilePath ? undefined : target.svg);
  console.log(`Generated ${target.file}: ${outputPath} (${target.size}x${target.size})`);
}
