/**
 * The space side of the asks port (spec `computer-side-starts-alone` §5.7):
 * the consent cards computer-side code raises, and the standing decisions it
 * reports, built, waited on and written here.
 *
 * The computer says what it wants to do and why (`AskRequest` in
 * `@dorkos/shared/computer-asks`). This module builds the card (its words, its
 * binding, who may answer it and how long it waits are the cards' own, moved
 * here unchanged), waits for a person, writes the standing decision itself, and
 * returns only the answer. A decision that needs no card (an upgrade pin, a
 * person's own edit moving a pin) is written the same way through `record`.
 * The computer never writes the `harness` or `permissions` settings;
 * `services/__tests__/computer-consent-writes-census.test.ts` holds that.
 *
 * Startup hands the computer side {@link computerAsks} before any turn runs
 * (`startup/computer-asks.ts`), and the approval service to raise cards through
 * once it exists ({@link setAskApprovals}). Until then a card is never raised
 * and the answer is `unwired`: nobody was asked, so nothing is allowed.
 *
 * @module services/core/approvals/computer-asks
 */
import type { CapabilityTier } from '@dorkos/shared/capabilities';
import type {
  AskAnswer,
  AskRequest,
  AskWatch,
  ComputerAsks,
  StandingDecision,
} from '@dorkos/shared/computer-asks';
import { raiseFolderAllowsCard, describeFolderAllowCapability } from './folder-allows-card-ask.js';
import { raiseFolderConfigCard, describeFolderConfigCapability } from './folder-config-card-ask.js';
import {
  describeHookProjectionCapability,
  hookProjectionBinding,
  raiseHookCard,
  type HookApprovalGateway,
} from './hook-card-ask.js';
import {
  raiseRepoConfigCard,
  describeRepoConfigCapability,
  type RepoConfigApprovalGateway,
} from './repo-config-card-ask.js';
import {
  markFolderConfigsPinned,
  recordFolderAllowApproval,
  recordFolderConfigApproval,
  repinFolderConfigPart,
} from './folder-decisions.js';
import { pinLegacyHookApproval, recordApprovedEntry } from './hook-decisions.js';
import {
  markRepoBaselinesPinned,
  recordBaseline,
  recordRepoConfigApproval,
} from './repo-decisions.js';

/** The slice of `ApprovalService` every card here raises through. */
export type AskApprovals = HookApprovalGateway & RepoConfigApprovalGateway;

/** Where the approval service is read from: the service itself, or a getter. */
export type AskApprovalsSource =
  AskApprovals | null | undefined | (() => AskApprovals | null | undefined);

/**
 * Build the asks port over one source of the approval primitive.
 *
 * @param source - The approval service, or a getter read on every ask; none
 *   means no card is raised and every ask answers `unwired`.
 */
export function createComputerAsks(source: AskApprovalsSource): ComputerAsks {
  const approvals = (): AskApprovals | null | undefined =>
    typeof source === 'function' ? source() : source;
  return {
    raise: (request, watch) => raise(approvals(), request, watch),
    record: recordStandingDecision,
    reaskedHooks: () => approvals()?.reaskedHookRequests?.() ?? [],
    isReaskedHook: (request) =>
      approvals()?.isReaskedHook?.(hookProjectionBinding(request, true)) === true,
  };
}

/** Raise the card one ask names; the card's own promise, so its answer comes as soon as it does. */
function raise(
  approvals: AskApprovals | null | undefined,
  request: AskRequest,
  watch: AskWatch | undefined
): Promise<AskAnswer> {
  if (!approvals) return Promise.resolve({ outcome: 'unwired' });
  switch (request.kind) {
    case 'hook_projection':
      return raiseHookCard(approvals, request);
    case 'folder_allows':
      return raiseFolderAllowsCard(approvals, request.request);
    case 'folder_config':
      return raiseFolderConfigCard(approvals, request.request, watch);
    case 'repo_config':
      return raiseRepoConfigCard(approvals, request.request, watch);
  }
}

