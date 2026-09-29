/**
 * The Inbox's rows for installed extensions waiting to be turned on (DOR-2517).
 *
 * @module widgets/inbox-bell/ui/ExtensionApprovalList
 */
import { Puzzle } from 'lucide-react';
import type { PendingExtensionApproval } from '@dorkos/shared/extension-approval-schemas';
import {
  extensionConsentCopy,
  useExtensionApprovalActions,
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
      {approvals.map((approval) => (
        <InboxDecisionRow
          key={`${approval.id}:${approval.path}:${approval.version}`}
          icon={Puzzle}
          title={`Turn on ${approval.name}?`}
          why={approval.why}
          sourceLine={approval.sourceLabel}
          more={
            <>
              <p>{extensionConsentCopy(approval.runsInServer)}</p>
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
            onApprove: () => approve(copyOf(approval)),
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
      ))}
    </div>
  );
}
