import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  APP_ICON_SVG,
  DMG_BACKGROUND_TIFF,
  DMG_INSTRUCTION,
  DMG_LAYOUT,
  buildDmgBackgroundSvg,
  extractGlyphPath,
  generateDmgBackground,
} from '../generate-dmg-background';

const ELECTRON_BUILDER_YML = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../electron-builder.yml'
);

/** One entry of electron-builder's `dmg.contents`. */
interface DmgContent {
  x: number;
  y: number;
  type: string;
  path?: string;
}

/** The parsed `dmg:` block of electron-builder.yml. */
interface DmgConfig {
  background: string;
  iconSize: number;
  contents: DmgContent[];
}

/**
 * Parse the `dmg:` block of electron-builder.yml.
 *
 * Parsed, not substring-matched: a `toContain` check passes just as happily
 * when the key it is looking for has been commented out, or when the right
 * numbers are attached to the wrong subject.
 */
function readDmgConfig(): DmgConfig {
  const config = parseYaml(readFileSync(ELECTRON_BUILDER_YML, 'utf-8')) as { dmg?: DmgConfig };
  if (config.dmg === undefined) {
    throw new Error('electron-builder.yml has no top-level `dmg:` block');
  }
  return config.dmg;
}

/** Read a PNG's real pixel size off its IHDR chunk, rather than trusting the encoder's report. */
function readPngSize(file: string): { width: number; height: number } {
  const IHDR_WIDTH_OFFSET = 16;
  const buffer = readFileSync(file);
  return {
    width: buffer.readUInt32BE(IHDR_WIDTH_OFFSET),
    height: buffer.readUInt32BE(IHDR_WIDTH_OFFSET + 4),
  };
}

/** Every image representation inside a TIFF, in file order, via macOS `tiffutil`. */
function readTiffRepresentations(file: string): Array<{ width: number; height: number }> {
  const info = execFileSync('tiffutil', ['-info', file], { encoding: 'utf-8' });
  return [...info.matchAll(/Image Width: (\d+) Image Length: (\d+)/g)].map((match) => ({
    width: Number(match[1]),
    height: Number(match[2]),
  }));
}

/** Largest and smallest x coordinate appearing in an SVG path's `d` attribute. */
function xRange(pathData: string): { min: number; max: number } {
  const xs = [...pathData.matchAll(/[ML]\s*(-?[\d.]+)|H\s*(-?[\d.]+)/g)].map((match) =>
    Number(match[1] ?? match[2])
  );
  return { min: Math.min(...xs), max: Math.max(...xs) };
}

describe('buildDmgBackgroundSvg', () => {
  const svg = buildDmgBackgroundSvg();

  it('is drawn at the exact size Finder will open the volume window at', () => {
    // electron-builder derives the DMG window size from these pixel dimensions,
    // so they are load-bearing, not decorative.
    expect(svg).toContain(`width="${DMG_LAYOUT.width}" height="${DMG_LAYOUT.height}"`);
    expect(svg).toContain(`viewBox="0 0 ${DMG_LAYOUT.width} ${DMG_LAYOUT.height}"`);
  });

  it('keeps the arrow in the gap between the two icon boxes', () => {
    const paths = [...svg.matchAll(/<path d="(M[^"]+)"/g)].map((match) => match[1]);
    // The chip glyph is drawn in its own scaled coordinate system, so only the
    // two arrow paths — the ones written in window coordinates — are checked.
    const arrows = paths.filter((data) => data.includes(String(DMG_LAYOUT.iconCenterY)));
    expect(arrows).toHaveLength(2);

    const appIconRightEdge = DMG_LAYOUT.appIconCenterX + DMG_LAYOUT.iconSize / 2;
    const applicationsLeftEdge = DMG_LAYOUT.applicationsCenterX - DMG_LAYOUT.iconSize / 2;
    for (const arrow of arrows) {
      const { min, max } = xRange(arrow);
      expect(min).toBeGreaterThan(appIconRightEdge);
      expect(max).toBeLessThan(applicationsLeftEdge);
    }
  });

  it('sits the instruction below the icon labels but inside the visible area', () => {
    const caption = /<text[^>]*y="(\d+)"[^>]*>Drag/.exec(svg);
    expect(caption).not.toBeNull();
    const captionY = Number(caption?.[1]);
    const iconBottom = DMG_LAYOUT.iconCenterY + DMG_LAYOUT.iconSize / 2;
    expect(captionY).toBeGreaterThan(iconBottom);
    // Below `safeHeight` the caption disappears under Finder's chrome for any
    // user with the status bar switched on. See DMG_LAYOUT for the measurement.
    expect(captionY).toBeLessThan(DMG_LAYOUT.safeHeight);
  });

  it('keeps every icon inside the visible area', () => {
    const iconBottom = DMG_LAYOUT.iconCenterY + DMG_LAYOUT.iconSize / 2;
    expect(iconBottom).toBeLessThan(DMG_LAYOUT.safeHeight);
  });

  it('spells out the one thing the user has to do', () => {
    expect(svg).toContain(DMG_INSTRUCTION);
  });

  it('draws the same "D" the app icon does', () => {
    // Not a copy of the path data: the assertion reads icon.svg, so editing the
    // glyph there and forgetting to regenerate cannot leave the two agreeing.
    const glyph = extractGlyphPath(readFileSync(APP_ICON_SVG, 'utf-8'));
    expect(svg).toContain(`<path d="${glyph}"`);
  });
});

