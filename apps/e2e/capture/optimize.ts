import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';
import sharp from 'sharp';
import { OUTPUT_DIR } from './config.js';
import { shotsManifest, type Dimensions } from './shots.js';

/**
 * Asset post-processing and the manifest contract. Stills are recompressed with
 * a palette-quantized PNG encoder (crisp for UI, a fraction of the raw size).
 * Loops run the full editing stage: head-trim to the action, a short tail→head
 * crossfade so the restart is seamless, a two-pass VP9 encode inside the size
 * budget, and a poster extracted from the loop's own first post-trim frame (so
 * the poster→video handoff is invisible). The written `manifest.json` is the
 * contract the marketing site and docs consume.
 *
 * The same optimization path serves both automated captures and human-supplied
 * overrides: a manual still or loop is validated for aspect, scaled to the
 * shot's target dimensions, and encoded identically, so overrides are never a
 * lower-quality second class.
 *
 * @module capture/optimize
 */

/** The manifest schema version. Bump on any breaking shape change. */
export const MANIFEST_SCHEMA_VERSION = 2;

/** Where an asset came from: the automated harness or a human override. */
export type AssetSource = 'auto' | 'manual';

/** Provenance recorded on a human-supplied override asset. */
export interface OverrideProvenance {
  /** Why the human capture beats the automated one. */
  reason?: string;
  /** Who supplied it. */
  capturedBy?: string;
  /** ISO date the override was captured/committed. */
  date?: string;
}

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
  /** Automated capture or human override. Defaults to `auto` when unset. */
  source?: AssetSource;
  /** ISO timestamp the source material was produced. */
  capturedAt?: string;
  /** Source library run id (auto assets only). */
  runId?: string;
  /** Override provenance (manual assets only). */
  override?: OverrideProvenance;
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
 * Read a media file's pixel dimensions from ffmpeg's probe output (the
 * `Stream ... , WxH` line). Used to validate a manual loop override's aspect
 * ratio before it is scaled to the shot's target size.
 */
