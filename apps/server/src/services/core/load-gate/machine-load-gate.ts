/**
 * The server's one load gate (DOR-4209), made on first use and shared by every
 * launch in this process, the way the shell guard's host is (`guard-service.ts`).
 *
 * One per process is what keeps the person's list of waiting jobs whole: who a
 * job is for lives in the gate's memory ({@link LoadGate.waitingJobs}), so a
 * second gate would hold half of it. Processes share the line itself through the
 * queue folder, not through this.
 *
 * @module services/core/load-gate/machine-load-gate
 */
import { LoadGateSettingsSchema, type LoadGateSettings } from '@dorkos/shared/config-schema';
import { configManager } from '../config-manager.js';
import { createLoadGate, type LoadGate } from './load-gate.js';

let gate: LoadGate | undefined;

/**
 * The `runtimes.loadGate` settings as they are now, read again on every call
 * so a change applies to the next check. A config written before the setting
 * existed reads as the shipped defaults. Throws when the config is not loaded
 * yet; the gate treats that as a failure and lets the job run.
 */
export function loadGateSettings(): LoadGateSettings {
  return configManager.get('runtimes')?.loadGate ?? LoadGateSettingsSchema.parse(undefined);
}

/** The server's load gate, made on first use. Nothing touches the disk until a heavy job asks. */
export function machineLoadGate(): LoadGate {
  gate ??= createLoadGate({ config: loadGateSettings });
  return gate;
}
