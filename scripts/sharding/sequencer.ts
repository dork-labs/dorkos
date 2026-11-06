import { BaseSequencer, type TestSpecification } from 'vitest/node';
import { relative, resolve } from 'node:path';
import { balance, readDurations } from './balance.ts';

const root = resolve(import.meta.dirname, '../..');

/** Balance CI's collected files by recorded duration; preserve Vitest's default sorting. */
export default class DurationSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    // CI pins this to the tested commit's timestamp, identical on all runners
    // and re-runs. Wall-clock expiry mid-run could otherwise mix two partitions.
    const asOf = Number(process.env.VITEST_SHARD_EPOCH) * 1000;
    const durations = readDurations(resolve(root, 'scripts/sharding/durations.json'), asOf);
    if (!durations) {
      console.log('[sharding] no usable duration snapshot; using Vitest hash/count split');
      return super.shard(files);
    }
    const { index, count } = this.ctx.config.shard!;
    const items = files.map((spec) => ({
      key: relative(root, spec.moduleId).replaceAll('\\', '/'),
      spec,
    }));
    const bins = balance(items, count, durations);
    const selected = bins[index - 1]!;
    console.log(
      `[sharding] ${index}/${count}: ${selected.items.length} files, estimated ${(selected.ms / 60000).toFixed(2)} test-minutes`
    );
    return selected.items.map(({ spec }: { spec: TestSpecification }) => spec);
  }
}
