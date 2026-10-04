import { assertDirectory } from '../profiles/owned-directory.js';
import { rm } from 'node:fs/promises';
import type { EngineConfiguration, ProcessIdentity } from '../configuration.js';
import type { BrowserRecord, CloseOutcome } from './records.js';
import { completeInventory } from './inventory.js';
import { until, pause } from './deadline.js';
import {
  ownOperation,
  closeOwned,
  fenceOrdinary,
  snapshotRetirementOwners,
  drainRetirement,
  aggregateRetirement,
  finishRetirement,
} from './ownership.js';
import type { RetirementSlot, AggregateCleanup } from './ownership.js';
import { closeInput, inputsSettled } from './input-owner.js';

const PARENT_CLOSE_MS = 5000;
const INPUT_WAIT_MS = 2000;
const unavailable: CloseOutcome = Object.freeze({
  cleanup: 'unverified',
  reason: 'observationUnavailable',
});

async function snapshot(
  config: EngineConfiguration,
  record: BrowserRecord,
  end: number
): Promise<void> {
  if (!record.root || !record.rootAttributed) throw new Error();
  const abort = new AbortController();
  try {
    const observation = ownOperation(record, () => {
      const observe = config.processes.descendants;
      if (performance.now() >= end) throw new Error();
      return Reflect.apply(observe, config.processes, [record.root, abort.signal]) as ReturnType<
        typeof observe
      >;
    });
    // An expired wait still owns rejection custody; await the original operation below.
    void observation.catch(() => {});
    const tree = await until(observation, end, 'PROCESS_OBSERVATION_UNAVAILABLE');
    const current = completeInventory(tree, record.root);
    const unique = new Map<string, ProcessIdentity>();
    for (const identity of [...record.identities, ...current])
      unique.set(`${identity.pid}:${identity.birth}`, identity);
    record.identities = [...unique.values()];
    record.inventoryComplete = true;
  } finally {
    abort.abort();
  }
}

async function observeGone(
  config: EngineConfiguration,
  record: BrowserRecord,
  end: number
): Promise<CloseOutcome> {
  while (performance.now() < end) {
    const abort = new AbortController();
    let statuses: string[];
    try {
      statuses = await until(
        Promise.all(
          record.identities.map((identity) =>
            ownOperation(record, () => {
              const observe = config.processes.observe;
              if (performance.now() >= end) throw new Error();
              return Reflect.apply(observe, config.processes, [
                identity,
                abort.signal,
              ]) as ReturnType<typeof observe>;
            }).then((value) => value.status)
          )
        ),
        Math.min(end, performance.now() + 1000),
        'PROCESS_OBSERVATION_UNAVAILABLE'
      );
    } catch {
      return unavailable;
    } finally {
      abort.abort();
    }
    if (statuses.some((status) => status !== 'alive' && status !== 'dead')) return unavailable;
    if (statuses.every((status) => status === 'dead')) return { cleanup: 'observed' };
    await until(pause(25), end, 'PROCESS_OBSERVATION_UNAVAILABLE').catch(() => {});
  }
  return { cleanup: 'failed', reason: 'processesRemain' };
}

function custodySettled(record: BrowserRecord): boolean {
  const owner = record.lifetime;
  return (
    !owner.uncertain &&
    !owner.closeFailed &&
    !owner.releasePending &&
    owner.pending.size === 0 &&
    [...record.tabs.values()].every((tab) => tab.pending === 0) &&
    inputsSettled(record)
  );
}

async function performClose(
  config: EngineConfiguration,
  record: BrowserRecord
): Promise<CloseOutcome> {
  const owner = record.lifetime;
  const end = owner.parentEnd!,
    inputEnd = owner.inputEnd!;
  for (const slot of owner.inputs.values()) closeInput(record, slot);
  // Start observation while the tree is still attributable, then enter all exact cooperative closes.
  const observed = record.launchEntered
    ? snapshot(config, record, Math.min(end, performance.now() + 1000))
    : Promise.resolve();
  void observed.catch(() => {});
  const context = record.context
    ? closeOwned(record, 'context', record.context)
    : Promise.resolve();
  const proxy = record.proxy ? closeOwned(record, 'proxy', record.proxy) : Promise.resolve();
  const inputs = Promise.all([
    ...[...record.tabs.values()].map((tab) => tab.tail),
    ...[...owner.inputs.values()].map(async (slot) => {
      await slot.constructed;
      closeInput(record, slot);
      if (slot.closePromise) await slot.closePromise;
    }),
  ]);
  void inputs.catch(() => {});
  let observationFailed = record.setupCleanupUncertain === true;
  try {
    await until(observed, end, 'PROCESS_OBSERVATION_UNAVAILABLE');
  } catch {
    observationFailed = true;
  }
  try {
    await until(context, inputEnd, 'CONTEXT_CLOSE_TIMEOUT');
  } catch {
    if (!owner.closeFailed) owner.uncertain = true;
  }
  try {
    await until(inputs, inputEnd, 'CONTEXT_CLOSE_TIMEOUT');
  } catch {
    owner.uncertain = true;
  }
  try {
    await until(proxy, end, 'FIXTURE_PROXY_CLOSE_FAILED');
  } catch {
    if (!owner.closeFailed) owner.uncertain = true;
  }
  let outcome: CloseOutcome =
    observationFailed || owner.uncertain
      ? unavailable
      : record.launchEntered
        ? await observeGone(config, record, Math.min(end, performance.now() + 2000))
        : { cleanup: 'observed' };
  if (owner.closeFailed) outcome = { cleanup: 'failed', reason: 'closeFailed' };
  if (outcome.cleanup === 'observed' && (!custodySettled(record) || performance.now() >= end))
    outcome = unavailable;
  if (outcome.cleanup === 'observed') {
    try {
      if (record.dataRoot) assertDirectory(record.dataRoot);
      if (record.profileDir && !record.directory) throw new Error();
      if (record.directory) assertDirectory(record.directory);
      // Directory observations can reenter retirement; all custody is checked again before release.
      if (!custodySettled(record) || performance.now() >= end) throw new Error();
      owner.releasePending = true;
      const release = ownOperation(record, () => {
        const reservation = record.reservation;
        const invoke = reservation?.release;
        if (
          !inputsSettled(record) ||
          [...record.tabs.values()].some((tab) => tab.pending > 0) ||
          owner.pending.size !== 1 ||
          owner.uncertain ||
          owner.closeFailed ||
          performance.now() >= end
        )
          throw new Error();
        return reservation
          ? (Reflect.apply(invoke!, reservation, []) as Promise<void>)
          : record.profileDir
            ? rm(record.profileDir, { recursive: true })
            : undefined;
      });
      void release.then(
        () => {
          owner.releasePending = false;
        },
        () => {
          owner.releasePending = false;
          owner.uncertain = true;
        }
      );
      await until(release, end, 'PROCESS_OBSERVATION_UNAVAILABLE');
      if (owner.pending.size !== 0 || owner.uncertain) throw new Error();
    } catch {
      owner.uncertain = true;
      outcome = unavailable;
    }
  }
  if (outcome.cleanup === 'observed') {
    record.tabs.clear();
    owner.inputs.clear();
    record.context = undefined;
    record.proxy = undefined;
    record.reservation = undefined;
    record.profileDir = undefined;
    record.directory = undefined;
    record.dataRoot = undefined;
    record.root = undefined;
    record.identities = [];
  }
  record.status = outcome.cleanup === 'observed' ? 'stopped' : 'uncertain';
  return Object.freeze(outcome);
}