/**
 * Write one standing decision the computer reported.
 *
 * @param decision - The decision and why.
 */
export function recordStandingDecision(decision: StandingDecision): void {
  switch (decision.kind) {
    case 'folder_allows_approved':
      return recordFolderAllowApproval(decision, decision.reason);
    case 'folder_config_approved':
      return recordFolderConfigApproval(decision, decision.reason);
    case 'folder_config_repinned':
      repinFolderConfigPart(decision);
      return;
    case 'folder_configs_pinned':
      return markFolderConfigsPinned();
    case 'repo_config_approved':
      return recordRepoConfigApproval(decision.setting, decision.digest);
    case 'repo_baseline':
      return recordBaseline(decision.commonDir, decision.baseline);
    case 'repo_baselines_pinned':
      return markRepoBaselinesPinned();
    case 'hook_files_pinned':
      return pinLegacyHookApproval(decision.request);
    case 'workspace_hooks_approved':
      return recordApprovedEntry(decision.entry, "approving a worktree's workspace hooks");
  }
}

/** The approval service cards are raised through, once startup hands it over. */
let approvalsNow: AskApprovals | null = null;

/**
 * Hand the asks the approval primitive (the runtime starts before the approval
 * service exists, so this comes later in boot).
 *
 * @param next - The approval service, or `null` to stop asking (tests).
 */
export function setAskApprovals(next: AskApprovals | null): void {
  approvalsNow = next;
}

/** The asks port the computer side is handed, raising through {@link setAskApprovals}. */
export const computerAsks: ComputerAsks = createComputerAsks(() => approvalsNow);

/**
 * Describe the card ids the asks raise under, for an approval card's title and
 * tier. None is a capability anyone can invoke.
 *
 * @param capabilityId - The id `ApprovalService` is resolving.
 * @returns The descriptor, or `undefined` for any other id.
 */
export function describeComputerAskCapability(
  capabilityId: string
):
  | { title: string; tier: CapabilityTier; consequence?: string; titledPerRequest?: true }
  | undefined {
  return (
    describeHookProjectionCapability(capabilityId) ??
    describeFolderAllowCapability(capabilityId) ??
    describeFolderConfigCapability(capabilityId) ??
    describeRepoConfigCapability(capabilityId)
  );
}

export {
  describeFolderAllowCapability,
  describeFolderConfigCapability,
  describeHookProjectionCapability,
  describeRepoConfigCapability,
};
export {
  FOLDER_ALLOWS_CAPABILITY_ID,
  FOLDER_ALLOWS_CAPABILITY_TITLE,
  type FolderAllowApprovalGateway,
} from './folder-allows-card-ask.js';
export {
  FOLDER_CONFIG_CAPABILITY_ID,
  FOLDER_CONFIG_CAPABILITY_TITLE,
} from './folder-config-card-ask.js';
export {
  HOOK_PROJECTION_CAPABILITY_ID,
  HOOK_PROJECTION_CAPABILITY_TITLE,
  hookProjectionBinding,
  type HookApprovalGateway,
} from './hook-card-ask.js';
export {
  isRepoPinCapabilityId,
  REPO_CONFIG_CAPABILITY_IDS,
  REPO_TOOLS_CAPABILITY_ID,
  type RepoConfigApprovalGateway,
} from './repo-config-card-ask.js';
export {
  forgetApprovedEntries,
  recordApprovedEntry,
  recordHookApproval,
  recordHookRefusal,
  recordRefusedEntry,
  revokeHookDecisions,
  type RevokedHookDecision,
} from './hook-decisions.js';
export {
  recordFolderAllowApproval,
  recordFolderAllowRefusal,
  recordFolderConfigApproval,
  recordFolderConfigRefusal,
} from './folder-decisions.js';
export { recordRepoConfigApproval, recordRepoConfigRefusal } from './repo-decisions.js';
export { writeGlobalSharing } from './global-sharing.js';
