import { performance } from 'node:perf_hooks';
import type { ProcessIdentity, ProcessObserver } from '@dorkos/browser';
import type { PrivateBrowserRetirementReceiver } from '@dorkos/browser/server-owner';
import type { PrivateBrowserResourceOwner } from '../private-native-acceptance.js';
import { createMeasuredBrowserResourceAdmission } from './measured-resource.js';
import type { BrowserResourceObservation } from './measured-resource.js';
import type { ReviewedBrowserResourceEnvelope } from './resource-envelope.js';
import {
  host,
  sampleResources,
  isOriginalResourceObservationRefusal,
  type Sample,
} from './resource-observation.js';

const same = (a: ProcessIdentity, b: ProcessIdentity) => a.pid === b.pid && a.birth === b.birth;
const immutable = (value: ProcessIdentity) => Object.freeze({ pid: value.pid, birth: value.birth });
/** Original mode owns this sampler, its exact constructor roots, ps children and all returns.
 * It confers no native, actor, network or Page authority. Missing observations grant no capacity. */
export function createProductionBrowserResourceOwner(options: {
  executableSHA256: string;
  envelope: ReviewedBrowserResourceEnvelope;
  processes: ProcessObserver;
  signal: AbortSignal;
  current(): boolean;
}) {
  const envelope = Object.freeze({ ...options.envelope });
  const current = options.current.bind(options),
    signal = options.signal;
  const observe = options.processes.observe.bind(options.processes),
    descendants = options.processes.descendants.bind(options.processes);
  const roots = new Map<PrivateBrowserRetirementReceiver, ProcessIdentity>();
  const jobs = new Set<Promise<unknown>>();
  const refusals = new WeakSet<object>();
  let first: { value: unknown } | undefined,
    stopped = false,
    epoch = 0,
    unknownRetirement = false;
  let cached: BrowserResourceObservation | undefined,
    refreshing: Promise<void> | undefined,
    closing: Promise<void> | undefined;
  const fail = (value: unknown) => {
    first ??= { value };
  };
  const refuse = (): never => {
    const reason = new Error('PRODUCTION_RESOURCE_OBSERVATION_UNAVAILABLE');
    refusals.add(reason);
    throw reason;
  };
  const expected = (value: unknown) =>
    isOriginalResourceObservationRefusal(value) ||
    (typeof value === 'object' && value !== null && refusals.has(value));
  const check = () => {
    if (first) throw first.value;
    if (stopped || unknownRetirement || signal.aborted || !current()) refuse();
  };
  const own = <T>(original: Promise<T>): Promise<T> => {
    jobs.add(original);
    void original.then(
      () => jobs.delete(original),
      (value) => {
        if (!expected(value)) fail(value);
        jobs.delete(original);
      }
    );
    return original;
  };
  const waits = new Set<() => void>();
  const wait = () =>
    new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const returned = () => {
        if (timer !== undefined) clearTimeout(timer);
        waits.delete(returned);
        signal.removeEventListener('abort', returned);
        resolve();
      };
      waits.add(returned);
      signal.addEventListener('abort', returned, { once: true });
      if (signal.aborted || stopped) returned();
      else timer = setTimeout(returned, envelope.samplingIntervalMilliseconds);
    });
  const snapshot = async (): Promise<readonly ProcessIdentity[]> => {
    check();
    const entered = epoch,
      selected = [...roots.values()];
    const identities: ProcessIdentity[] = [];
    for (const root of selected) {
      const tree = await own(descendants(root, signal));
      check();
      if (
        tree.status !== 'complete' ||
        !tree.identities.some((value) => same(value, root)) ||
        tree.identities.length > 512
      )
        refuse();
      identities.push(...tree.identities.map(immutable));
    }
    if (
      epoch !== entered ||
      identities.length > 512 ||
      new Set(identities.map((value) => value.pid)).size !== identities.length
    )
      refuse();
    return Object.freeze(identities);
  };
  const sample = async (): Promise<Sample> => {
    const identities = await snapshot();
    check();
    if (identities.length) return sampleResources({ own, guard: check, signal, snapshot, observe });
    // No browser root is retained: no PID is guessed and no OS-wide scan or ps is entered.
    const measured = host();
    if ((await snapshot()).length) refuse();
    check();
    return {
      host: measured,
      counterWindow: {
        startMilliseconds: measured.monotonicMilliseconds,
        endMilliseconds: measured.monotonicMilliseconds,
      },
      identities: [],
      counters: [],
    };
  };
  const admission = createMeasuredBrowserResourceAdmission({
    envelope: { ...envelope, executableSHA256: options.executableSHA256 },
    now: () => performance.now(),
    observe: () => {
      check();
      return (
        cached ?? {
          complete: false,
          observedAtMilliseconds: 0,
          cpuPercent: NaN,
          availableMemoryBytes: 0,
          browserRSSBytes: 0,
        }
      );
    },
  });
  const resources: PrivateBrowserResourceOwner = Object.freeze({
    onOriginalChild(
      receiver: Parameters<PrivateBrowserResourceOwner['onOriginalChild']>[0],
      original: Parameters<PrivateBrowserResourceOwner['onOriginalChild']>[1]
    ) {
      // Original root is retained before any validation or asynchronous producer can refuse.
      const root = immutable(original.root);
      if (roots.has(receiver)) refuse();
      roots.set(receiver, root);
      epoch++;
      cached = undefined;
      const observation = receiver.observation;
      own(
        observation.then((value) => {
          if (
            value.cleanup.state === 'settled' &&
            value.cleanup.coverage === 'closed' &&
            value.cleanup.pending === false &&
            value.cleanup.uncertainty.length === 0 &&
            value.terminal.cleanup === 'observed'
          ) {
            roots.delete(receiver);
            epoch++;
            cached = undefined;
          } else {
            unknownRetirement = true;
            epoch++;
            cached = undefined;
          }
          // Unverified retirement keeps the root reservation; it cannot become empty headroom.
        })
      );
      if (stopped || signal.aborted) return Promise.resolve();
      return own(
        Promise.resolve().then(() => {
          check();
          if (!original.complete || !original.identities.some((value) => same(value, root)))
            refuse();
        })
      );
    },
  });
  const refresh = (): Promise<void> => {
    if (refreshing) return refreshing;
    let yes!: () => void, no!: (value: unknown) => void;
    const original = own(
      new Promise<void>((resolve, reject) => {
        yes = resolve;
        no = reject;
      })
    );
    refreshing = original;
    void (async () => {
      try {
        cached = undefined;
        check();
        const entered = epoch,
          before = await sample();
        await own(wait());
        check();
        const after = await sample();
        check();
        const total = after.host.totalMilliseconds - before.host.totalMilliseconds,
          idle = after.host.idleMilliseconds - before.host.idleMilliseconds;
        if (
          entered !== epoch ||
          before.identities.length !== after.identities.length ||
          before.identities.some(
            (value) => !after.identities.some((other) => same(value, other))
          ) ||
          total <= 0 ||
          idle < 0 ||
          idle > total
        )
          refuse();
        cached = Object.freeze({
          complete: true,
          observedAtMilliseconds: after.host.monotonicMilliseconds,
          cpuPercent: 100 * (1 - idle / total),
          availableMemoryBytes: after.host.freeBytes,
          browserRSSBytes: after.counters.reduce((sum, value) => sum + value.rssBytes, 0),
        });
        yes();
      } catch (value) {
        cached = undefined;
        if (expected(value)) yes();
        else {
          fail(value);
          no(value);
        }
      } finally {
        if (refreshing === original) refreshing = undefined;
      }
    })();
    return original;
  };
  const prepareClose = () => {
    stopped = true;
    for (const returned of [...waits]) returned();
  };
  const close = (): Promise<void> => {
    if (closing) return closing;
    let yes!: () => void, no!: (value: unknown) => void;
    closing = new Promise<void>((resolve, reject) => {
      yes = resolve;
      no = reject;
    });
    prepareClose();
    void (async () => {
      while (jobs.size) await Promise.allSettled([...jobs]);
      if (first) no(first.value);
      else if (roots.size) no(new Error('PRODUCTION_RESOURCE_OWNERSHIP_UNRESOLVED'));
      else yes();
    })();
    return closing;
  };
  return Object.freeze({
    admission,
    resources,
    refresh,
    prepareClose,
    close,
    isRefusal: (value: unknown) =>
      typeof value === 'object' && value !== null && refusals.has(value),
  });
}
