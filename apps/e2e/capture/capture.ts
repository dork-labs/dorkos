import { parseShardCount, runRecordPhase } from './record.js';
import { runProcessPhase } from './process.js';

/**
 * Entry point for the full product-capture pipeline: the RECORD phase (boot a
 * test-mode DorkOS stack, seed deterministic demo data, save raw recordings
 * into the media library) followed by the PROCESS phase (edit + encode the
 * raws into `apps/site/public/product/`). Each phase also runs standalone —
 * `capture:record` / `capture:process` — so editing changes are
 * re-process-only and never require a re-shoot.
 *
 * Run with: `pnpm --filter @dorkos/e2e capture [--shards N]`. The process phase
 * is shard-agnostic: it always reads one merged run, so `--shards` only affects
 * how the record phase parallelizes.
 *
 * @module capture/capture
 */

/** Record a fresh run (optionally sharded), then process it into the published set. */
async function main(): Promise<void> {
  const runId = await runRecordPhase(parseShardCount(process.argv.slice(2)));
  await runProcessPhase(runId);
}

main().catch((err) => {
  process.stderr.write(`Capture failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
