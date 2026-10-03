import type { ExtensionRecord, ExtensionRecordPublic } from '@dorkos/extension-api';

import { isEnabled, setEnabled } from '../extension-enable-resolution.js';

import { ExtensionCompiler } from '../extension-compiler.js';

import {
  testClientExtension,
  testServerCompilation as testServerEntry,
} from '../extension-test-harness.js';
import { scaffoldExtension, buildCreateResult } from '../extension-scaffolder.js';
import { configManager } from '../../core/config-manager.js';
import { logConfigWrite } from '../../core/operator/config-write.js';
import type { ExtensionTemplate } from '../extension-templates.js';
import {
  toPublic,
  toRecordError,
  type CreateExtensionResult,
  type ReloadExtensionResult,
  type TestExtensionResult,
} from '../extension-manager-types.js';

import { logger } from '../../../lib/logger.js';

import type { ManagerState } from './state.js';
/** Apply one compilation result to its exact current record. */
export function applyCompileResult(
  record: ExtensionRecord,
  result: Awaited<ReturnType<ExtensionCompiler['compile']>>
): boolean {
  if ('error' in result) {
    record.status = 'compile_error';
    record.error = toRecordError(result.error);
    record.sourceHash = result.sourceHash;
    record.bundleReady = false;
    return false;
  }
  record.status = 'compiled';
  record.sourceHash = result.sourceHash;
  record.bundleReady = true;
  record.error = undefined;
  return true;
}
/** Recompile one extension through the manager publication queue. */
export async function reloadExtension(
  state: ManagerState,
  id: string
): Promise<ReloadExtensionResult> {
  const record = state.extensions.get(id);
  if (!record) throw new Error(`Extension '${id}' not found`);

  if (!isEnabled(id, configManager.get('extensions'), state.coreExtensions)) {
    throw new Error(
      `Extension '${id}' is turned off, so DorkOS did not reload it. Nothing about it ran. ` +
        `Turn it on in Settings > Extensions in DorkOS first, then reload.`
    );
  }

  const compileResult = await state.compiler.compile(record);
  const ok = applyCompileResult(record, compileResult);

  if (!ok && 'error' in compileResult) {
    return {
      id,
      status: 'compile_error',
      bundleReady: false,
      sourceHash: compileResult.sourceHash,
      error: {
        code: compileResult.error.code,
        message: compileResult.error.message,
        errors: compileResult.error.errors,
      },
    };
  }

  if (record.hasServerEntry || record.hasDataProxy) {
    await state.serverLifecycle.shutdown(id);
    const serverResult = await state.serverLifecycle.initialize(id, record);
    if (!serverResult.ok) {
      logger.warn(`[Extensions] Server reload failed for ${id}: ${serverResult.error}`);
    }
  }

  return { id, status: 'compiled', bundleReady: true, sourceHash: record.sourceHash };
}

/** Run the extension validation harness for the current copy. */
export async function testExtension(state: ManagerState, id: string): Promise<TestExtensionResult> {
  const record = state.extensions.get(id);
  if (!record) throw new Error(`Extension '${id}' not found`);
  return testClientExtension(record, state.compiler);
}

/** Check server-side compilation without changing run approval. */
export async function testServerCompilation(
  state: ManagerState,
  id: string
): Promise<string | null> {
  const record = state.extensions.get(id);
  if (!record) return null;
  return testServerEntry(record, state.compiler);
}

/** Create an extension from the chosen template and rediscover it. */
export async function createExtension(
  state: ManagerState,
  options: {
    name: string;
    description?: string;
    template: ExtensionTemplate;
    scope: 'global' | 'local';
  }
): Promise<CreateExtensionResult> {
  const scaffoldResult = await scaffoldExtension({
    ...options,
    dorkHome: state.dorkHome,
    currentCwd: state.currentCwd,
  });

  await state.operations.reload();
  await enable(state, options.name);

  const record = state.extensions.get(options.name);
  return buildCreateResult(scaffoldResult, options, record);
}

/** Enable the selected copy and compile it only when approved. */
export async function enable(
  state: ManagerState,
  id: string
): Promise<{ extension: ExtensionRecordPublic; reloadRequired: boolean } | null> {
  // An id this manager has not seen may have just arrived on disk: the
  // marketplace plugin install enables each extension it carries right after
  // moving the plugin into place, before anything re-scanned (DOR-2383).
  if (!state.extensions.has(id)) await state.operations.reload();
  const record = state.extensions.get(id);
  if (!record) return null;
  if (record.status === 'incompatible' || record.status === 'invalid') return null;

  record.status = 'enabled';
  const compileResult = await state.compiler.compile(record);
  const ok = applyCompileResult(record, compileResult);

  if (ok) {
    // Route through the deviation-list resolver so the correct list is
    // mutated (default-on core → `disabled`; everything else → `enabled`).
    const before = configManager.get('extensions');
    const next = setEnabled(id, true, before, state.coreExtensions);
    configManager.set('extensions', next);
    logConfigWrite('the extensions manager', 'extensions', before, configManager.get('extensions'));

    if (record.hasServerEntry || record.hasDataProxy) {
      const serverResult = await state.serverLifecycle.initialize(id, record);
      if (!serverResult.ok) {
        logger.warn(`[Extensions] Server init failed for ${id}: ${serverResult.error}`);
      }
    }
  }

  state.operations.emitChanged();
  return {
    extension: toPublic(record, configManager.get('extensions')),
    reloadRequired: true,
  };
}

/** Disable the extension before retiring its server-side lifetime. */
export async function disable(
  state: ManagerState,
  id: string
): Promise<{ extension: ExtensionRecordPublic; reloadRequired: boolean } | null> {
  const record = state.extensions.get(id);
  if (!record) return null;

  // Core extensions may be locked on (`canDisable: false`) — refuse to disable
  // them. Defense in depth behind the settings UI, which hides the toggle.
  if (record.origin === 'core' && state.coreExtensions.get(id)?.canDisable === false) {
    return null;
  }

  await state.serverLifecycle.shutdown(id);

  // Route through the deviation-list resolver so the correct list is mutated.
  const before = configManager.get('extensions');
  const next = setEnabled(id, false, before, state.coreExtensions);
  configManager.set('extensions', next);
  logConfigWrite('the extensions manager', 'extensions', before, configManager.get('extensions'));

  record.status = 'disabled';
  record.bundleReady = false;
  record.error = undefined;

  state.operations.emitChanged();
  return {
    extension: toPublic(record, configManager.get('extensions')),
    reloadRequired: true,
  };
}
