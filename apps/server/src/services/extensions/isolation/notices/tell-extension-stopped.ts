/**
 * Tell the person an extension that runs separately stopped on its own
 * (DOR-4785). The words, tier and dedupe live in `extension-stopped-notice.ts`;
 * this only reads the restart decision and raises the row.
 *
 * Kept apart from the entry so the registry's import of the entry never pulls
 * in the notification service that imports the registry.
 *
 * @module services/extensions/isolation/notices/tell-extension-stopped
 */
import { notify } from '../../../notifications/notification-service.js';
import type { ExtensionStopReason } from './extension-stopped-notice.js';
import {
  RESTART_BUDGET,
  RESTART_WINDOW_MS,
  type RestartDecision,
  type RestartPolicyOptions,
} from '../restart-policy.js';

/**
 * Raise `extension.stopped` for one unexpected exit. The lifecycle does not
 * wait on it: a notice never holds up a restart. It never throws (`notify`
 * does not).
 *
 * @param extensionId - The extension id.
 * @param name - Its manifest name, or the id when the record is gone.
 * @param reason - Why it stopped this time.
 * @param decision - What the restart policy decided.
 * @param policy - The policy's tuning, so the words match the budget in use.
 * @returns Settles once the row is stored or deduped.
 */
export async function tellExtensionStopped(
  extensionId: string,
  name: string,
  reason: ExtensionStopReason,
  decision: RestartDecision,
  policy: RestartPolicyOptions = {}
): Promise<void> {
  // The policy's clock, so the stop is dated as the policy counted it.
  const stoppedAt = new Date((policy.now ?? Date.now)()).toISOString();
  await notify(
    'extension.stopped',
    'giveUp' in decision
      ? {
          extensionId,
          name,
          reason,
          state: 'off',
          stoppedAt,
          stops: policy.budget ?? RESTART_BUDGET,
          windowMinutes: Math.round((policy.windowMs ?? RESTART_WINDOW_MS) / 60_000),
        }
      : { extensionId, name, reason, state: 'restarting', stoppedAt }
  );
}
