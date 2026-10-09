import type { BrowserRecord } from '../lifecycle/records.js';
import { BrowserLifecycleError } from '../lifecycle/errors.js';
import { ownOperation } from '../lifecycle/ownership.js';

/** Original SDK restoration is owned before tab publication and cannot release its profile. */
export async function restoreProfileStorageState(record: BrowserRecord, stopped: () => boolean) {
  const state = record.initialStorageState;
  if (!state) return;
  try {
    if (record.mode !== 'persistent' || !record.context || stopped())
      throw new BrowserLifecycleError('ENGINE_STOPPED');
    const context = record.context,
      restore = context.setStorageState;
    if (typeof restore !== 'function') throw new BrowserLifecycleError('COMMAND_UNSUPPORTED');
    // The verified proxy/auth owners already exist. SDK restoration fulfils its internal
    // origin page with blank HTML; no ordinary tab, grant or viewer has been published.
    await ownOperation(record, () => {
      if (stopped()) throw new BrowserLifecycleError('ENGINE_STOPPED');
      return Reflect.apply(restore, context, [state]);
    });
    if (stopped()) throw new BrowserLifecycleError('ENGINE_STOPPED');
  } finally {
    delete record.initialStorageState;
  }
}