function probeDimensions(ffmpeg: string, file: string): Dimensions {
  let stderr = '';
  try {
    execFileSync(ffmpeg, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? '';
  }
  const match = stderr.match(/,\s*(\d+)x(\d+)[\s,]/);
  if (!match) throw new Error(`could not probe dimensions of ${file}`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

/** Fractional aspect-ratio tolerance for override validation (1%). */
const ASPECT_TOLERANCE = 0.01;

/**
 * Assert a source asset's aspect ratio matches the shot's target frame, so a
 * human override is scaled — never silently cropped or stretched. Throws an
 * actionable error (naming the shot, the expected ratio, and what was supplied)
 * when the ratios diverge beyond {@link ASPECT_TOLERANCE}.
 *
 * @param label - The shot id, for the error message.
 * @param actual - The override source's real pixel dimensions.
 * @param target - The shot's target pixel dimensions.
 */
export function assertAspectMatches(label: string, actual: Dimensions, target: Dimensions): void {
  if (
    !Number.isFinite(actual.width) ||
    !Number.isFinite(actual.height) ||
    actual.width <= 0 ||
    actual.height <= 0
  ) {
    throw new Error(
      `could not read the dimensions of the override for "${label}" ` +
        `(got ${actual.width}×${actual.height}) — the source file may be corrupt or an unsupported format. ` +
        `Re-export it and try again; the aspect guard refuses to pass unverified media.`
    );
  }
  const actualRatio = actual.width / actual.height;
  const targetRatio = target.width / target.height;
  const drift = Math.abs(actualRatio - targetRatio) / targetRatio;
  // NaN never compares true, so an unguarded NaN here would silently PASS the
  // check — the explicit finite/positive assertion above exists to prevent that.
  if (drift > ASPECT_TOLERANCE) {
    throw new Error(
      `override for "${label}" has the wrong aspect ratio: got ${actual.width}×${actual.height} ` +
        `(${actualRatio.toFixed(3)}:1), but the ${label} frame is ${target.width}×${target.height} ` +
        `(${targetRatio.toFixed(3)}:1). Recapture at the correct aspect — the pipeline will not crop it.`
    );
  }
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
 * When `target` is supplied (the override path), the source's aspect ratio is
 * validated against it and the image is scaled to the exact target size;
 * automated captures pass no target and are recompressed at native size.
 *
 * @param buffer - The raw PNG bytes.
 * @param surface - The shot id (file becomes `<surface>-<theme>.png`).
 * @param theme - Light or dark variant.
 * @param options - Optional `kind` tag and `target` dimensions for scaling.
 */
export async function writeStill(
  buffer: Buffer,
  surface: string,
  theme: 'light' | 'dark',
  options: { kind?: 'still' | 'loop'; target?: Dimensions } = {}
): Promise<AssetEntry> {
  const { kind = 'still', target } = options;
  const file = `${surface}-${theme}.png`;
  let pipeline = sharp(buffer);
  if (target) {
    const meta = await pipeline.metadata();
    if (meta.width === undefined || meta.height === undefined) {
      throw new Error(
        `could not read the dimensions of the override still for "${surface}" — ` +
          `expected a valid PNG scaled to ${target.width}×${target.height}. ` +
          `Re-export the image and try again.`
      );
    }
    assertAspectMatches(surface, { width: meta.width, height: meta.height }, target);
    pipeline = sharp(buffer).resize(target.width, target.height, { fit: 'fill' });
  }
  const optimized = await pipeline
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
  /**
   * Validate the source's aspect ratio against `width`/`height` before
   * encoding. Set for human overrides (a mismatched source must fail loudly
   * rather than be stretched); automated recordings already match, so they skip
   * the extra probe.
   */
  validateSourceAspect?: boolean;
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
 * and (when eligible) crossfades the loop seam at the END of the clip.
 *
 * End-seam construction (founder art direction — the clip must OPEN clean, no
 * blend on film until the very end): the base plays the trimmed clip from
 * `crossfade` onward, so frame 0 is pure content. The clip's first `crossfade`
 * of footage is alpha-faded IN over the final `crossfade` window, dissolving
 * the tail into the head. The literal last frame equals the literal first
 * frame, so the restart is invisible and motion flows through the wrap.
 *
 * The overlay is confined to the seam with `enable='between(t,dur-cf,dur)'`
 * and `eof_action=pass`. Without both, overlay's default `eof_action=repeat`
 * keeps compositing the overlaid segment's last frame over every later frame —
 * the full-duration ghosting (double-exposed text) bug. The VFR Playwright
 * source made it worse: a 300ms `trim` window could hold a single barely-faded
 * frame, hence the up-front `fps` normalization too.
 */
function buildLoopFilter(spec: LoopFilterSpec): string {
  const { width, height, headTrimSec, bodyEndSec, crossfadeSec } = spec;
  const normalize = `scale=${width}:${height}:flags=lanczos,setsar=1,fps=${LOOP_FPS}`;
  const trimmed = `[0:v]trim=start=${headTrimSec.toFixed(3)},setpts=PTS-STARTPTS,${normalize}`;
  if (crossfadeSec <= 0) {
    return `${trimmed},format=yuv420p[v]`;
  }
  const cf = crossfadeSec.toFixed(3);
  const dur = bodyEndSec.toFixed(3);
  const seamStart = (bodyEndSec - crossfadeSec).toFixed(3);
  // Complete the fade one frame early so the literal last frame is the head
  // frame at full alpha — restart-frame equality a viewer (or a pixel diff)
  // can verify, instead of the fade only reaching 1.0 at the wrap instant.
  const fadeDur = Math.max(crossfadeSec - 1 / LOOP_FPS, 1 / LOOP_FPS).toFixed(3);
  return [
    `${trimmed},split=2[b0][h0]`,
    // Base: everything after the first `cf` of footage — a clean, blend-free open.
    `[b0]trim=start=${cf},setpts=PTS-STARTPTS[body]`,
    // Head segment: the first `cf` of footage, faded in, shifted onto the seam.
    `[h0]trim=end=${cf},setpts=PTS-STARTPTS,format=yuva420p,` +
      `fade=in:st=0:d=${fadeDur}:alpha=1,setpts=PTS+${seamStart}/TB[head]`,
    `[body][head]overlay=eof_action=pass:enable='between(t,${seamStart},${dur})':format=auto,` +
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
  const { sourcePath, surface, width, height, headTrimMs, validateSourceAspect } = options;
  const ffmpeg = resolveFfmpeg();
  const dest = path.join(OUTPUT_DIR, `${surface}-dark.webm`);

  if (validateSourceAspect) {
    assertAspectMatches(surface, probeDimensions(ffmpeg, sourcePath), { width, height });
  }

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

/**
 * Write the manifest describing every published asset (v2). Carries the shot
 * registry snapshot (`shots`) so the marketing site and docs stay consistent
 * with the pipeline, and tags each asset with its `source` (`auto`/`manual`)
 * and provenance. `runId` is the automated source run the auto assets came from.
 */
export async function writeManifest(assets: AssetEntry[], runId: string): Promise<void> {
  const sorted = assets
    .map((a) => ({ source: 'auto' as AssetSource, ...a }))
    .sort((a, b) => a.file.localeCompare(b.file));
  const totalBytes = sorted.reduce((sum, a) => sum + a.bytes, 0);
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    note: 'Real DorkOS UI rendering seeded demo data. Regenerate with `pnpm --filter @dorkos/e2e capture`.',
    /** The library run the automated assets were processed from (see capture/library/). */
    runId,
    totalBytes,
    count: sorted.length,
    /** The shot registry snapshot — the source of truth for downstream consumers. */
    shots: shotsManifest(),
    assets: sorted,
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
