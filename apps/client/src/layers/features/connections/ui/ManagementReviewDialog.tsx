import { useMemo, useState } from 'react';
import { ExternalLink, ShieldAlert } from 'lucide-react';
import {
  CONNECTION_STATUS_LABELS,
  OPERATION_CLASSIFICATION_LABELS,
  type ConnectorManagementReviewContext,
  type ConnectorManagementReviewItem,
} from '@dorkos/shared/connector-schemas';
import {
  serviceName,
  useConnectorManagementReview,
  useConnectorReviewAuthentication,
  useResolveConnectorManagementReview,
} from '@/layers/entities/connectors';
import {
  Badge,
  Button,
  ExternalLinkAnchor,
  QueryErrorState,
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  Skeleton,
} from '@/layers/shared/ui';
import {
  managementOperationLabel,
  presentManagementReview,
} from '../lib/management-review-presentation';
import { olderVersionIds } from '../lib/older-versions';

/**
 * A tool or program's request to change a connection, with the owner's
 * decision. Opened from the page's "Needs you" strip or a `?review=` deep link.
 */
export function ManagementReviewDialog({
  reviewRequestId,
  open,
  onOpenChange,
  onCloseAutoFocus,
}: {
  /** The request to show. */
  reviewRequestId: string | null;
  /** Whether the dialog is open. */
  open: boolean;
  /** Close the dialog. */
  onOpenChange: (open: boolean) => void;
  /**
   * Where focus goes once the dialog closes. The opener can be gone by then
   * (a decided request leaves the "Needs you" strip), so the page decides.
   */
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const reviewQuery = useConnectorManagementReview(reviewRequestId);
  const resolve = useResolveConnectorManagementReview();
  const [authenticationOpened, setAuthenticationOpened] = useState(false);
  const [decisionUncertain, setDecisionUncertain] = useState(false);
  const review = reviewQuery.data;
  const authentication =
    review?.state === 'approved' && review.resolution.kind === 'connect_authentication_required'
      ? review.resolution.authentication
      : null;
  // Terminal durable flows omit their obsolete sign-in URL. Read their status
  // immediately after reopening instead of asking the owner to sign in again.
  const checkAuthentication =
    authenticationOpened || Boolean(authentication && !authentication.authorizeUrl);
  const poll = useConnectorReviewAuthentication(
    authentication?.flowId ?? null,
    checkAuthentication
  );
  const authenticationState = poll.isError
    ? 'check_failed'
    : (poll.data?.state ?? (checkAuthentication ? 'checking' : 'required'));
  const presentation = useMemo(() => (review ? presentManagementReview(review) : null), [review]);

  const decide = (decision: 'approved' | 'denied') => {
    if (!reviewRequestId || decisionUncertain) return;
    resolve.mutate(
      { reviewRequestId, decision },
      {
        onError: () => {
          // The server may have committed before the response was lost. Stop
          // here and require a fresh durable read; never replay a decision.
          setDecisionUncertain(true);
        },
      }
    );
  };

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent
        data-testid="connector-review-dialog"
        onCloseAutoFocus={onCloseAutoFocus}
        className="max-h-[90vh] sm:max-w-xl [&>[data-slot=dialog-content-close]]:absolute [&>[data-slot=dialog-content-close]]:top-4 [&>[data-slot=dialog-content-close]]:right-4 [&>[data-slot=dialog-content-close]]:m-0 [&>[data-slot=dialog-content-close]]:opacity-100"
      >
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {presentation?.title ?? 'Review connection request'}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription className="text-foreground">
            Check the account, agent, and exact actions before deciding.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody className="space-y-4 pb-4">
          {reviewQuery.isLoading ? (
            <Skeleton className="h-48 rounded-lg" />
          ) : reviewQuery.isError ? (
            <QueryErrorState
              title="Couldn’t load this request"
              description="It may have expired or belong to another signed-in owner."
              onRetry={() => void reviewQuery.refetch()}
              isRetrying={reviewQuery.isFetching}
            />
          ) : review && presentation ? (
            <>
              <ReviewContext context={review.context} />
              {review.targetStatus === 'unavailable' && review.state === 'pending' && (
                <div className="border-status-warning/30 bg-status-warning/5 flex gap-3 rounded-lg border p-3">
                  <ShieldAlert
                    className="text-status-warning-dot mt-0.5 size-4 shrink-0"
                    aria-hidden
                  />
                  <div>
                    <p className="text-sm font-medium">This request can’t be approved</p>
                    <p className="text-muted-foreground mt-1 text-sm">
                      The account, the agent or how DorkOS reaches the app changed after this
                      request was made. You can still deny it.
                    </p>
                  </div>
                </div>
              )}
              {review.state !== 'pending' && <ReviewOutcome review={review} />}
              {decisionUncertain && (
                <div
                  role="alert"
                  className="border-destructive/30 bg-destructive/5 rounded-lg border p-3"
                >
                  <p className="text-sm font-medium">We couldn’t confirm your decision</p>
                  <p className="text-muted-foreground mt-1 text-sm">
                    Reload the request to check what the server recorded before deciding again.
                  </p>
                </div>
              )}
              {authentication && (
                <div aria-live="polite" className="space-y-3 rounded-lg border p-4">
                  <p className="text-sm font-medium">
                    {authenticationState === 'connected'
                      ? 'Account connected'
                      : authenticationState === 'failed' ||
                          authenticationState === 'expired' ||
                          authenticationState === 'start_unknown'
                        ? 'Sign-in didn’t finish'
                        : authenticationState === 'pending' || authenticationState === 'starting'
                          ? 'Waiting for sign-in'
                          : authenticationState === 'checking'
                            ? 'Checking sign-in'
                            : authenticationState === 'check_failed'
                              ? 'Couldn’t check sign-in'
                              : 'Sign-in still required'}
                  </p>
                  <p className="text-muted-foreground text-sm">
                    {authenticationState === 'connected'
                      ? 'Sign-in finished and the account is ready.'
                      : authenticationState === 'expired'
                        ? 'The sign-in took too long and ended. You can connect it yourself on the Connections page.'
                        : authenticationState === 'start_unknown'
                          ? 'DorkOS couldn’t tell whether the sign-in started. You can connect it yourself on the Connections page.'
                          : authenticationState === 'failed'
                            ? 'Sign-in didn’t finish. You can connect it yourself on the Connections page.'
                            : authenticationState === 'pending' ||
                                authenticationState === 'starting' ||
                                authenticationState === 'checking'
                              ? 'Finish signing in to the service. This page will update when the account is ready.'
                              : authenticationState === 'check_failed'
                                ? 'The account may still be connected. Check again before starting another request.'
                                : 'Approval did not connect an account. Continue to the service and finish signing in.'}
                  </p>
                  {authenticationState === 'check_failed' ? (
                    <Button onClick={() => void poll.refetch()} disabled={poll.isFetching}>
                      {poll.isFetching ? 'Checking…' : 'Check again'}
                    </Button>
                  ) : authenticationState !== 'connected' &&
                    authenticationState !== 'failed' &&
                    authenticationState !== 'expired' &&
                    authenticationState !== 'start_unknown' &&
                    authentication.authorizeUrl ? (
                    <Button asChild>
                      {/* Same seam as every other supplied URL, and the
                          "they opened it" flag is set only if it really left —
                          a refusal must not read as progress (DOR-924). */}
                      <ExternalLinkAnchor
                        href={authentication.authorizeUrl}
                        onOpened={() => setAuthenticationOpened(true)}
                      >
                        Continue to sign in
                        <ExternalLink className="size-4" aria-hidden />
                      </ExternalLinkAnchor>
                    </Button>
                  ) : authenticationState === 'required' ? (
                    <Button onClick={() => setAuthenticationOpened(true)}>Check connection</Button>
                  ) : null}
                </div>
              )}
            </>
          ) : null}
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter>
          {review?.state === 'pending' && decisionUncertain ? (
            <Button
              onClick={() => {
                void reviewQuery.refetch().then((result) => {
                  if (!result.isError) {
                    setDecisionUncertain(false);
                    resolve.reset();
                  }
                });
              }}
              disabled={reviewQuery.isFetching}
            >
              {reviewQuery.isFetching ? 'Reloading request…' : 'Reload request'}
            </Button>
          ) : review?.state === 'pending' ? (
            <>
              <Button
                variant="outline"
                onClick={() => decide('denied')}
                disabled={resolve.isPending}
              >
                Deny
              </Button>
              {review.targetStatus === 'available' && review.context.kind !== 'unavailable' && (
                <Button onClick={() => decide('approved')} disabled={resolve.isPending}>
                  {resolve.isPending ? 'Saving decision…' : presentation?.approveLabel}
                </Button>
              )}
            </>
          ) : (
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          )}
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

function ReviewContext({ context }: { context: ConnectorManagementReviewContext }) {
  if (context.kind === 'unavailable') {
    return (
      <p className="text-muted-foreground rounded-lg border p-4 text-sm">
        This older request does not have enough verified detail to approve safely.
      </p>
    );
  }
  if (context.kind === 'connect') {
    return (
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-lg border p-4 text-sm">
        <dt>App</dt>
        <dd className="font-medium">{serviceName(context.toolkit)}</dd>
        <dt>Connected through</dt>
        <dd>{context.providerDisplayName}</dd>
        {context.label && (
          <>
            <dt>Label</dt>
            <dd>{context.label}</dd>
          </>
        )}
      </dl>
    );
  }
  const operations =
    context.kind === 'set_agent_access'
      ? context.requestedOperations
      : context.kind === 'remove_agent_access' || context.kind === 'disconnect'
        ? context.affectedOperations
        : [];
  const older = olderVersionIds(operations);
  const agent =
    context.kind === 'set_agent_access' || context.kind === 'remove_agent_access'
      ? context.agent
      : null;
  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-lg border p-4 text-sm">
        <dt>Account</dt>
        <dd className="font-medium">{context.connection.label}</dd>
        <dt>App</dt>
        <dd>{serviceName(context.connection.toolkit)}</dd>
        <dt>Status</dt>
        <dd>{CONNECTION_STATUS_LABELS[context.connection.status]}</dd>
        <dt>Sign-in</dt>
        <dd data-testid="connector-review-custody">{custodyDescription(context.connection)}</dd>
        {agent && (
          <>
            <dt>Agent</dt>
            <dd>{agent.displayName}</dd>
          </>
        )}
      </dl>
      {context.kind === 'disconnect' && (
        <p data-testid="connector-review-impact" className="text-sm font-medium">
          {context.everyAgent
            ? 'This will remove this account from every agent. It is shared with every agent now.'
            : `This will remove this account from ${context.affectedAgentCount} ${
                context.affectedAgentCount === 1 ? 'agent' : 'agents'
              }.`}
        </p>
      )}
      {context.kind === 'remove_agent_access' && context.keptThroughEveryAgent.length > 0 && (
        <p
          role="note"
          data-testid="connector-review-every-agent-kept"
          className="bg-muted/40 rounded-lg p-3 text-sm"
        >
          {context.agent.displayName} keeps {context.keptThroughEveryAgent.length}{' '}
          {context.keptThroughEveryAgent.length === 1 ? 'action' : 'actions'} on{' '}
          {context.connection.label}, because this account is shared with every agent. Approving
          removes only what was given to {context.agent.displayName} by name. To take it all away,
          stop sharing {context.connection.label} with every agent in Connections.
        </p>
      )}
      {operations.length > 0 && (
        <div>
          <p className="mb-2 text-sm font-medium">Exact actions</p>
          <ul className="space-y-2">
            {operations.map((operation) => (
              <li
                key={operation.operationRevisionId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2"
              >
                <span className="text-sm">
                  {managementOperationLabel(operation.operationSlug)}
                  {older.has(operation.operationRevisionId) && (
                    <span className="text-muted-foreground ml-2 text-xs">Older version</span>
                  )}
                </span>
                <Badge
                  size="xs"
                  variant={
                    operation.capabilityClassification === 'destructive'
                      ? 'destructive'
                      : 'secondary'
                  }
                >
                  {OPERATION_CLASSIFICATION_LABELS[operation.capabilityClassification]}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function custodyDescription(
  connection: Extract<ConnectorManagementReviewContext, { connection: unknown }>['connection']
): string {
  switch (connection.custody) {
    case 'managed':
      return 'Kept in Composio’s vault';
    case 'self-host':
      return 'Kept on your own Nango server';
    case 'external':
      return 'Handled by the app’s own server';
  }
}

function ReviewOutcome({ review }: { review: ConnectorManagementReviewItem }) {
  if (review.state === 'pending') return null;
  if (review.state === 'resolving') {
    return (
      <div
        data-testid="connector-review-outcome"
        data-outcome="resolving"
        className="bg-muted/40 rounded-lg border p-4"
      >
        <p className="text-sm font-medium">Applying change</p>
        <p className="text-muted-foreground mt-1 text-sm">
          This request is still being applied. Check again before making another change.
        </p>
      </div>
    );
  }
  const label =
    review.state === 'denied'
      ? 'Denied'
      : review.state === 'expired'
        ? 'Expired'
        : review.resolution.kind === 'applied'
          ? 'Approved and applied'
          : review.resolution.kind === 'outcome_unknown'
            ? 'Outcome unknown'
            : 'Approved';
  const description =
    review.state === 'expired'
      ? 'This request can no longer change access.'
      : review.state === 'denied'
        ? 'No requested change was made.'
        : review.resolution.kind === 'applied'
          ? 'The requested change was applied.'
          : review.resolution.kind === 'outcome_unknown'
            ? 'The request may have been applied. Check the connection before making another change.'
            : 'Finish signing in before an account is connected.';
  return (
    <div
      data-testid="connector-review-outcome"
      data-outcome={review.state === 'approved' ? review.resolution.kind : review.state}
      className="bg-muted/40 rounded-lg border p-4"
    >
      <p className="text-sm font-medium">{label}</p>
      <p className="text-muted-foreground mt-1 text-sm">{description}</p>
    </div>
  );
}
