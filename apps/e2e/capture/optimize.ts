import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';
import sharp from 'sharp';
import { OUTPUT_DIR } from './config.js';

/**
 * Asset post-processing and the manifest contract. Stills are recompressed with
 * a palette-quantized PNG encoder (crisp for UI, a fraction of the raw size).
 * Loops run the full editing stage: head-trim to the action, a short tail→head
 * crossfade so the restart is seamless, a two-pass VP9 encode inside the size
 * budget, and a poster extracted from the loop's own first post-trim frame (so
 * the poster→video handoff is invisible). The written `manifest.json` is the
 * contract the marketing-site agent consumes.
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

/**
 * Two-pass VP9 targets this size (comfortably under {@link MAX_LOOP_BYTES}). Two
 * pass average-bitrate encoding lands within a few percent of the target
 * regardless of scene complexity, which single-pass CRF cannot guarantee — the
 * reason we encode twice rather than pick a CRF and hope.
 */
const TARGET_LOOP_BYTES = 1_350_000;

/** Tail→head crossfade length. Long enough to hide the seam, short enough to feel instant. */
const CROSSFADE_SEC = 0.3;

/**
 * A loop must have at least this much footage after head-trim to be worth a
 * crossfade; below it we ship the trimmed clip straight (a crossfade would eat
 * most of the content).
 */
const MIN_CROSSFADE_ELIGIBLE_SEC = 1.2;

/** The smallest output we will ever produce, so head-trim can never over-cut. */
const MIN_OUTPUT_SEC = 1.0;

/**
 * Constant frame rate every loop is normalized to before editing. Playwright
 * recordings are variable-frame-rate (frames land only on repaint), so a 300ms
 * `trim` window can contain a single, barely-faded frame — normalizing first
 * makes the seam's trim/fade math frame-accurate and deterministic.
 */
const LOOP_FPS = 25;

/** Resolve the bundled ffmpeg binary; post-processing is mandatory, so its absence is fatal. */
function resolveFfmpeg(): string {
  if (!ffmpegStatic) {
    throw new Error('ffmpeg-static did not resolve a binary — cannot post-process loops');
  }
  return ffmpegStatic;
}

/** Clamp `value` into the inclusive `[min, max]` range. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Read a media file's duration in seconds by parsing ffmpeg's own probe output
 * (`ffmpeg -i` prints `Duration:` to stderr and exits non-zero with no output).
 * Avoids a separate ffprobe dependency — the bundled ffmpeg is enough.
 */
function probeDurationSec(ffmpeg: string, file: string): number {
  let stderr = '';
  try {
    execFileSync(ffmpeg, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? '';
  }
  const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) throw new Error(`could not probe duration of ${file}`);
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

/**
 * Recompress a raw PNG buffer with palette quantization — crisp text and flat
 * UI at a fraction of the raw size. Shared by stills and loop posters.
 */
async function optimizePng(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer)
    .png({ palette: true, quality: 100, effort: 10, compressionLevel: 9 })
    .toBuffer();
}

/**
 * Recompress a raw PNG screenshot into the product dir and return its entry.
 */
