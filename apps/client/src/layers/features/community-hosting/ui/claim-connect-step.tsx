/**
 * The claim and connect steps shared by starting and moving a community.
 *
 * @module features/community-hosting/ui/claim-connect-step
 */
import { CheckCircle2, ExternalLink } from 'lucide-react';
import { Button, Spinner } from '@/layers/shared/ui';
import type { ClaimConnectState } from '../model/use-claim-and-connect';
import { HostingNoticeView, type HostingStep } from './hosting-step';

/** What the claim and connect steps need. */
export interface ClaimConnectStepProps {
  state: ClaimConnectState;
  /** The community's name. */
  name: string;
  /** What the finished step says under its title. */
  doneDetail: string;
  onOpenClaim: () => void;
  onConfirmClaimed: () => void;
  onOpenApproval: () => void;
  onRetryConnect: () => void;
  onClose: () => void;
}

/**
 * Build the step for where claim and connect are.
 *
 * @param props - The state, the community's name and the handlers.
 */
export function claimConnectStep(props: ClaimConnectStepProps): HostingStep {
  const { state, name } = props;
  switch (state.kind) {
    case 'preparing':
      return {
        title: `Setting up ${name}`,
        description: 'This takes a moment. You can keep this open or come back later.',
        body: (
          <p role="status" className="text-muted-foreground flex items-center gap-2 text-sm">
            <Spinner className="size-4" /> Setting up…
          </p>
        ),
        actions: (
          <Button variant="outline" onClick={props.onClose}>
            Close
          </Button>
        ),
      };
    case 'claim':
      return {
        title: `Make ${name} yours`,
        description:
          'Finish in your browser. Sign in or create your account there, then come back.',
        body: state.notice ? <HostingNoticeView notice={state.notice} /> : undefined,
        actions: (
          <>
            <Button
              variant={state.opened ? 'outline' : 'default'}
              disabled={state.busy}
              onClick={props.onOpenClaim}
            >
              {state.opened ? 'Open it again' : 'Open in your browser'}
              <ExternalLink className="size-3.5" aria-hidden />
            </Button>
            {/* Always offered: a person who finished in an earlier visit, or
                whose browser opened without this app noticing, is not stuck. */}
            <Button
              variant={state.opened ? 'default' : 'outline'}
              disabled={state.busy}
              onClick={props.onConfirmClaimed}
            >
              {state.busy ? 'Checking…' : 'I’ve finished'}
            </Button>
          </>
        ),
      };
    case 'connecting':
      return {
        title: `Connect this DorkOS to ${name}`,
        description: state.approvalUrl
          ? `Approve this DorkOS on ${name}. This page moves on by itself once you do.`
          : 'Getting the approval page ready…',
        body: (
          <>
            {state.approvalUrl && !state.notice && (
              <p role="status" className="text-muted-foreground flex items-center gap-2 text-sm">
                <Spinner className="size-4" /> Waiting for your approval
              </p>
            )}
            {state.notice && <HostingNoticeView notice={state.notice} />}
          </>
        ),
        actions: state.notice ? (
          <Button disabled={state.busy} onClick={props.onRetryConnect}>
            Connect again
          </Button>
        ) : (
          <Button disabled={state.busy || !state.approvalUrl} onClick={props.onOpenApproval}>
            Open approval page
            <ExternalLink className="size-3.5" aria-hidden />
          </Button>
        ),
      };
    case 'done':
      return {
        title: `${name} is ready`,
        description: props.doneDetail,
        body: (
          <p className="flex items-center gap-2 text-sm">
            <CheckCircle2 className="text-status-success-fg size-4" aria-hidden />
            It’s selected in your community list.
          </p>
        ),
        actions: <Button onClick={props.onClose}>Done</Button>,
      };
  }
}
