/**
 * The Inbox's rows for installed extensions waiting to be turned on (DOR-2517).
 *
 * @module widgets/inbox-bell/ui/ExtensionApprovalList
 */
import { Puzzle } from 'lucide-react';
import type { PendingExtensionApproval } from '@dorkos/shared/extension-approval-schemas';
import {
  ACCESS_FACT_LINE_KEYS,
  EXTENSION_TRUST_COPY,
  ExtensionAccessFacts,
  ExtensionAgentGifts,
  ExtensionPermissionLines,
  agentGiftsFromApproval,
  approvalChangeLine,
  agentGiftsLine,
  approvedSetOf,
  extensionConsentCopy,
  isChangedSinceAllowed,
  permissionViewFromApproval,
  useAddedSinceSeen,
  useExtensionApprovalActions,
  type ApproveExtensionInput,
  type ExtensionAnswerInput,
} from '@/layers/entities/extension';
import { InboxDecisionRow } from '@/layers/features/inbox';
import { DecisionFrame } from './ExtensionDecisionList';

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
  return {
    ...copyOf(approval),
    ...(permissions ? { permissions } : {}),
    // The files the row showed: an edit after it was drawn is refused as stale.
    ...(approval.digest ? { expectedDigest: approval.digest } : {}),
  };
}

/**
 * What a waiting extension can reach, leading with what is new: since the
 * person's last approval (the server's `added`), or, on a first ask whose yes
 * was just refused as stale, since the card they saw (DOR-2686).
 *
 * A first run leads with Access, Runs as and Network, one line each, and the
 * list under them leaves out what those three already said.
 *
 * @param props - The waiting extension, and whether to lead with the facts.
 */
function ApprovalPermissionLines({
  approval,
  withFacts,
}: {
  approval: PendingExtensionApproval;
  withFacts: boolean;
}) {
  const view = permissionViewFromApproval(approval);
  const sinceSeen = useAddedSinceSeen(approval.id, approvedSetOf(view));
  if (!view) return null;
  return (
    <div className="space-y-1.5">
      {withFacts && (
        <ExtensionAccessFacts
          permissions={view}
          data-testid={`extension-access-facts-${approval.id}`}
        />
      )}
      <ExtensionPermissionLines
        permissions={view}
        added={approval.added ?? sinceSeen}
        {...(withFacts ? { omit: ACCESS_FACT_LINE_KEYS } : {})}
        data-testid={`extension-permissions-${approval.id}`}
      />
    </div>
  );
}

/** Props for {@link ExtensionApprovalList}. */
export interface ExtensionApprovalListProps {
  /** The extensions waiting, oldest first. */
  approvals: readonly PendingExtensionApproval[];
  /** Open Settings → Extensions, closing the Inbox first. */
  onOpenSettings: () => void;
  /**
   * The extension id a link asked the Inbox to single out — a held app's tile,
   * pinned row or ⌘K item (DOR-3970). Its row is ringed, scrolled to and
   * focused; it never approves anything.
   */
  focusId?: string;
  /** Focus left the singled-out row. */
  onFocusSpent?: () => void;
}

/** The sentence the server ends every why line with. */
const RUNS_AS_YOU_TAIL = / ?It runs as you\.$/;

/**
 * The row's words, as Security wrote them (Nov 8). A copy allowed before whose
 * files changed says so, with what changed and when; a first run asks to run.
 *
 * @param approval - The waiting copy.
 */
function wordsOf(approval: PendingExtensionApproval) {
  if (isChangedSinceAllowed(approval)) {
    return {
      changed: true,
      title: `${approval.name}’s files changed since you allowed it. Its screens are paused until you look.`,
      why: approvalChangeLine(approval),
      approveLabel: 'Allow the new version',
      rejectLabel: 'Keep paused',
    };
  }
  return {
    changed: false,
    title: `${approval.name} wants to run on this computer.`,
    // The server ends every why line with "It runs as you."; the Runs as line
    // already says so, so the card does not say it twice.
    why: approval.permissions ? approval.why.replace(RUNS_AS_YOU_TAIL, '') : approval.why,
    approveLabel: 'Allow',
    rejectLabel: 'Not now',
  };
}

/**
 * One row per extension waiting to run: "Flow wants to run on this computer.",
 * Access, Runs as and Network, where it came from, and ⓘ 👎 👍. A copy whose
 * files changed since it was allowed says so instead, with what changed and
 * when, and asks to allow the new version.
 *
 * 👍 "Allow" is the same person-only approval the Settings card makes, and
 * the extension's tab appears with no reload. 👎 "Not now" removes,
 * disables and revokes nothing; the inbox just stops asking until the
 * extension's source or version changes. ⓘ opens the same consent sentence
 * the Settings card shows, and the way there.
 *
 * @param props - The waiting extensions and how to reach Settings.
 */
export function ExtensionApprovalList({
  approvals,
  onOpenSettings,
  focusId,
  onFocusSpent,
}: ExtensionApprovalListProps) {
  const { approve, dismiss, pending } = useExtensionApprovalActions();
  if (approvals.length === 0) return null;

  return (
    <div data-slot="extension-approval-list" className="mt-2 flex flex-col gap-1">
      {approvals.map((approval) => {
        const gifts = agentGiftsFromApproval(approval);
        const giftsLine = agentGiftsLine(gifts);
        const words = wordsOf(approval);
        // A changed copy leads with what changed; its reach moves behind ⓘ
        // unless it reaches further than before, which is read before the yes.
        const reachUpFront = !words.changed || approval.added !== null;
        const reach = approval.permissions ? (
          <ApprovalPermissionLines approval={approval} withFacts={!words.changed} />
        ) : null;
        return (
          <DecisionFrame
            key={`${approval.id}:${approval.path}:${approval.version}`}
            decisionId={approval.id}
            focused={approval.id === focusId}
            {...(onFocusSpent ? { onFocusSpent } : {})}
          >
            {(titleId) => (
              <InboxDecisionRow
                titleId={titleId}
                icon={Puzzle}
                title={words.title}
                why={words.why}
                // What it gives agents, on the row itself, so it is read before the
                // yes; each tool and its tier is in the ⓘ panel (DOR-2685).
                {...(giftsLine ? { meta: giftsLine } : {})}
                // Where it runs and what it may reach, on the row itself, so the
                // yes is given to what it lists; a re-ask leads with what is new.
                // Nothing extra when the server sent no set (one version behind).
                {...(reach && reachUpFront ? { details: reach } : {})}
                sourceLine={approval.sourceLabel}
                more={
                  <>
                    {reach && !reachUpFront && reach}
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
                  // Worded buttons under the card, like the Settings rows.
                  words: true,
                  approveLabel: words.approveLabel,
                  rejectLabel: words.rejectLabel,
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
            )}
          </DecisionFrame>
        );
      })}
    </div>
  );
}
