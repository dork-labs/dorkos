/**
 * "Hosted communities": every community this account hosts, what state each
 * is in, and the ways out of a hold, plus recent moves.
 *
 * @module features/community-hosting/ui/HostedCommunitiesDialog
 */
import { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import type { HostedCommunity } from '@dork-labs/cloud-api';
import type { CloudCommunityMove } from '@dorkos/shared/cloud-schemas';
import { openExternalLink } from '@/layers/shared/lib';
import { Badge, Button } from '@/layers/shared/ui';
import {
  allowanceCopy,
  communityStateLabel,
  formatBytes,
  formatDay,
  holdReasonCopy,
  moveFailureCopy,
} from '../model/hosting-copy';
import { useHostedCommunities } from '../model/hosted-communities';
import { useClaimAndConnect } from '../model/use-claim-and-connect';
import {
  useHostedCommunityActions,
  type HostedCommunityActions,
} from '../model/use-hosted-community-actions';
import { claimConnectStep } from './claim-connect-step';
import { HostingNoticeView, HostingStepDialog, type HostingStep } from './hosting-step';

/** What one community row needs from the list around it. */
interface RowProps {
  community: HostedCommunity;
  /** Names of the account's communities, by id, for the keep preview. */
  names: Map<string, string>;
  actions: Pick<
    HostedCommunityActions,
    'confirmingKeep' | 'busyId' | 'notices' | 'askKeep' | 'cancelKeep' | 'keep' | 'restore'
  >;
  onFinishSetup: (community: HostedCommunity) => void;
  onOpenMove: (moveId: string) => void;
}

/** "12 of 200 people · 48 MB of 2 GB", or `null` before the first measurement. */
function usageLine(community: HostedCommunity): string | null {
  const usage = community.usage;
  if (!usage) return null;
  const { maxActiveMembers, maxStorageBytes } = community.limits;
  const people = `${usage.activeMembers.toLocaleString()}${
    maxActiveMembers !== null ? ` of ${maxActiveMembers.toLocaleString()}` : ''
  } ${usage.activeMembers === 1 && maxActiveMembers === null ? 'person' : 'people'}`;
  const files = `${formatBytes(usage.storageBytes)}${
    maxStorageBytes !== null ? ` of ${formatBytes(maxStorageBytes)}` : ''
  } of files`;
  return `${people} · ${files}`;
}

/** One hosted community: its state, why, and what the owner can do. */
function HostedCommunityRow({ community, names, actions, onFinishSetup, onOpenMove }: RowProps) {
  const busy = actions.busyId === community.communityId;
  const confirming = actions.confirmingKeep === community.communityId;
  const notice = actions.notices[community.communityId];
  const usage = usageLine(community);
  const wouldHold = community.actions.keep.wouldHold.map(
    (id) => names.get(id) ?? 'another community'
  );
  const attention =
    community.state === 'held' ||
    community.state === 'deletion_pending' ||
    community.state === 'suspended';
  return (
    <li className="space-y-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{community.name}</p>
          {community.shortName && (
            <p className="text-muted-foreground truncate font-mono text-xs">
              {community.shortName}
            </p>
          )}
        </div>
        <Badge
          variant={attention ? 'outline' : 'secondary'}
          className={
            attention ? 'border-status-warning-border text-status-warning-fg shrink-0' : 'shrink-0'
          }
        >
          {communityStateLabel(community.state)}
        </Badge>
      </div>
      {community.state === 'unrecognised' && (
        <p className="text-muted-foreground text-sm">
          This community is in a state this version of DorkOS doesn’t know. Update DorkOS to see
          more.
        </p>
      )}
      {community.hold && (
        <div className="space-y-1 text-sm">
          <p>{holdReasonCopy(community.hold.reason)}</p>
          <p className="text-muted-foreground">On hold since {formatDay(community.hold.since)}.</p>
          {community.hold.deletionNoticeAt && (
            <p className="text-destructive">
              The host may delete it after {formatDay(community.hold.deletionNoticeAt)}. You can
              export it until then.
            </p>
          )}
        </div>
      )}
      {community.deletionAt && (
        <p className="text-destructive text-sm">
          It will be deleted for good on {formatDay(community.deletionAt)}.
        </p>
      )}
      {community.notice && (
        <div className="bg-muted/50 space-y-1 rounded-md p-2 text-sm">
          <p className="font-medium break-words">{community.notice.title}</p>
          {community.notice.detail && <p className="break-words">{community.notice.detail}</p>}
          {community.notice.actionUrl && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => openExternalLink(community.notice!.actionUrl!)}
            >
              {community.notice.actionLabel ?? 'Learn more'}
              <ExternalLink className="size-3.5" aria-hidden />
            </Button>
          )}
        </div>
      )}
      {usage && <p className="text-muted-foreground text-xs tabular-nums">{usage}</p>}
      {confirming && (
        <div role="group" aria-label={`Keep ${community.name} open`} className="space-y-2 text-sm">
          <p>
            {wouldHold.length === 0
              ? `Keep ${community.name} open? Nothing else changes.`
              : `Keeping ${community.name} open puts ${wouldHold.length === 1 ? 'this one' : 'these'} on hold: ${wouldHold.join(', ')}. People can still read ${wouldHold.length === 1 ? 'it' : 'them'}.`}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={actions.cancelKeep}>
              Not now
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void actions.keep(community)}>
              Keep it open
            </Button>
          </div>
        </div>
      )}
      {notice && <HostingNoticeView notice={notice} />}
      {!confirming && (
        <div className="flex flex-wrap gap-2">
          {community.actions.claimLink && (
            <Button size="sm" onClick={() => onFinishSetup(community)}>
              Finish setting up
            </Button>
          )}
          {community.moveId && (
            <Button size="sm" variant="outline" onClick={() => onOpenMove(community.moveId!)}>
              See the move
            </Button>
          )}
          {community.actions.keep.allowed && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => actions.askKeep(community.communityId)}
            >
              Keep this one open
            </Button>
          )}
          {community.actions.restore && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void actions.restore(community)}
            >
              {busy ? 'Reopening…' : 'Reopen'}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

