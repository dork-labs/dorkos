import fs from 'fs/promises';
import path from 'path';
import { existsSync } from 'fs';
import { execFileSync } from 'child_process';
import os from 'os';
import sharp from 'sharp';
import { OUTPUT_DIR } from './config.js';

/**
 * Asset post-processing and the manifest contract. Stills are recompressed with
 * a palette-quantized PNG encoder (crisp for UI, a fraction of the raw size);
 * loops are size-checked and, when a bundled/system ffmpeg is available,
 * re-encoded to stay within budget. The written `manifest.json` is the contract
 * the marketing-site agent consumes.
 *
 * @module capture/optimize
 */

/** One captured asset described for downstream consumers. */
export interface AssetEntry {
  /** File name relative to the product dir (e.g. `cockpit-light.png`). */
  file: string;
  /** Logical surface captured (e.g. `cockpit`). */
  surface: string;
  /** Theme variant, or `null` for theme-agnostic assets. */
  theme: 'light' | 'dark' | null;
  /** Still image or video loop. */
  kind: 'still' | 'loop';
  /** Pixel width of the asset. */
  width: number;
  /** Pixel height of the asset. */
  height: number;
  /** Byte size after optimization. */
  bytes: number;
  /** Loop duration in milliseconds (loops only). */
  durationMs?: number;
}

/** Loops must stay at or under this size. */
const MAX_LOOP_BYTES = 1_500_000;

/** Locate a usable ffmpeg: the Playwright-bundled build, then a system install. */
function findFfmpeg(): string | null {
  const cacheRoot = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  if (existsSync(cacheRoot)) {
    for (const dir of ['ffmpeg-1011', 'ffmpeg-1010', 'ffmpeg-1009']) {
      const candidate = path.join(cacheRoot, dir, 'ffmpeg-mac');
      if (existsSync(candidate)) return candidate;
    }
  }
  for (const candidate of [
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Recompress a raw PNG buffer into the product dir and return its entry.
 * Palette quantization keeps text and flat UI crisp while cutting size sharply.
 */
export async function writeStill(
  buffer: Buffer,
  surface: string,
  theme: 'light' | 'dark',
  kind: 'still' | 'loop' = 'still'
): Promise<AssetEntry> {
  const file = `${surface}-${theme}.png`;
  const optimized = await sharp(buffer)
    .png({ palette: true, quality: 100, effort: 10, compressionLevel: 9 })
    .toBuffer();
  const meta = await sharp(optimized).metadata();
  await fs.writeFile(path.join(OUTPUT_DIR, file), optimized);
  return {
    file,
    surface,
    theme,
    kind,
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    bytes: optimized.length,
  };
}

/**
 * Move a recorded webm into the product dir under a stable name, re-encoding to
 * fit the loop budget when ffmpeg is available. Returns the asset entry.
 */
export async function writeLoop(
  sourcePath: string,
  surface: string,
  theme: 'light' | 'dark',
  width: number,
  height: number,
  durationMs: number
): Promise<AssetEntry> {
  const file = `${surface}-${theme}.webm`;
  const dest = path.join(OUTPUT_DIR, file);
  await fs.copyFile(sourcePath, dest);

  let bytes = (await fs.stat(dest)).size;
  if (bytes > MAX_LOOP_BYTES) {
    const ffmpeg = findFfmpeg();
    if (ffmpeg) {
      const tmp = `${dest}.tmp.webm`;
      // VP9, constrained quality + capped width; deadline good for size.
      execFileSync(ffmpeg, [
        '-y',
        '-i',
        dest,
        '-c:v',
        'libvpx-vp9',
        '-b:v',
        '0',
        '-crf',
        '38',
        '-vf',
        'scale=1120:-2',
        '-an',
        tmp,
      ]);
      await fs.rename(tmp, dest);
      bytes = (await fs.stat(dest)).size;
    }
  }
  return { file, surface, theme, kind: 'loop', width, height, bytes, durationMs };
}

/** Write the manifest describing every captured asset. */
export async function writeManifest(assets: AssetEntry[]): Promise<void> {
  const totalBytes = assets.reduce((sum, a) => sum + a.bytes, 0);
  const manifest = {
    generatedAt: new Date().toISOString(),
    note: 'Real DorkOS UI rendering seeded demo data. Regenerate with `pnpm --filter @dorkos/e2e capture`.',
    totalBytes,
    count: assets.length,
    assets: assets.sort((a, b) => a.file.localeCompare(b.file)),
  };
  await fs.writeFile(
    path.join(OUTPUT_DIR, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
}

/** Ensure the output dir exists and is empty of previously generated assets. */
export async function resetOutputDir(): Promise<void> {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  for (const entry of await fs.readdir(OUTPUT_DIR)) {
    if (entry.endsWith('.png') || entry.endsWith('.webm') || entry === 'manifest.json') {
      await fs.rm(path.join(OUTPUT_DIR, entry));
    }
  }
}
