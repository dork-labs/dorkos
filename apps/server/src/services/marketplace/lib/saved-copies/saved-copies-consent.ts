/**
 * Carry a global package's approval across the saved-copies migration
 * (DOR-2340).
 *
 * The migration only makes things inert: it moves saved copies out of the
 * places a package runs from and clears execute bits, and DorkOS now lists a
 * package's `bin/` programs by permission rather than by name. Either can
 * shrink what a package discloses (a saved `bin/tool.dork-old` is no longer
 * one of its programs, a saved skill folder no longer one of its skills), and
 * an approval binds the exact disclosure, so an approved package would be held
 * back for nothing new. When the package was approved just before its pass,
 * as it disclosed itself then or as the old name-based reader listed `bin/`,
 * the package as it is afterwards is recorded as approved. Nothing is
 * approved that was not approved before, and the hash it binds (the one its
 * install recorded) does not change.
 *
 * @module services/marketplace/lib/saved-copies/saved-copies-consent
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { EFFECT_BEARING_PATHS } from '@dorkos/marketplace';
import { disclosesAnything } from '@dorkos/shared/marketplace-schemas';
import { storedHookDecisions } from '../../../harness/hook-consent.js';
import {
  bindingOf,
  globalActivationEntry,
  readActivationState,
  recordGlobalActivationApproval,
} from '../../global-plugin-consent.js';
import type { MigrationHooks } from './migrate-saved-copies.js';

/** Every non-folder name directly in `bin/`: how `bin/` was listed before DOR-2340. */
async function binNamesByName(root: string): Promise<string[]> {
  const entries = await readdir(path.join(root, EFFECT_BEARING_PATHS.executables), {
    withFileTypes: true,
  }).catch(() => []);
  return entries
    .filter((e) => !e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/**
 * Whether the global package at `root` is approved right now, as it
 * discloses itself or as the old name-based `bin/` listing would have shown it.
 */
async function approvedNow(root: string): Promise<boolean> {
  const reading = await readActivationState(root).catch(() => undefined);
  if (reading === undefined || 'unreadable' in reading) return false;
  if (reading.subject?.kind !== 'installed' || !disclosesAnything(reading.effects)) return false;
  const decisions = storedHookDecisions();
  if (decisions.unreadable !== undefined) return false;
  const name = path.basename(root);
  const binding = bindingOf(reading.subject);
  const asListedBefore = { ...reading.effects, executables: await binNamesByName(root) };
  return [reading.effects, asListedBefore].some((effects) =>
    decisions.approved.includes(globalActivationEntry(name, effects, binding))
  );
}

/**
 * The hooks the boot migration runs around every global install root.
 *
 * @param dorkHome - The DorkOS data directory; only `<dorkHome>/plugins/*` is
 *   loaded into every session, so only those roots carry an approval.
 */
export function globalApprovalCarryOver(dorkHome: string): MigrationHooks<boolean> {
  const pluginsDir = path.join(dorkHome, 'plugins');
  const isGlobalPlugin = (root: string): boolean => path.dirname(root) === pluginsDir;
  return {
    async before(root) {
      return isGlobalPlugin(root) && (await approvedNow(root));
    },
    async after(root, wasApproved) {
      if (!wasApproved) return;
      const reading = await readActivationState(root);
      if ('unreadable' in reading || reading.subject?.kind !== 'installed') return;
      if (!disclosesAnything(reading.effects)) return;
      recordGlobalActivationApproval(
        path.basename(root),
        reading.effects,
        bindingOf(reading.subject)
      );
    },
  };
}