/** One line about a recent move. */
function moveLine(move: CloudCommunityMove): { text: string; next?: string } {
  switch (move.state) {
    case 'awaiting_upload':
      return { text: 'Uploading the export' };
    case 'importing':
      return { text: 'Moving the history' };
    case 'ready':
      return { text: 'Ready for you to make it yours' };
    case 'claimed':
      return { text: 'Moved' };
    case 'cancelled':
      return { text: 'Cancelled' };
    case 'failed': {
      const copy = moveFailureCopy(move.failureCode ?? 'unrecognised');
      return { text: copy.title, next: copy.next };
    }
    default:
      return { text: 'In a state this version of DorkOS doesn’t know' };
  }
}

/** Props for {@link HostedCommunityList}. */
export interface HostedCommunityListProps {
  communities: HostedCommunity[];
  moves: CloudCommunityMove[];
  allowanceText: string | null;
  actions: RowProps['actions'];
  onFinishSetup: (community: HostedCommunity) => void;
  onOpenMove: (moveId: string) => void;
}

/** The account's hosted communities and recent moves. */
export function HostedCommunityList(props: HostedCommunityListProps) {
  const names = new Map(props.communities.map((c) => [c.communityId, c.name]));
  return (
    <div className="space-y-4">
      {props.allowanceText && (
        <p className="text-muted-foreground text-sm">{props.allowanceText}</p>
      )}
      {props.communities.length > 0 ? (
        <ul className="space-y-2">
          {props.communities.map((community) => (
            <HostedCommunityRow
              key={community.communityId}
              community={community}
              names={names}
              actions={props.actions}
              onFinishSetup={props.onFinishSetup}
              onOpenMove={props.onOpenMove}
            />
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-sm">You don’t host any communities yet.</p>
      )}
      {props.moves.length > 0 && (
        <section aria-labelledby="hosted-moves" className="space-y-2">
          <h4 id="hosted-moves" className="text-sm font-medium">
            Recent moves
          </h4>
          <ul className="space-y-2">
            {props.moves.map((move) => {
              const line = moveLine(move);
              const open =
                move.state === 'awaiting_upload' ||
                move.state === 'importing' ||
                move.state === 'ready';
              return (
                <li
                  key={move.moveId}
                  className="flex flex-wrap items-start justify-between gap-2 rounded-lg border p-3"
                >
                  <div className="min-w-0 space-y-0.5 text-sm">
                    <p className="truncate font-medium">{move.name}</p>
                    <p
                      className={
                        move.state === 'failed' ? 'text-destructive' : 'text-muted-foreground'
                      }
                    >
                      {line.text}
                    </p>
                    {line.next && <p className="text-muted-foreground">{line.next}</p>}
                  </div>
                  {open && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => props.onOpenMove(move.moveId)}
                    >
                      Continue
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

/** Props for {@link HostedCommunitiesDialog}. */
export interface HostedCommunitiesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  installName: string;
  /** Open the move dialog on one move. */
  onOpenMove: (moveId: string) => void;
  onConnected: (ref: string) => void;
}

/** The hosted-community list, and claiming one that waits for its owner. */
export function HostedCommunitiesDialog(props: HostedCommunitiesDialogProps) {
  return props.open ? <HostedCommunitiesFlow {...props} /> : null;
}

function HostedCommunitiesFlow({
  open,
  onOpenChange,
  installName,
  onOpenMove,
  onConnected,
}: HostedCommunitiesDialogProps) {
  const list = useHostedCommunities(true);
  const actions = useHostedCommunityActions();
  const [claiming, setClaiming] = useState<HostedCommunity | null>(null);
  const claim = useClaimAndConnect(claiming, installName, onConnected);
  const close = () => onOpenChange(false);

  let step: HostingStep;
  if (claiming) {
    step = claimConnectStep({
      state: claim.state,
      name: claiming.name,
      doneDetail: 'Invite people from the community’s own settings when you’re ready.',
      onOpenClaim: claim.openClaim,
      onConfirmClaimed: claim.confirmClaimed,
      onOpenApproval: claim.openApproval,
      onRetryConnect: claim.retryConnect,
      onClose: close,
    });
  } else {
    const data = list.data?.available === true ? list.data : null;
    step = {
      title: 'Hosted communities',
      description: 'The communities your DorkOS account hosts.',
      body: list.isPending ? (
        <p className="text-muted-foreground text-sm">Loading…</p>
      ) : data ? (
        <HostedCommunityList
          communities={data.communities}
          moves={data.moves}
          allowanceText={allowanceCopy(data.allowance)}
          actions={actions}
          onFinishSetup={setClaiming}
          onOpenMove={(moveId) => {
            close();
            onOpenMove(moveId);
          }}
        />
      ) : (
        <HostingNoticeView notice={{ message: 'Couldn’t reach your DorkOS account. Try again.' }} />
      ),
      actions: (
        <Button variant="outline" onClick={close}>
          Close
        </Button>
      ),
    };
  }
  return <HostingStepDialog open={open} onOpenChange={onOpenChange} step={step} />;
}
