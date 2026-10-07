import { performance } from 'node:perf_hooks';
import type { ProcessIdentity } from '../../configuration.js';
import { createDarwinEngineProcesses } from '../darwin-engine-processes.js';
type Track = <T>(label: string, producer: () => Promise<T> | T) => Promise<T>;
const key = (identity: ProcessIdentity) => identity.pid + ':' + identity.birth;
/** Original native observer only. The cohort is the observed new descendants of this dedicated
 * SDK supervisor between its before-launch and before-close snapshots; no OS-wide claim. */
export function createSupervisorNativeCohort(
  artifact: Readonly<{ path: string; sha256: string }>,
  track: Track
) {
  const receiver = createDarwinEngineProcesses(Object.freeze({ ...artifact }));
  const identity = receiver.identity.bind(receiver),
    descendants = receiver.processes.descendants.bind(receiver.processes),
    observe = receiver.processes.observe.bind(receiver.processes);
  const baseline = new Set<string>(),
    cohort = new Map<string, ProcessIdentity>();
  let manager: ProcessIdentity | undefined,
    before: Promise<void> | undefined,
    after: Promise<void> | undefined,
    returned: Promise<void> | undefined;
  const snapshot = async (label: string, remember: boolean) => {
    if (!manager) throw new Error('BASELINE_NATIVE_MANAGER_UNOBSERVED');
    const scope = await track(label + '.manager', () => identity(process.pid));
    if (!scope || key(scope) !== key(manager)) throw new Error('BASELINE_NATIVE_MANAGER_CHANGED');
    const tree = await track(label + '.descendants', () =>
      descendants(manager!, new AbortController().signal)
    );
    if (
      tree.status !== 'complete' ||
      !tree.identities.some((value) => key(value) === key(manager!))
    )
      throw new Error('BASELINE_NATIVE_TREE_UNVERIFIED');
    const repeat = await track(label + '.managerAfter', () => identity(process.pid));
    if (!repeat || key(repeat) !== key(manager)) throw new Error('BASELINE_NATIVE_MANAGER_CHANGED');
    for (const value of tree.identities) {
      if (!remember) baseline.add(key(value));
      else if (!baseline.has(key(value))) cohort.set(key(value), Object.freeze({ ...value }));
    }
  };
  return Object.freeze({
    beforeLaunch(): Promise<void> {
      return (before ??= track('whole.baselineNative.beforeLaunch', async () => {
        manager = (await track('baselineNative.manager', () => identity(process.pid))) ?? undefined;
        if (!manager || manager.pid !== process.pid)
          throw new Error('BASELINE_NATIVE_MANAGER_UNOBSERVED');
        await snapshot('baselineNative.before', false);
      }));
    },
    afterLaunch(): Promise<void> {
      return (after ??= track('whole.baselineNative.afterLaunch', async () => {
        if (!before) throw new Error('BASELINE_NATIVE_BEFORE_MISSING');
        await before;
        await snapshot('baselineNative.afterSDKLaunch', true);
      }));
    },
    beforeOriginalClose(): Promise<void> {
      return track('whole.baselineNative.beforeClose', async () => {
        if (!after) throw new Error('BASELINE_NATIVE_AFTER_MISSING');
        await after;
        await snapshot('baselineNative.beforeSDKClose', true);
        if (!cohort.size) throw new Error('BASELINE_NATIVE_COHORT_UNOBSERVED');
      });
    },
    afterOriginalClose(): Promise<void> {
      return (returned ??= track('whole.baselineNative.afterClose', async () => {
        let failure: Readonly<{ value: unknown }> | undefined;
        // Original native snapshot failure cannot skip observations of all previously captured births.
        try {
          await snapshot('baselineNative.afterSDKClose', true);
        } catch (value) {
          failure = { value };
        }
        if (!cohort.size) failure ??= { value: new Error('BASELINE_NATIVE_COHORT_UNOBSERVED') };
        const deadline = performance.now() + 2000;
        for (;;) {
          const results = await Promise.allSettled(
            [...cohort.values()].map((value) => {
              const original = track('baselineNative.observeOriginalBirth', () =>
                observe(value, new AbortController().signal)
              );
              void original.then(
                () => {},
                (value) => {
                  failure ??= { value };
                }
              );
              return original;
            })
          );
          let alive = false;
          for (const result of results) {
            if (result.status === 'rejected') failure ??= { value: result.reason };
            else if (result.value.status === 'unknown')
              failure ??= { value: new Error('BASELINE_NATIVE_RETURN_UNVERIFIED') };
            else if (result.value.status === 'alive') alive = true;
          }
          if (failure) throw failure.value;
          if (!alive) return;
          if (performance.now() >= deadline) throw new Error('BASELINE_NATIVE_RETURN_UNVERIFIED');
          await track(
            'baselineNative.waitOriginalReturn',
            () => new Promise<void>((resolve) => setTimeout(resolve, 25))
          );
        }
      }));
    },
    observedBirths() {
      return [...cohort.values()].map((value) => Object.freeze({ ...value }));
    },
  });
}