describe('generateDmgBackground on a platform without tiffutil', () => {
  it('says what it needs instead of failing to spawn', async () => {
    // Runs on every platform, including the Linux CI runner — which is the one
    // place this refusal actually matters.
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      await expect(
        generateDmgBackground({ outFile: 'unused.tiff', workDir: 'unused' })
      ).rejects.toThrow(/requires macOS \(tiffutil\); this is linux/);
    } finally {
      if (platform !== undefined) {
        Object.defineProperty(process, 'platform', platform);
      }
    }
  });
});

describe('extractGlyphPath', () => {
  it('refuses an icon with no glyph rather than drawing nothing', () => {
    expect(() => extractGlyphPath('<svg><rect width="10" height="10"/></svg>')).toThrow(/No <path/);
  });
});

describe('electron-builder.yml', () => {
  const dmg = readDmgConfig();

  it('points the dmg target at the committed artwork', () => {
    expect(dmg.background).toBe(path.posix.join('build', path.basename(DMG_BACKGROUND_TIFF)));
  });

  it('sizes the icons the artwork was laid out around', () => {
    expect(dmg.iconSize).toBe(DMG_LAYOUT.iconSize);
  });

  it('drops the app on the left and the Applications link on the right', () => {
    // Each coordinate pair is asserted together with the subject it belongs to.
    // The background art draws an arrow FROM the app icon TO the drop target,
    // so swapping the two `type`s would reverse the drag the picture teaches
    // while leaving every individual number correct.
    expect(dmg.contents).toEqual([
      { x: DMG_LAYOUT.appIconCenterX, y: DMG_LAYOUT.iconCenterY, type: 'file' },
      {
        x: DMG_LAYOUT.applicationsCenterX,
        y: DMG_LAYOUT.iconCenterY,
        type: 'link',
        path: '/Applications',
      },
    ]);
  });
});

// macOS only: `tiffutil` is the tool that writes the HiDPI-paired TIFF, and it
// ships with macOS alone. The CI `test` job runs on Linux, so this block never
// runs there — it is a local gate, which is proportionate, since a macOS DMG
// can only be built on macOS in the first place.
describe.skipIf(process.platform !== 'darwin')('generateDmgBackground', () => {
  let workDir: string;
  let result: { png1x: string; png2x: string; tiff: string };

  beforeAll(async () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'dorkos-dmg-bg-test-'));
    result = await generateDmgBackground({
      outFile: path.join(workDir, 'dmg-background.tiff'),
      workDir,
    });
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('rasterises both a 1x and a 2x sheet', () => {
    expect(readPngSize(result.png1x)).toEqual({
      width: DMG_LAYOUT.width,
      height: DMG_LAYOUT.height,
    });
    expect(readPngSize(result.png2x)).toEqual({
      width: DMG_LAYOUT.width * 2,
      height: DMG_LAYOUT.height * 2,
    });
  });

  it('combines them into one TIFF holding both representations', () => {
    expect(readTiffRepresentations(result.tiff)).toEqual([
      { width: DMG_LAYOUT.width, height: DMG_LAYOUT.height },
      { width: DMG_LAYOUT.width * 2, height: DMG_LAYOUT.height * 2 },
    ]);
  });

  it('reproduces the committed artwork byte for byte', () => {
    // The generator is deterministic (fixed intermediate filenames, so
    // `tiffutil` stamps no varying metadata). A mismatch means either the
    // committed TIFF is stale — rerun
    // `pnpm --filter @dorkos/desktop exec tsx scripts/generate-dmg-background.ts`
    // — or the rendering stack changed, which silently changes the art every
    // Mac user sees on install and is worth a look either way.
    expect(readFileSync(result.tiff)).toEqual(readFileSync(DMG_BACKGROUND_TIFF));
  });
});
