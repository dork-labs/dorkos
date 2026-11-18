/**
 * The `extensions` config a person's run approval writes (DOR-516, DOR-2383,
 * DOR-2686). Pure, so the rules are tested without a manager.
 *
 * The yes names this copy and the permission set it declares now, answers any
 * "Not now" for the id (DOR-2517), and, when it is for another copy than the
 * last one (another folder, plugin or dev link, or other files), drops the
 * rooms and agents the person picked for the old copy (DOR-4573): they
 * approved these files, not where the old copy reached.
 *
 * @module services/extensions/pin/extension-approval-write
 */
import path from 'node:path';
import type {
  ApprovedPermissionSet,
  ExtensionApprovedSource,
  UserConfig,
} from '@dorkos/shared/config-schema';
import { withoutPersonChoices } from '../rooms/extension-room-access.js';

type ExtensionsConfig = UserConfig['extensions'];

/**
 * Whether a new approval is for the same copy and files as the stored one.
 * A first approval (nothing stored) counts as the same: it has nothing to drop.
 * A dev link or a path-trust copy records no digest, so it compares by copy
 * only. `grants` is left out on purpose: a person's first yes to a copy an
 * agent's approval already ran carries new `grants`, and must not cost them
 * their picks.
 *
 * @param previous - The approval stored for the id, if any.
 * @param next - The approval being written.
 */
export function isSameApprovedCopy(
  previous: ExtensionApprovedSource | undefined,
  next: ExtensionApprovedSource
): boolean {
  if (!previous) return true;
  return (
    path.resolve(previous.path) === path.resolve(next.path) &&
    (previous.plugin ?? null) === (next.plugin ?? null) &&
    (previous.devLink ?? null) === (next.devLink ?? null) &&
    (previous.digest ?? null) === (next.digest ?? null)
  );
}

/**
 * The `extensions` section after a person approves one copy to run.
 *
 * @param extensions - The `extensions` config section before the yes.
 * @param id - The extension approved.
 * @param source - The approval for this copy.
 * @param declared - The permission set it declares now.
 */
export function withRunApproval(
  extensions: ExtensionsConfig,
  id: string,
  source: ExtensionApprovedSource,
  declared: ApprovedPermissionSet
): ExtensionsConfig {
  const next: ExtensionsConfig = {
    ...extensions,
    approvedToRun: extensions.approvedToRun.includes(id)
      ? extensions.approvedToRun
      : [...extensions.approvedToRun, id],
    approvedSources: { ...(extensions.approvedSources ?? {}), [id]: source },
    approvedPermissions: { ...(extensions.approvedPermissions ?? {}), [id]: declared },
    ...(isSameApprovedCopy(extensions.approvedSources?.[id], source)
      ? {}
      : withoutPersonChoices(extensions, id)),
  };
  const dismissed = extensions.dismissedApprovals ?? {};
  if (dismissed[id]) {
    const remainingDismissals = { ...dismissed };
    delete remainingDismissals[id];
    next.dismissedApprovals = remainingDismissals;
  }
  return next;
}
