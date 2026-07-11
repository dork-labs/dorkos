import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { loadRun } from './library.js';
import { applyOverrides } from './overrides.js';
import { getShot, SHOTS } from './shots.js';
import {
  resetOutputDir,
  writeLoop,
  writeManifest,
  writeStill,
  type AssetEntry,
} from './optimize.js';

/**
 * The PROCESS phase: read a recorded run's raws from the media library and run
 * the full editing stage — PNG optimization for stills; head-trim to the run's
 * markers, end-seam crossfade, two-pass VP9 encode, and poster extraction for
 * loops — writing the published set + `manifest.json` (tagged with the source
 * `runId`) into `apps/site/public/product/`. Raws are never mutated, so this
 * phase is safely re-runnable after any editing change.
 *
 * Run with: `pnpm --filter @dorkos/e2e capture:process [run-id]` (defaults to
 * the library's latest run).
 *
 * @module capture/process
 */

/**
 * Fail the publish if any registered shot's files are missing from the set.
 *
 * The record phase deliberately soldiers on past a failed drive (`attempt`
 * logs `✗` and continues) so one flaky surface doesn't waste a 20-minute run —
 * but without this backstop the phase would then exit 0 having silently
 * published an incomplete set, and a marketing or docs embed would 404 until
 * someone noticed. Runs before `writeManifest`, so a gap never reaches the
 * published contract.
 */
export function assertPublishedSetComplete(published: AssetEntry[]): void {
  const files = new Set(published.map((a) => a.file));
  const missing: string[] = [];
  for (const shot of SHOTS) {
    const expected = [`${shot.id}-light.png`];
    if (shot.kind === 'loop') expected.push(`${shot.id}-dark.webm`, `${shot.id}-dark.png`);
    missing.push(...expected.filter((f) => !files.has(f)));
  }
  if (missing.length > 0) {
    throw new Error(
      `published set is incomplete — missing: ${missing.join(', ')}. ` +
        `A drive likely failed during record (look for ✗ lines); re-record those shots ` +
        `or supply an override before publishing.`
    );
  }
}

/** Process one recorded run (default: latest) into the published product set. */
export async function runProcessPhase(runId?: string): Promise<void> {
  const { runDir, manifest } = await loadRun(runId);
  process.stdout.write(`▸ Processing run ${manifest.runId}…\n`);
  await resetOutputDir();

  /** Tag an auto-processed asset with its source run provenance. */
  const asAuto = (entry: AssetEntry): AssetEntry => ({
    ...entry,
    source: 'auto',
    runId: manifest.runId,
    capturedAt: manifest.recordedAt,
  });

  const auto: AssetEntry[] = [];
  for (const raw of manifest.assets) {
    const source = path.join(runDir, 'raw', raw.file);
    if (raw.kind === 'still') {
      auto.push(asAuto(await writeStill(await fs.readFile(source), raw.surface, raw.theme)));
      process.stdout.write(`  ✓ ${raw.surface}-${raw.theme}.png\n`);
    } else {
      const produced = await writeLoop({
        sourcePath: source,
        surface: raw.surface,
        width: raw.width,
        height: raw.height,
        headTrimMs: raw.headTrimMs,
        posterFrame: getShot(raw.surface)?.posterFrame,
      });
      auto.push(...produced.map(asAuto));
      process.stdout.write(`  ✓ ${raw.surface}-dark.webm (+ poster)\n`);
    }
  }

  // Human overrides win: applied on top of the auto set, re-encoded each run.
  const published = await applyOverrides(auto, new Date().toISOString());

  assertPublishedSetComplete(published);
  await writeManifest(published, manifest.runId);
  const manualCount = published.filter((a) => a.source === 'manual').length;
  const totalMb = (published.reduce((s, a) => s + a.bytes, 0) / 1e6).toFixed(2);
  const overrideNote = manualCount > 0 ? `, ${manualCount} from overrides` : '';
  process.stdout.write(`▸ Done: ${published.length} assets${overrideNote}, ${totalMb} MB total.\n`);
}

const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runProcessPhase(process.argv[2]).catch((err) => {
    process.stderr.write(`Process failed: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exitCode = 1;
  });
}