/** Terminal retirement does not renew an existing parent or child wait end. */
export function closeRecord(
  config: EngineConfiguration,
  record: BrowserRecord,
  callerEnd?: number
): Promise<CloseOutcome> {
  if (record.closePromise) return record.closePromise;
  let resolve!: (outcome: CloseOutcome) => void;
  record.closePromise = new Promise((done) => {
    resolve = done;
  });
  const owner = record.lifetime;
  // This synchronous fence precedes even the clock getter/callback.
  const slot = owner && fenceOrdinary(record, 'explicitStop');
  record.status = 'stopping';
  if (!owner || !slot) {
    if (owner) owner.uncertain = true;
    record.status = 'uncertain';
    resolve(unavailable);
    return record.closePromise;
  }
  try {
    snapshotRetirementOwners(record, slot);
    const entry = performance.now();
    if (!Number.isFinite(entry) || entry < 0) throw new Error('RETIREMENT_CLOCK_UNAVAILABLE');
    const proposed = Math.min(entry + PARENT_CLOSE_MS, callerEnd ?? Infinity);
    if (!Number.isFinite(proposed)) throw new Error('RETIREMENT_CLOCK_UNAVAILABLE');
    owner.parentEnd ??= proposed;
    owner.inputEnd ??= Math.min(owner.parentEnd, entry + INPUT_WAIT_MS);
    slot.end = owner.parentEnd;
    slot.inputEnd = owner.inputEnd;
  } catch {
    owner.uncertain = true;
    slot.coverageUnavailable = true;
    // No additional deadline and no cleanup permit. Available terminal closes still enter.
    owner.parentEnd ??= 0;
    owner.inputEnd ??= 0;
    slot.end = owner.parentEnd;
    slot.inputEnd = owner.inputEnd;
  }
  void retireThenClose(config, record, slot).then(resolve, () => {
    owner.uncertain = true;
    record.status = 'uncertain';
    const aggregate = aggregateRetirement(record, slot);
    finishRetirement(record, slot, aggregate, unavailable);
    resolve(unavailable);
  });
  return record.closePromise;
}

/** All exact cleanup owners enter before the first wait; terminal cleanup follows even on refusal. */
async function retireThenClose(
  config: EngineConfiguration,
  record: BrowserRecord,
  slot: RetirementSlot
): Promise<CloseOutcome> {
  const owner = record.lifetime;
  let aggregate: AggregateCleanup;
  const draining = drainRetirement(record, slot);
  try {
    aggregate = await until(draining, owner.inputEnd!, 'RETIREMENT_DRAIN_UNAVAILABLE');
  } catch {
    owner.uncertain = true;
    aggregate = aggregateRetirement(record, slot);
  }
  if (aggregate.state !== 'settled') owner.uncertain = true;
  // Attempt every local terminal invalidation; one throwing callback cannot suppress its peers.
  slot.terminalEntered = true;
  try {
    owner.gate.stop();
  } catch {
    owner.uncertain = true;
  }
  for (const tab of record.tabs.values()) {
    for (const local of [() => tab.pointer.invalidate(), () => tab.diagnostics.discard()]) {
      try {
        local();
      } catch {
        owner.uncertain = true;
      }
    }
    tab.stopped = true;
  }
  let terminal: CloseOutcome;
  try {
    terminal = await performClose(config, record);
  } catch {
    owner.uncertain = true;
    record.status = 'uncertain';
    terminal = unavailable;
  }
  finishRetirement(record, slot, aggregate, terminal);
  return terminal;
}
