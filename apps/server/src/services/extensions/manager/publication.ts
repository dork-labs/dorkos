import type { ExtensionRecordPublic } from '@dorkos/extension-api';

import { isEnabled } from '../extension-enable-resolution.js';

import { configManager } from '../../core/config-manager.js';

import { toPublic } from '../extension-manager-types.js';
import { mayRunExtensionCode } from '../extension-load-policy.js';

import type { ManagerState } from './state.js';
/** Return a public snapshot after all earlier manager work settles. */
export async function readPublic(
  state: ManagerState,
  options: { includeShadowed?: boolean } = {}
): Promise<ExtensionRecordPublic[]> {
  return state.operations.enqueue(async () => {
    const running = listPublic(state);
    const records = options.includeShadowed ? [...running, ...listShadowedPublic(state)] : running;
    const config = configManager.get('extensions');
    return records.map((record) => {
      if (isEnabled(record.id, config, state.coreExtensions)) return record;
      const { bundleGeneration: _notRunnable, ...withoutGeneration } = record;
      return withoutGeneration;
    });
  });
}

/** Project the current visible copies with their bundle correspondence. */
export function listPublic(state: ManagerState): ExtensionRecordPublic[] {
  const approvals = configManager.get('extensions');
  return Array.from(state.extensions.values()).map((record) => toPublic(record, approvals));
}

/** Project the displaced copies without granting them execution. */
export function listShadowedPublic(state: ManagerState): ExtensionRecordPublic[] {
  const approvals = configManager.get('extensions');
  return state.shadowed.map((record) => toPublic(record, approvals));
}

/** Serve only the approved current generation, rechecked after cache access. */
export async function readBundle(
  state: ManagerState,
  id: string,
  expectedGeneration: string
): Promise<string | null> {
  return state.operations.enqueue(async () => {
    const record = state.extensions.get(id);
    if (
      !record ||
      !record.sourceHash ||
      !record.bundleReady ||
      !['compiled', 'active'].includes(record.status)
    )
      return null;
    const sourceHash = record.sourceHash;
    const allowed = () => {
      const config = configManager.get('extensions');
      return (
        state.extensions.get(id) === record &&
        record.sourceHash === sourceHash &&
        record.bundleReady &&
        ['compiled', 'active'].includes(record.status) &&
        isEnabled(id, config, state.coreExtensions) &&
        mayRunExtensionCode(record, config) &&
        toPublic(record, config).bundleGeneration === expectedGeneration
      );
    };
    if (!allowed()) return null;
    const bundle = await state.compiler.readBundle(id, sourceHash);
    return allowed() ? bundle : null;
  });
}

/** Record activation for the current extension copy. */
export function reportActivated(state: ManagerState, id: string): void {
  const record = state.extensions.get(id);
  if (record && record.status === 'compiled') {
    record.status = 'active';
  }
}

/** Record a bounded activation failure for the current copy. */
export function reportActivateError(state: ManagerState, id: string, error: string): void {
  const record = state.extensions.get(id);
  if (record) {
    record.status = 'activate_error';
    record.error = { code: 'activate_error', message: error };
  }
}
