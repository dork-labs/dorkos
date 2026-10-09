import type { UiCommand } from '@dorkos/shared/types';
import { executeUiCommand } from '@/layers/shared/lib/ui-action-dispatcher';
import type { ExtensionAPIDeps } from './types';
import { retainCleanup } from './extension-registration-owner';

/**
 * Create the private originating UI dispatcher using the loader's original cleanup array.
 *
 * @param deps - Original dependencies; dispatcher context remains read only at command entry.
 * @param cleanups - Exact live cleanup ledger installed before extension activation.
 * @param requireCurrent - Original admission check; built-in calls omit it.
 * @returns Original command dispatch with its cleanup-capable owner, or the unowned call.
 */
export function createExtensionUiEffectDispatcher(
  deps: Pick<ExtensionAPIDeps, 'dispatcherContext'>,
  cleanups: Array<() => void>,
  requireCurrent?: () => void
) {
  const effectOwner = requireCurrent
    ? Object.freeze({
        beforeEffect: requireCurrent,
        registerCleanup: (cleanup: () => void) => {
          const original = retainCleanup(cleanup);
          requireCurrent();
          cleanups.push(original);
          requireCurrent();
          return () => {
            requireCurrent();
            const index = cleanups.indexOf(original);
            if (index >= 0) cleanups.splice(index, 1);
          };
        },
      })
    : undefined;
  const dispatch = (command: UiCommand): void => {
    if (effectOwner) executeUiCommand(deps.dispatcherContext, command, 'agent', effectOwner);
    else executeUiCommand(deps.dispatcherContext, command, 'agent');
  };
  return dispatch;
}
