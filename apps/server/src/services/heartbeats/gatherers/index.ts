/**
 * The gatherer registry and the bounded run over it (spec `heartbeats` §5).
 *
 * A new gatherer is one file here and one entry in {@link GathererRegistry};
 * goals (DOR-2755) and responsibilities (DOR-2743) arrive that way.
 *
 * Every gatherer is bounded to {@link GATHER_TIMEOUT_MS} and its share of
 * {@link GATHER_MAX_CHANGES}, and never throws: a failure becomes a `health`
 * change, so a broken gatherer is seen rather than silently skipped.
 *
 * @module services/heartbeats/gatherers
 */
import type { HeartbeatGatherer } from '@dorkos/shared/heartbeat-schemas';
import type { Change, GatherContext, Gatherer } from './types.js';

export type { Change, ChangeTouch, GatherAgent, GatherContext, Gatherer } from './types.js';
export { createAddressedGatherer } from './addressed.js';
export { createCommitmentsGatherer, type CommitmentReader } from './commitments.js';
export { createSchedulesGatherer, type OwnRun, type OwnRunReader } from './schedules.js';
export { createHealthGatherer } from './health.js';
export { createWorkspaceGatherer, runCommand, type RunCommand } from './workspace.js';

/** How long one gatherer may take. */
export const GATHER_TIMEOUT_MS = 2000;

/** The most changes one beat carries. */
export const GATHER_MAX_CHANGES = 50;

/** Every gatherer this server runs, by name. */
export type GathererRegistry = Partial<Record<HeartbeatGatherer, Gatherer>>;

/** What a gather found. */
export interface GatherResult {
  /** The changes, de-duplicated by key, at most {@link GATHER_MAX_CHANGES}. */
  changes: Change[];
  /** How many each gatherer found, for the beat row. */
  counts: Record<string, number>;
  /** The gatherers that threw or ran out of time, so never saw their window. */
  failed: HeartbeatGatherer[];
}

/**
 * Run one gatherer under its time limit, turning a failure into a `health`
 * change and saying it failed.
 *
 * @param name - The gatherer's name.
 * @param gatherer - The gatherer.
 * @param ctx - The context, without its signal.
 */
async function runOne(
  name: HeartbeatGatherer,
  gatherer: Gatherer,
  ctx: Omit<GatherContext, 'signal'>
): Promise<{ changes: Change[]; failed: boolean }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve('timeout');
    }, GATHER_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    const result = await Promise.race([gatherer({ ...ctx, signal: controller.signal }), timeout]);
    if (result === 'timeout') throw new Error(`took longer than ${GATHER_TIMEOUT_MS / 1000}s`);
    return { changes: result, failed: false };
  } catch (err) {
    return {
      failed: true,
      changes: [
        {
          gatherer: 'health',
          key: `gatherer-failed:${name}`,
          summary: `The ${name} check could not run: ${err instanceof Error ? err.message : String(err)}`,
          at: ctx.now.toISOString(),
          signal: 'info',
        },
      ],
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run the gatherers a beat watches, in registry order, all at once.
 *
 * @param registry - Every gatherer this server runs.
 * @param watch - Which ones this agent watches.
 * @param ctx - The context, without its signal.
 */
export async function runGatherers(
  registry: GathererRegistry,
  watch: readonly HeartbeatGatherer[],
  ctx: Omit<GatherContext, 'signal'>
): Promise<GatherResult> {
  const names = watch.filter((name) => registry[name] !== undefined);
  const results = await Promise.all(names.map((name) => runOne(name, registry[name]!, ctx)));
  const seen = new Set<string>();
  const changes: Change[] = [];
  const counts: Record<string, number> = {};
  const failed = names.filter((_name, i) => results[i]!.failed);
  for (const batch of results) {
    for (const change of batch.changes) {
      if (seen.has(change.key)) continue;
      seen.add(change.key);
      counts[change.gatherer] = (counts[change.gatherer] ?? 0) + 1;
      if (changes.length < GATHER_MAX_CHANGES) changes.push(change);
    }
  }
  return { changes, counts, failed };
}
