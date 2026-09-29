import { useId, useState } from 'react';
import { ArrowUpRight, ExternalLink, RefreshCw } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import type { ConnectorConnectionSummary } from '@dorkos/shared/connector-resource-schemas';
import {
  useConnectorAuthentication,
  useReconnectConnectorConnection,
  useRecheckConnectorWays,
  useResumeConnectorConnection,
  type ServiceLogo,
} from '@/layers/entities/connectors';
import { useSettingsDeepLink } from '@/layers/shared/model';
import { Button, ExternalLinkAnchor } from '@/layers/shared/ui';
import { AccessCardFrame } from '../access/AccessCardFrame';

interface AccountAttentionStepProps {
  /** The account that has to be fixed first. Its `readiness` says what it needs. */
  account: ConnectorConnectionSummary;
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
  /** Connect the app again through any way that works, the one-time step first when none does. */
  onConnectAgain: () => void;
}

/** Sign-in flow states that ended without connecting. */
const ENDED_FLOW_STATES: ReadonlySet<string> = new Set(['failed', 'expired', 'start_unknown']);

/**
 * The card's step when the app is connected but not usable right now. It
 * shows the server's own line for what stands in the way and the one control
 * for its fix (`readiness.fix`), before any Allow: the server will not answer
 * a request with an account an agent could not use. A fix that is DorkOS's
 * to make, or that nobody can make from here, offers only "Not now".
 */
export function AccountAttentionStep({
  account,
  serviceName,
  logo,
  agentName,
  onDecline,
  deciding,
  onConnectAgain,
}: AccountAttentionStepProps) {
  const titleId = useId();
  const settings = useSettingsDeepLink();
  const resume = useResumeConnectorConnection();
  const reconnect = useReconnectConnectorConnection();
  // Asks the server to try the DorkOS account's route again, then re-reads.
  const recheck = useRecheckConnectorWays();
  const [flowId, setFlowId] = useState<string | null>(null);
  const flow = useConnectorAuthentication(flowId);
  const flowState = flow.data?.state;
  // A sign-in that ended without connecting is a failure to say, never a
  // spinner that turns forever; "Sign in again" comes back with it.
  const flowEnded = flowState !== undefined && ENDED_FLOW_STATES.has(flowState);
  const authorizeUrl = flow.data?.state === 'pending' ? flow.data.authorizeUrl : undefined;
  const failed = resume.isError || reconnect.isError || flowEnded;
  const action = account.readiness.fix?.action;

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
      <p className="text-sm" data-testid="account-attention" data-reason={account.readiness.reason}>
        {account.readiness.copy.owner}
      </p>
      {authorizeUrl && (
        <Button asChild className="w-full sm:w-auto">
          <ExternalLinkAnchor href={authorizeUrl}>
            Sign in to {serviceName}
            <ExternalLink className="size-4" aria-hidden />
          </ExternalLinkAnchor>
        </Button>
      )}
      {flowId && !authorizeUrl && !flowEnded && flowState !== 'connected' && (
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
        {action === 'resume' && (
          <Button
            onClick={() => resume.mutate({ connectionId: account.connectionId, input: undefined })}
            disabled={resume.isPending}
          >
            {resume.isPending ? 'Resuming…' : 'Resume'}
          </Button>
        )}
        {action === 'sign_in_again' && (!flowId || flowEnded) && (
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
        {action === 'retry' && (
          <Button variant="secondary" onClick={() => recheck.mutate()} disabled={recheck.isPending}>
            {recheck.isPending ? 'Checking…' : 'Check again'}
          </Button>
        )}
        {action === 'fix_key' && (
          <Button variant="secondary" onClick={() => settings.open('connections', 'ways')}>
            Fix the key
          </Button>
        )}
        {action === 'connect_new' && (
          <Button onClick={onConnectAgain}>Connect {serviceName} again</Button>
        )}
        {action === 'review_access' && (
          <Button asChild variant="secondary">
            <Link to="/connections" search={{ app: account.connectionId }}>
              Open Connections
              <ArrowUpRight className="size-4" aria-hidden />
            </Link>
          </Button>
        )}
      </div>
    </AccessCardFrame>
  );
}
