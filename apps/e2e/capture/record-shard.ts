import { SHARD_INDEX } from './config.js';
import { prepareFilesystem } from './seed.js';
import { createShardRecorder } from './library.js';
import { autoSkippedShotIds } from './overrides.js';
import { setAssignedShots, setAutoSkip } from './lib.js';
import { bootSeedAndDrive } from './record.js';

/**
 * One shard of a parallel record. The orchestrator (`record.ts`) spawns one of
 * these per shard, each with its own `CAPTURE_SHARD` index — which
 * deterministically derives its ports and `DORK_HOME` (`config.ts`) — and its
 * `CAPTURE_SHOTS` partition. The worker prepares its isolated filesystem, boots
 * its own stack, captures only its assigned shots into the shared run's `raw/`
 * dir, and writes a partial manifest the orchestrator merges. Server deps are
 * built once by the orchestrator up front, so this worker never rebuilds.
 *
 * Signal safety: `bootSeedAndDrive` installs SIGINT/SIGTERM handlers for the
 * whole boot-drive window, so an orchestrator-initiated abort tears the shard's
 * stack down; nothing is spawned outside that window.
 *
 * @module capture/record-shard
 */

/** Read a required env var or fail loudly (the worker is never run by hand). */
function requireEnv(name: string): string {
  // eslint-disable-next-line no-restricted-syntax -- the capture harness has no env.ts; the orchestrator passes shard params via env
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required — record-shard is spawned by record.ts`);
  return value;
}

async function main(): Promise<void> {
  const runId = requireEnv('CAPTURE_RUN_ID');
  const runDir = requireEnv('CAPTURE_RUN_DIR');
  const assigned = new Set(
    // eslint-disable-next-line no-restricted-syntax -- the capture harness has no env.ts; the orchestrator passes the shot partition via env
    (process.env.CAPTURE_SHOTS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );

  process.stdout.write('▸ Preparing filesystem…\n');
  await prepareFilesystem();
  setAutoSkip(await autoSkippedShotIds());
  setAssignedShots(assigned);
  // Deps were built once by the orchestrator; skip straight to booting the stack.
  process.stdout.write('▸ Booting test-mode stack…\n');
  const rec = await bootSeedAndDrive(() => createShardRecorder(runId, runDir, SHARD_INDEX));
  await rec.finalize();
}

main().catch((err) => {
  process.stderr.write(
    `Shard ${SHARD_INDEX} failed: ${err instanceof Error ? err.stack : String(err)}\n`
  );
  process.exitCode = 1;
});
