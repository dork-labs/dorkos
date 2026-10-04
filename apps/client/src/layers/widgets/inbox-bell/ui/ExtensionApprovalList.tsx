/**
 * The Inbox's rows for installed extensions waiting to be turned on (DOR-2517).
 *
 * @module widgets/inbox-bell/ui/ExtensionApprovalList
 */
import { Puzzle } from 'lucide-react';
import type { PendingExtensionApproval } from '@dorkos/shared/extension-approval-schemas';
import {
  EXTENSION_TRUST_COPY,
  ExtensionAgentGifts,
  ExtensionPermissionLines,
  agentGiftsFromApproval,
  agentGiftsLine,
  approvedSetOf,
  extensionConsentCopy,
  permissionViewFromApproval,
  useExtensionApprovalActions,
  type ApproveExtensionInput,
  type ExtensionAnswerInput,
} from '@/layers/entities/extension';
import { InboxDecisionRow } from '@/layers/features/inbox';

/**
 * The exact copy a row shows, sent with either answer so the server acts only
 * on that copy. The list is read as the person, so `path` is always present.
 *
 * @param approval - The waiting extension.
 */
function copyOf(approval: PendingExtensionApproval): ExtensionAnswerInput {
  return {
    id: approval.id,
    name: approval.name,
    path: approval.path ?? '',
    version: approval.version,
    plugin: approval.plugin,
  };
}

/**
 * The copy a row shows plus the permission set it lists, sent with "Turn it
 * on" so a widening while the row was on screen is refused as stale rather
 * than approved on a yes given to the old lists (DOR-2686).
 *
 * @param approval - The waiting extension.
 */
function approvalOf(approval: PendingExtensionApproval): ApproveExtensionInput {
  const permissions = approvedSetOf(permissionViewFromApproval(approval));
  return { ...copyOf(approval), ...(permissions ? { permissions } : {}) };
}

/** Props for {@link ExtensionApprovalList}. */
export interface ExtensionApprovalListProps {
  /** The extensions waiting, oldest first. */
  approvals: readonly PendingExtensionApproval[];
  /** Open Settings → Extensions, closing the Inbox first. */
  onOpenSettings: () => void;
}

/**
 * One row per extension waiting to be turned on: "Turn on Flow?", the line
 * that says why, where it came from, and ⓘ 👎 👍.
 *
 * 👍 "Turn it on" is the same person-only approval the Settings card makes,
 * and the extension's tab appears with no reload. 👎 "Not now" removes,
 * disables and revokes nothing; the inbox just stops asking until the
 * extension's source or version changes. ⓘ opens the same consent sentence
 * the Settings card shows, and the way there.
 *
 * @param props - The waiting extensions and how to reach Settings.
 */
export function ExtensionApprovalList({ approvals, onOpenSettings }: ExtensionApprovalListProps) {
  const { approve, dismiss, pending } = useExtensionApprovalActions();
  if (approvals.length === 0) return null;

  return (
    <div data-slot="extension-approval-list" className="mt-2 flex flex-col gap-1">
      {approvals.map((approval) => {
        const gifts = agentGiftsFromApproval(approval);
        const giftsLine = agentGiftsLine(gifts);
        return (
          <InboxDecisionRow
            key={`${approval.id}:${approval.path}:${approval.version}`}
            icon={Puzzle}
            title={`Turn on ${approval.name}?`}
            why={approval.why}
            // What it gives agents, on the row itself, so it is read before the
            // yes; each tool and its tier is in the ⓘ panel (DOR-2685).
            {...(giftsLine ? { meta: giftsLine } : {})}
            // Where it runs and what it may reach, on the row itself, so the
            // yes is given to what it lists; a re-ask leads with what is new.
            // Nothing extra when the server sent no set (one version behind).
            {...(approval.permissions
              ? {
                  details: (
                    <ExtensionPermissionLines
                      permissions={permissionViewFromApproval(approval)}
                      added={approval.added}
                      data-testid={`extension-permissions-${approval.id}`}
                    />
                  ),
                }
              : {})}
            sourceLine={approval.sourceLabel}
            more={
              <>
                <ExtensionAgentGifts gifts={gifts} variant="list" />
                <p>
                  {extensionConsentCopy(
                    approval.runsInServer,
                    approval.permissions?.runtime === 'subprocess'
                  )}
                </p>
                <p>{EXTENSION_TRUST_COPY}</p>
                <p>
                  <button
                    type="button"
                    onClick={onOpenSettings}
                    className="text-foreground underline underline-offset-2"
                  >
                    See it in Settings → Extensions
                  </button>
                </p>
              </>
            }
            actions={{
              kind: 'yes-no',
              approveLabel: 'Turn it on',
              rejectLabel: 'Not now',
              onApprove: () => approve(approvalOf(approval)),
              onReject: () => dismiss(copyOf(approval)),
            }}
            pending={
              pending?.id === approval.id
                ? pending.action === 'approve'
                  ? 'approve'
                  : 'reject'
                : null
            }
          />
        );
      })}
    </div>
  );
}
