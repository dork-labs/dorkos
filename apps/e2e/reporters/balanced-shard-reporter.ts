import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FullConfig, Reporter, Suite, TestRun } from '@playwright/test/reporter';
import {
  load,
  partition,
  unitKey,
  weighUnits,
  type ShardTimings,
  type ShardUnit,
} from './balanced-shard';

/** The committed timings this reporter weighs units with. */
export const SHARD_TIMINGS_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'shard-timings.json'
);

/**
 * Replaces Playwright's count-based `--shard` cut with a duration-balanced one
 * (see `balanced-shard.ts` for the why and the determinism argument).
 *
 * It uses Playwright's own hook for this: `Reporter.preprocess` sees the full,
 * unsharded collection, `testRun.skipSharding()` turns the built-in filter off,
 * and `testRun.exclude()` drops every file suite that belongs to another
 * shard. `--shard=i/N` is still passed and still recorded as `.config.shard`,
 * so every reader of that field (the manifest reporter, the fan-in's
 * shard-set check) sees exactly what it saw before.
 *
 * An unsharded run is left alone.
 */
export default class BalancedShardReporter implements Reporter {
  private readonly timingsPath: string;

  /**
   * Reads its timings from the committed file unless told otherwise.
   *
   * @param options - reporter options from the config tuple
   * @param options.timings - timings file to read; defaults to {@link SHARD_TIMINGS_PATH}
   */
  constructor(options: { timings?: string } = {}) {
    this.timingsPath = options.timings ?? SHARD_TIMINGS_PATH;
  }

  /** Keeps only this shard's units. */
  async preprocess({
    config,
    suite,
    testRun,
  }: {
    config: FullConfig;
    suite: Suite;
    testRun: TestRun;
  }): Promise<void> {
    const shard = config.shard;
    if (!shard) return;

    const units: ShardUnit[] = [];
    const fileSuites = new Map<string, Suite>();
    for (const projectSuite of suite.suites) {
      const project = projectSuite.project();
      if (!project) continue;
      for (const fileSuite of projectSuite.suites) {
        const tests = fileSuite.allTests().length;
        if (tests === 0 || !fileSuite.location) continue;
        const key = unitKey(project.name, path.relative(project.testDir, fileSuite.location.file));
        units.push({ key, project: project.name, tests });
        fileSuites.set(key, fileSuite);
      }
    }

    // Read strictly: a missing or unreadable file must fail the shard loudly,
    // not quietly fall back to a cut that re-skews the suite.
    const timings = JSON.parse(fs.readFileSync(this.timingsPath, 'utf8')) as ShardTimings;
    if (!timings || typeof timings.units !== 'object' || timings.units === null) {
      throw new Error(
        `${this.timingsPath} has no "units" object; regenerate it with \`pnpm --filter @dorkos/e2e shard-timings\`.`
      );
    }

    const shards = partition(weighUnits(units, timings), shard.total);
    testRun.skipSharding();
    const mine = new Set(shards[shard.current - 1].map((u) => u.key));
    for (const [key, fileSuite] of fileSuites) if (!mine.has(key)) testRun.exclude(fileSuite);

    const minutes = (s: number) => (s / 60).toFixed(1);
    const estimated = shards[shard.current - 1];
    const unmeasured = estimated.filter((u) => u.basis !== 'measured').length;
    console.log(
      `balanced shard ${shard.current}/${shard.total}: ${estimated.length} of ${units.length} spec units, ` +
        `~${minutes(load(estimated))} min of tests (shards: ${shards.map((s) => minutes(load(s))).join(' / ')} min)` +
        (unmeasured ? `; ${unmeasured} unit(s) estimated without their own timing` : '')
    );
  }

  /** Prints only the one preprocess line above. */
  printsToStdio(): boolean {
    return false;
  }
}
