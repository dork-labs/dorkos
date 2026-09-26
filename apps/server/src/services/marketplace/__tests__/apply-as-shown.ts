/**
 * Test helper: apply updates the only way the flow allows, as a person who
 * approved exactly what each check disclosed. Plans with `disclose`, then
 * applies every `update-available` installation held to its own disclosure.
 *
 * @module services/marketplace/__tests__/apply-as-shown
 */
import type { UpdateFlow } from '../flows/update.js';
import type { InstallationRecord } from '../installed-scanner.js';
import type { InstallationUpdatesResult } from '../flows/update-types.js';
import type { InstallResult } from '../types.js';

/**
 * Check `installations` and apply every stale one, held to what its check disclosed.
 *
 * @param flow - The update flow under test.
 * @param installations - The installations to check and apply.
 * @returns The applied result, plus every reinstall that landed, in order.
 */
export async function applyAsShown(
  flow: Pick<UpdateFlow, 'planInstallations' | 'applyPlan'>,
  installations: InstallationRecord[]
): Promise<InstallationUpdatesResult & { applied: InstallResult[] }> {
  const plan = await flow.planInstallations({ installations, disclose: true });
  const approved = new Map(
    plan.checks
      .filter((c) => c.status === 'update-available' && c.disclosed !== undefined)
      .map((c) => [c.installPath, c.disclosed ?? null])
  );
  const result = await flow.applyPlan(plan, approved);
  return { ...result, applied: result.checks.flatMap((c) => (c.applied ? [c.applied] : [])) };
}
