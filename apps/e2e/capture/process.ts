import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { OUTPUT_DIR } from './config.js';
import { loadRun } from './library.js';
import { applyOverrides } from './overrides.js';
import { getShot, SHOTS } from './shots.js';
import { writeLoop, writeManifest, writeStill, type AssetEntry } from './optimize.js';

/**
 * The PROCESS phase: read a recorded run's raws from the media library and run
 * the full editing stage — PNG optimization for stills; head-trim to the run's
 * markers, end-seam crossfade, two-pass VP9 encode, and poster extraction for
 * loops — writing the published set + `manifest.json` (tagged with the source
 * `runId`) into `apps/site/public/product/`. Raws are never mutated, so this
 * phase is safely re-runnable after any editing change — and the publish itself
 * is all-or-nothing ({@link publishWithRollback}), so a failed one leaves the
 * previously published set untouched.
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

/**
 * True for the files a publish owns and therefore replaces. Everything else in
 * the output dir — `archive/`, and anything a human dropped beside it — belongs
 * to someone else and is never touched.
 */
function isPublishedFile(entry: string): boolean {
  return entry.endsWith('.png') || entry.endsWith('.webm') || entry === 'manifest.json';
}

/**
 * Prefix of the directory the previous published set is parked in while a
 * publish rewrites it. Lives inside the output dir so the move is a rename on
 * one filesystem rather than a 30 MB copy across two, and starts with a dot so
 * nothing downstream mistakes it for a shot.
 */
const BACKUP_DIR_PREFIX = '.publish-backup-';

/**
 * This process's parking directory.
 *
 * **Suffixed with the pid, because a fixed name made one run able to delete
 * another's only copy.** Two process phases against one output dir is not a
 * supported way to run this (they would fight over the published files
 * themselves), but the failure mode of a shared name was disproportionate:
 * whichever run started second cleared "the" backup dir on its way in, and the
 * media the first run had parked there — the media that no longer existed
 * anywhere else — went with it. A pid suffix means a run can only ever clear
 * its own.
 */
function backupDirFor(outputDir: string): string {
  return path.join(outputDir, `${BACKUP_DIR_PREFIX}${process.pid}`);
}

/**
 * Put the parked set back after a failed publish, and report what could not be
 * put back.
 *
 * Never throws, and never stops at the first bad file: this runs while an error
 * is already in flight, so throwing would replace the diagnosis with itself,
 * and giving up early would strand forty-nine recoverable files behind one
 * unrecoverable one. Every failure is a name in the returned list instead.
 *
 * @returns The parked files still sitting in `backupDir` — empty when the
 *   previous set was fully restored.
 */
async function restoreParkedSet(
  outputDir: string,
  backupDir: string,
  parked: readonly string[]
): Promise<string[]> {
  // Clear whatever the failed publish managed to write, so the old set lands on
  // an empty slate instead of interleaving with a half-written one. Best
  // effort: a file that will not clear is one the rename below reports.
  try {
    for (const file of (await fs.readdir(outputDir)).filter(isPublishedFile)) {
      await fs.rm(path.join(outputDir, file), { force: true });
    }
  } catch {
    // Reported by the restore loop, which is the measurement that matters.
  }
  const stranded: string[] = [];
  for (const file of parked) {
    try {
      await fs.rename(path.join(backupDir, file), path.join(outputDir, file));
    } catch {
      stranded.push(file);
    }
  }
  return stranded;
}

/** Say so when another run's parking directory is sitting in the output dir. */
async function reportForeignBackups(outputDir: string, ownBackupDir: string): Promise<void> {
  const foreign = (await fs.readdir(outputDir)).filter(
    (entry) => entry.startsWith(BACKUP_DIR_PREFIX) && path.join(outputDir, entry) !== ownBackupDir
  );
  if (foreign.length === 0) return;
  process.stdout.write(
    `  ! ${foreign.join(', ')} — media a previous publish parked and never put back. ` +
      `Left alone (it may be the only copy, or another run may be using it); ` +
      `move its contents up a level or delete it once you have looked.\n`
  );
}

