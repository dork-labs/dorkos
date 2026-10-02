import { assertDirectory } from '../profiles/owned-directory.js';
import { rm } from 'node:fs/promises';
import type { EngineConfiguration, ProcessIdentity } from '../configuration.js';
import type { BrowserRecord, CloseOutcome } from './records.js';
import { completeInventory } from './inventory.js';
import { deadline, pause } from './deadline.js';

async function snapshot(config: EngineConfiguration, record: BrowserRecord): Promise<void> {
  if (!record.root || !record.rootAttributed) throw new Error();
  const abort = new AbortController();
  try {
    const tree = await deadline(
      config.processes.descendants(record.root, abort.signal),
      1000,
      'PROCESS_OBSERVATION_UNAVAILABLE'
    );
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
  record: BrowserRecord
): Promise<CloseOutcome> {
  // The injected clock labels observations; a host-monotonic budget bounds cleanup even if it stalls.
  const expires = performance.now() + 2000;
  while (true) {
    const abort = new AbortController();
    let statuses: string[];
    try {
      statuses = await deadline(
        Promise.all(
          record.identities.map(
            async (identity) => (await config.processes.observe(identity, abort.signal)).status
          )
        ),
        1000,
        'PROCESS_OBSERVATION_UNAVAILABLE'
      );
    } catch {
      return { cleanup: 'unverified', reason: 'observationUnavailable' };
    } finally {
      abort.abort();
    }
    if (statuses.some((status) => status !== 'alive' && status !== 'dead'))
      return { cleanup: 'unverified', reason: 'observationUnavailable' };
    if (statuses.every((status) => status === 'dead')) return { cleanup: 'observed' };
    if (performance.now() >= expires) return { cleanup: 'failed', reason: 'processesRemain' };
    await pause(25);
  }
}

/** Attempt graceful close despite observation failure; never release from close fulfillment alone. */
export async function closeRecord(
  config: EngineConfiguration,
  record: BrowserRecord
): Promise<CloseOutcome> {
  record.status = 'stopping';
  for (const tab of record.tabs.values()) tab.stopped = true;
  let observationFailed = record.setupCleanupUncertain === true;
  if (record.launchEntered) {
    try {
      await snapshot(config, record);
    } catch {
      observationFailed = true;
    }
  }
  let closeFailed = false;
  try {
    if (record.context) await deadline(record.context.close(), 2000, 'CONTEXT_CLOSE_TIMEOUT');
  } catch {
    closeFailed = true;
  }
  let outcome: CloseOutcome = observationFailed
    ? { cleanup: 'unverified', reason: 'observationUnavailable' }
    : record.launchEntered
      ? await observeGone(config, record)
      : { cleanup: 'observed' };
  if (closeFailed) outcome = { cleanup: 'failed', reason: 'closeFailed' };
  if (outcome.cleanup === 'observed') {
    try {
      if (record.dataRoot) assertDirectory(record.dataRoot);
      if (record.profileDir && !record.directory) throw new Error();
      if (record.directory) assertDirectory(record.directory);
      if (record.reservation) await record.reservation.release();
      else if (record.profileDir) await rm(record.profileDir, { recursive: true });
    } catch {
      outcome = { cleanup: 'unverified', reason: 'observationUnavailable' };
    }
  }
  try {
    await record.proxy?.close();
    record.proxy = undefined;
  } catch {
    if (outcome.cleanup === 'observed') outcome = { cleanup: 'failed', reason: 'closeFailed' };
  }
  if (outcome.cleanup === 'observed') {
    record.tabs.clear();
    record.context = undefined;
    record.reservation = undefined;
    record.profileDir = undefined;
    record.directory = undefined;
    record.dataRoot = undefined;
    record.root = undefined;
    record.identities = [];
  }
  record.status = outcome.cleanup === 'observed' ? 'stopped' : 'uncertain';
  return outcome;
}
