import { useId, useState } from 'react';
import { ArrowUpRight, ExternalLink, RefreshCw } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import type { ConnectorConnectionSummary } from '@dorkos/shared/connector-resource-schemas';
import {
  useConnectorAuthentication,
  useReconnectConnectorConnection,
  useResumeConnectorConnection,
  type ServiceLogo,
} from '@/layers/entities/connectors';
import { Button, ExternalLinkAnchor } from '@/layers/shared/ui';
import type { AccountAttention } from '../../lib/account-readiness';
import { AccessCardFrame } from '../access/AccessCardFrame';

interface AccountAttentionStepProps {
  /** The account that has to be fixed first. */
  account: ConnectorConnectionSummary;
  /** What it needs. */
  attention: AccountAttention;
  /** The app's display name. */
  serviceName: string;
  /** What the catalog says about the app's logo, when the caller has its entry. */
  logo?: ServiceLogo;
  /** The agent asking. */
  agentName: string;
  /** Answer "Not now". */
  onDecline: () => void;
  /** An answer is being saved. */
  deciding: boolean;
}

/** The plain sentence for what stands in the way. */
function attentionLine(
  attention: AccountAttention,
  serviceName: string,
  label: string,
  agentName: string
): string {
  switch (attention.kind) {
    case 'paused':
      return `Your ${serviceName} account (${label}) is paused. Resume it so ${agentName} can use it.`;
    case 'signed_out':
      return `You’re signed out of ${serviceName} (${label}). Sign in again so ${agentName} can use it.`;
    case 'needs_review':
      return `${serviceName} (${label}) needs a look on Connections before ${agentName} can use it.`;
  }
}

/**
 * The card's step when the app is connected but not usable right now: paused,
 * signed out, or waiting on a review of its actions. It asks for that one fix before any
 * Allow, because the server will not answer a request with an account an agent
 * could not use.
 */
export function AccountAttentionStep({
  account,
  attention,
  serviceName,
  logo,
  agentName,
  onDecline,
  deciding,
}: AccountAttentionStepProps) {
  const titleId = useId();
  const resume = useResumeConnectorConnection();
  const reconnect = useReconnectConnectorConnection();
  const [flowId, setFlowId] = useState<string | null>(null);
  const flow = useConnectorAuthentication(flowId);
  const authorizeUrl = flow.data?.state === 'pending' ? flow.data.authorizeUrl : undefined;
  const failed = resume.isError || reconnect.isError;

  return (
    <AccessCardFrame
      titleId={titleId}
      toolkit={account.toolkit}
      serviceName={serviceName}
      logo={logo}
      title={`Let ${agentName} use ${serviceName}?`}
      subtitle={account.label}
      className="max-w-xl"
    >
      <p className="text-sm" data-testid="account-attention" data-kind={attention.kind}>
        {attentionLine(attention, serviceName, account.label, agentName)}
      </p>
      {authorizeUrl && (
        <Button asChild className="w-full sm:w-auto">
          <ExternalLinkAnchor href={authorizeUrl}>
            Sign in to {serviceName}
            <ExternalLink className="size-4" aria-hidden />
          </ExternalLinkAnchor>
        </Button>
      )}
      {flowId && !authorizeUrl && flow.data?.state !== 'connected' && (
        <p className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
          <RefreshCw className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
          Getting the sign-in page ready…
        </p>
      )}
      {failed && (
        <p role="alert" className="text-destructive text-sm">
          That didn’t work. Nothing changed. Try again.
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" onClick={onDecline} disabled={deciding}>
          Not now
        </Button>
        {attention.kind === 'paused' && (
          <Button
            onClick={() => resume.mutate({ connectionId: account.connectionId, input: undefined })}
            disabled={resume.isPending}
          >
            {resume.isPending ? 'Resuming…' : 'Resume'}
          </Button>
        )}
        {attention.kind === 'signed_out' && !flowId && (
          <Button
            onClick={() =>
              reconnect.mutate(
                { connectionId: account.connectionId },
                { onSuccess: (result) => setFlowId(result.flowId) }
              )
            }
            disabled={reconnect.isPending}
          >
            Sign in again
          </Button>
        )}
        {attention.kind === 'needs_review' && (
          <Button asChild variant="secondary">
            <Link to="/connections">
              Open Connections
              <ArrowUpRight className="size-4" aria-hidden />
            </Link>
          </Button>
        )}
      </div>
    </AccessCardFrame>
  );
}