/**
 * Run a publish so that a failure anywhere inside it leaves the previously
 * published media exactly as it was.
 *
 * **The publish is destructive before it is verified, and that used to be
 * final.** The phase wiped the output dir, wrote every still and loop, and only
 * then ran {@link assertPublishedSetComplete} — so a record run that lost one
 * drive did not merely fail to publish, it left `apps/site/public/product/`
 * holding a half-written set with no manifest, and the marketing site's embeds
 * pointing into the hole. The only way back was `git checkout` of a 30 MB
 * directory. This is not a hypothetical: the shell-timeout half of DOR-1423
 * reproduces about once in nine mobile drives, and a timed-out shot exits its
 * shard with zero raws recorded, which is precisely the input that trips the
 * completeness backstop. Here the old set is moved aside instead of deleted,
 * and moved back if `publish` throws, so an aborted publish costs nothing.
 *
 * **A backup is deleted only once its contents are safely home.** Restoring can
 * itself fail, and the first version of this deleted the parking directory in a
 * `finally` regardless — which turned "the publish failed" into "the publish
 * failed and the media is gone", with the original error swallowed by the
 * restore's. So the backup survives any restore that did not complete, and the
 * error names both what went wrong and where the files are.
 *
 * **One publish at a time per output dir.** Concurrent runs still race over the
 * published files themselves — that is inherent to sharing a directory and is
 * not what this guards. It guards the parked copy: {@link backupDirFor} is
 * per-pid, so no run can clear another's.
 *
 * @param publish - Writes the new set into `outputDir`. Must not assume the
 *   directory is populated: it is emptied of published files before this runs.
 * @param outputDir - The published set's directory. Defaults to the real one;
 *   the parameter exists so the rollback can be exercised against a temp dir.
 */
export async function publishWithRollback(
  publish: () => Promise<void>,
  outputDir: string = OUTPUT_DIR
): Promise<void> {
  const backupDir = backupDirFor(outputDir);
  await fs.mkdir(outputDir, { recursive: true });
  // Only ever this pid's directory. A leftover from a recycled pid is ours to
  // clear; another run's parked media is not.
  await fs.rm(backupDir, { recursive: true, force: true });
  await fs.mkdir(backupDir, { recursive: true });
  await reportForeignBackups(outputDir, backupDir);

  const parked = (await fs.readdir(outputDir)).filter(isPublishedFile);
  for (const file of parked) {
    await fs.rename(path.join(outputDir, file), path.join(backupDir, file));
  }

  // Fail safe: the backup is only cleared on a path that has proven the media
  // is somewhere else. Every other path leaves it standing.
  let backupIsRedundant = false;
  try {
    await publish();
    backupIsRedundant = true;
  } catch (err) {
    const stranded = await restoreParkedSet(outputDir, backupDir, parked);
    if (stranded.length === 0) {
      backupIsRedundant = true;
      throw err;
    }
    throw new Error(
      `publish failed, and ${stranded.length} file(s) of the previous set could not be ` +
        `put back: ${stranded.join(', ')}. They are still in ${backupDir} — move them up ` +
        `a level by hand. The publish itself failed with: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  } finally {
    if (backupIsRedundant) await fs.rm(backupDir, { recursive: true, force: true });
  }
}

/** Process one recorded run (default: latest) into the published product set. */
export async function runProcessPhase(runId?: string): Promise<void> {
  const { runDir, manifest } = await loadRun(runId);
  process.stdout.write(`▸ Processing run ${manifest.runId}…\n`);

  /** Tag an auto-processed asset with its source run provenance. */
  const asAuto = (entry: AssetEntry): AssetEntry => ({
    ...entry,
    source: 'auto',
    runId: manifest.runId,
    capturedAt: manifest.recordedAt,
  });

  await publishWithRollback(async () => {
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
    process.stdout.write(
      `▸ Done: ${published.length} assets${overrideNote}, ${totalMb} MB total.\n`
    );
  });
}

const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runProcessPhase(process.argv[2]).catch((err) => {
    process.stderr.write(`Process failed: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exitCode = 1;
  });
}
