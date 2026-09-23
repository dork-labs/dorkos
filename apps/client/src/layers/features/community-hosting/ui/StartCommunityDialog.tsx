/**
 * "Start a community": name it, make it yours in the browser, connect this
 * DorkOS to it.
 *
 * @module features/community-hosting/ui/StartCommunityDialog
 */
import { useState, type FormEvent } from 'react';
import type { CloudCommunityAllowance } from '@dorkos/shared/cloud-schemas';
import { Button } from '@/layers/shared/ui';
import { allowanceCopy, readWebAddress } from '../model/hosting-copy';
import { useClaimAndConnect, type ClaimTarget } from '../model/use-claim-and-connect';
import {
  useStartCommunity,
  useWebAddressStatus,
  type StartFailure,
  type WebAddressStatus,
} from '../model/use-start-community';
import { claimConnectStep } from './claim-connect-step';
import { CommunityFields } from './community-fields';
import { HostingNoticeView, HostingStepDialog, type HostingStep } from './hosting-step';

/** What the start form's step needs. */
export interface StartFormStepProps {
  name: string;
  webAddress: string;
  onNameChange: (name: string) => void;
  onWebAddressChange: (webAddress: string) => void;
  webAddressStatus: WebAddressStatus;
  submitting: boolean;
  failure: StartFailure;
  allowance: CloudCommunityAllowance | null;
  formId: string;
  onSubmit: (event: FormEvent) => void;
  onCancel: () => void;
}

/**
 * Build the start form's step.
 *
 * @param props - The field values, what the service said, and the handlers.
 */
export function startFormStep(props: StartFormStepProps): HostingStep {
  const address = readWebAddress(props.webAddress);
  const blocked =
    props.name.trim() === '' ||
    !address.valid ||
    props.webAddressStatus.kind === 'taken' ||
    props.webAddressStatus.kind === 'reserved';
  const allowance = allowanceCopy(props.allowance);
  return {
    title: 'Start a community',
    description:
      'A place to share channels with people and agents. Your DorkOS account hosts it, and you own it.',
    body: (
      <form id={props.formId} onSubmit={props.onSubmit} className="space-y-4" noValidate>
        <CommunityFields
          name={props.name}
          onNameChange={props.onNameChange}
          webAddress={props.webAddress}
          onWebAddressChange={props.onWebAddressChange}
          webAddressStatus={props.webAddressStatus}
          webAddressError={props.failure.field}
          disabled={props.submitting}
        />
        {allowance && <p className="text-muted-foreground text-sm">{allowance}</p>}
        {props.failure.notice && <HostingNoticeView notice={props.failure.notice} />}
      </form>
    ),
    actions: (
      <>
        <Button type="button" variant="outline" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button type="submit" form={props.formId} disabled={blocked || props.submitting}>
          {props.submitting ? 'Starting…' : 'Start community'}
        </Button>
      </>
    ),
  };
}

/** Props for {@link StartCommunityDialog}. */
export interface StartCommunityDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What the new community will call this DorkOS. */
  installName: string;
  allowance: CloudCommunityAllowance | null;
  /** Runs once this DorkOS is connected to the new community, with its local ref. */
  onConnected: (ref: string) => void;
}

/** Start a hosted community from the switcher. Mounted only while linked. */
export function StartCommunityDialog(props: StartCommunityDialogProps) {
  return props.open ? <StartCommunityFlow {...props} /> : null;
}

/** The flow, mounted fresh for each open so nothing carries over. */
function StartCommunityFlow({
  open,
  onOpenChange,
  installName,
  allowance,
  onConnected,
}: StartCommunityDialogProps) {
  const [name, setName] = useState('');
  const [webAddress, setWebAddress] = useState('');
  const [target, setTarget] = useState<ClaimTarget | null>(null);
  const start = useStartCommunity();
  const status = useWebAddressStatus(target ? '' : webAddress);
  const claim = useClaimAndConnect(target, installName, onConnected);
  const close = () => onOpenChange(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const address = readWebAddress(webAddress);
    if (name.trim() === '' || !address.valid || start.submitting) return;
    const started = await start.submit({ name, shortName: address.value });
    if (started) {
      setTarget({
        communityId: started.community.communityId,
        name: started.community.name,
        communityUrl: started.community.communityUrl,
      });
    }
  }

  const step = target
    ? claimConnectStep({
        state: claim.state,
        name: target.name,
        doneDetail: 'Invite people from the community’s own settings when you’re ready.',
        onOpenClaim: claim.openClaim,
        onConfirmClaimed: claim.confirmClaimed,
        onOpenApproval: claim.openApproval,
        onRetryConnect: claim.retryConnect,
        onClose: close,
      })
    : startFormStep({
        name,
        webAddress,
        onNameChange: setName,
        onWebAddressChange: (next) => {
          setWebAddress(next);
          start.clearFieldFailure();
        },
        webAddressStatus: status,
        submitting: start.submitting,
        failure: start.failure,
        allowance,
        formId: 'start-community-form',
        onSubmit: (event) => void submit(event),
        onCancel: close,
      });

  return (
    <HostingStepDialog
      open={open}
      onOpenChange={onOpenChange}
      step={step}
      locked={start.submitting}
    />
  );
}