export async function writeStill(
  buffer: Buffer,
  surface: string,
  theme: 'light' | 'dark',
  kind: 'still' | 'loop' = 'still'
): Promise<AssetEntry> {
  const file = `${surface}-${theme}.png`;
  const optimized = await optimizePng(buffer);
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

/** Everything writeLoop needs to edit, encode, and poster one recording. */
export interface WriteLoopOptions {
  /** Path of the raw Playwright recording. */
  sourcePath: string;
  /** Logical surface name (files become `<surface>-dark.webm` + `<surface>-dark.png`). */
  surface: string;
  /** Target width (loops are normalized to a consistent size). */
  width: number;
  /** Target height. */
  height: number;
  /**
   * Milliseconds of head footage to cut — the navigation/loading ramp before
   * the loop's action begins (recorded by the capture harness). Everything from
   * here on is the money content.
   */
  headTrimMs: number;
}

/** The filtergraph inputs for one loop's edit. */
interface LoopFilterSpec {
  width: number;
  height: number;
  headTrimSec: number;
  /** Output duration (trimmed length minus the crossfade). */
  bodyEndSec: number;
  /** Crossfade length, or 0 to skip. */
  crossfadeSec: number;
}

/**
 * Build the ffmpeg filtergraph that head-trims, normalizes size and frame rate,
 * and (when eligible) crossfades the tail back over the head for a seamless loop.
 *
 * The crossfade keeps a fully-opaque body as the base and dissolves the trailing
 * `crossfadeSec` (faded out via alpha) over the body's head. Because the base
 * never goes transparent, the blend never passes through black, and the last
 * output frame matches the first — the restart is invisible.
 *
 * The overlay is confined to the seam with `enable='between(t,0,crossfade)'`
 * and `eof_action=pass`. Without both, overlay's default `eof_action=repeat`
 * keeps compositing the tail's last frame over the ENTIRE body after the
 * 300ms tail stream ends — full-duration ghosting (double-exposed text). The
 * VFR source made it worse: the tail window could hold a single frame whose
 * fade-out alpha was still ≈1, hence the up-front `fps` normalization too.
 */
function buildLoopFilter(spec: LoopFilterSpec): string {
  const { width, height, headTrimSec, bodyEndSec, crossfadeSec } = spec;
  const normalize = `scale=${width}:${height}:flags=lanczos,setsar=1,fps=${LOOP_FPS}`;
  const trimmed = `[0:v]trim=start=${headTrimSec.toFixed(3)},setpts=PTS-STARTPTS,${normalize}`;
  if (crossfadeSec <= 0) {
    return `${trimmed},format=yuv420p[v]`;
  }
  const cf = crossfadeSec.toFixed(3);
  return [
    `${trimmed},split=2[b0][t0]`,
    `[b0]trim=end=${bodyEndSec.toFixed(3)},setpts=PTS-STARTPTS[body]`,
    `[t0]trim=start=${bodyEndSec.toFixed(3)},setpts=PTS-STARTPTS,format=yuva420p,` +
      `fade=out:st=0:d=${cf}:alpha=1[tail]`,
    `[body][tail]overlay=eof_action=pass:enable='between(t,0,${cf})':format=auto,` +
      `format=yuv420p[v]`,
  ].join(';');
}

/**
 * Extract the loop's first post-trim frame, optimize it, and write it as the
 * dark poster. Because it is literally frame 0 of the encoded webm, the
 * poster→video handoff on the site is seamless.
 */
async function extractPoster(
  ffmpeg: string,
  webmPath: string,
  surface: string,
  width: number,
  height: number
): Promise<AssetEntry> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dorkos-poster-'));
  try {
    const rawPoster = path.join(workDir, 'poster.png');
    execFileSync(ffmpeg, ['-y', '-hide_banner', '-i', webmPath, '-frames:v', '1', rawPoster], {
      stdio: 'ignore',
    });
    const optimized = await optimizePng(await fs.readFile(rawPoster));
    await fs.writeFile(path.join(OUTPUT_DIR, `${surface}-dark.png`), optimized);
    return {
      file: `${surface}-dark.png`,
      surface,
      theme: 'dark',
      kind: 'still',
      width,
      height,
      bytes: optimized.length,
    };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Edit, encode, and poster one recorded loop. Head-trims to the action,
 * crossfades the seam, two-pass-VP9-encodes to the size budget at a consistent
 * size, and extracts the poster from the result. Returns the loop entry and its
 * poster entry (both `dark`). Deterministic and idempotent: same source +
 * head-trim always yields the same two files.
 */
export async function writeLoop(options: WriteLoopOptions): Promise<AssetEntry[]> {
  const { sourcePath, surface, width, height, headTrimMs } = options;
  const ffmpeg = resolveFfmpeg();
  const dest = path.join(OUTPUT_DIR, `${surface}-dark.webm`);

  const srcDurSec = probeDurationSec(ffmpeg, sourcePath);
  const headTrimSec = clamp(headTrimMs / 1000, 0, Math.max(0, srcDurSec - MIN_OUTPUT_SEC));
  const trimmedSec = srcDurSec - headTrimSec;
  const crossfadeSec = trimmedSec > MIN_CROSSFADE_ELIGIBLE_SEC ? CROSSFADE_SEC : 0;
  const bodyEndSec = trimmedSec - crossfadeSec;

  const filter = buildLoopFilter({ width, height, headTrimSec, bodyEndSec, crossfadeSec });
  const rate = Math.round((TARGET_LOOP_BYTES * 8) / bodyEndSec);
  const nullSink = os.platform() === 'win32' ? 'NUL' : '/dev/null';

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dorkos-vp9-'));
  try {
    const passLog = path.join(workDir, 'vp9');
    const common = [
      '-y',
      '-hide_banner',
      '-i',
      sourcePath,
      '-an',
      '-filter_complex',
      filter,
      '-map',
      '[v]',
      '-c:v',
      'libvpx-vp9',
      '-b:v',
      String(rate),
      '-row-mt',
      '1',
      '-deadline',
      'good',
      '-passlogfile',
      passLog,
    ];
    execFileSync(ffmpeg, [...common, '-cpu-used', '2', '-pass', '1', '-f', 'null', nullSink], {
      stdio: 'ignore',
    });
    execFileSync(ffmpeg, [...common, '-cpu-used', '1', '-pass', '2', dest], { stdio: 'ignore' });
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }

  const bytes = (await fs.stat(dest)).size;
  if (bytes > MAX_LOOP_BYTES) {
    process.stderr.write(
      `  ! ${surface}-dark.webm is ${(bytes / 1e6).toFixed(2)}MB, over the ${(
        MAX_LOOP_BYTES / 1e6
      ).toFixed(1)}MB budget\n`
    );
  }

  const poster = await extractPoster(ffmpeg, dest, surface, width, height);
  return [
    {
      file: `${surface}-dark.webm`,
      surface,
      theme: 'dark',
      kind: 'loop',
      width,
      height,
      bytes,
      durationMs: Math.round(bodyEndSec * 1000),
    },
    poster,
  ];
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
