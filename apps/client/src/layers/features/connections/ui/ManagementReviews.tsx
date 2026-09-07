import { useMemo, useState } from 'react';
import { Check, Clock3, ExternalLink, ShieldAlert, X } from 'lucide-react';
import type {
  ConnectorManagementReviewContext,
  ConnectorManagementReviewItem,
} from '@dorkos/shared/connector-schemas';
import {
  useConnectorManagementReview,
  useConnectorManagementReviews,
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

interface ManagementReviewsProps {
  /** Review selected by card or `?review=` deep link. */
  selectedReviewId: string | null;
  /** Write an exact review id into URL state. */
  onSelectReview: (reviewRequestId: string) => void;
  /** Close the detail and remove it from URL state. */
  onCloseReview: () => void;
}

/** Owner request list and URL-addressable decision detail. */
export function ManagementReviews({
  selectedReviewId,
  onSelectReview,
  onCloseReview,
}: ManagementReviewsProps) {
  const pending = useConnectorManagementReviews('pending');
  const resolved = useConnectorManagementReviews('resolved');
  const pendingItems = pending.data ?? [];
  const resolvedItems = resolved.data ?? [];

  return (
    <section aria-labelledby="connection-reviews" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 id="connection-reviews" className="text-sm font-semibold">
            Requests to review
          </h3>
          <p className="text-muted-foreground mt-1 text-sm">
            Approve or deny changes requested by tools and programs.
          </p>
        </div>
        {pendingItems.length > 0 && (
          <Badge variant="secondary">{pendingItems.length} waiting</Badge>
        )}
      </div>

      {pending.isLoading ? (
        <Skeleton className="h-20 rounded-lg" />
      ) : pending.isError ? (
        <QueryErrorState
          title="Couldn’t load review requests"
          description="No decision was made. Try loading them again."
          onRetry={() => void pending.refetch()}
          isRetrying={pending.isFetching}
        />
      ) : pendingItems.length === 0 ? (
        <p className="text-muted-foreground rounded-lg border border-dashed p-4 text-sm">
          No requests are waiting for you.
        </p>
      ) : (
        <ul className="space-y-2">
          {pendingItems.map((review) => (
            <ReviewRow key={review.reviewRequestId} review={review} onSelect={onSelectReview} />
          ))}
        </ul>
      )}

      {resolved.isError ? (
        <QueryErrorState
          title="Couldn’t load recent decisions"
          description="Try loading your recent access decisions again."
          onRetry={() => void resolved.refetch()}
          isRetrying={resolved.isFetching}
        />
      ) : resolvedItems.length > 0 ? (
        <details className="rounded-lg border">
          <summary className="focus-ring cursor-pointer rounded-lg px-4 py-3 text-sm font-medium">
            Recent decisions ({resolvedItems.length})
          </summary>
          <ul className="space-y-1 border-t p-2">
            {resolvedItems.map((review) => (
              <ReviewRow key={review.reviewRequestId} review={review} onSelect={onSelectReview} />
            ))}
          </ul>
        </details>
      ) : null}

      <ManagementReviewDialog
        key={selectedReviewId ?? 'closed'}
        reviewRequestId={selectedReviewId}
        open={selectedReviewId !== null}
        onOpenChange={(open) => {
          if (!open) onCloseReview();
        }}
      />
    </section>
  );
}

function ReviewRow({
  review,
  onSelect,
}: {
  review: ConnectorManagementReviewItem;
  onSelect: (reviewRequestId: string) => void;
}) {
  const presentation = presentManagementReview(review);
  const outcomeUnknown =
    review.state === 'approved' && review.resolution.kind === 'outcome_unknown';
  return (
    <li>
      <button
        data-testid={`connector-review-row-${review.reviewRequestId}`}
        type="button"
        onClick={() => onSelect(review.reviewRequestId)}
        className="hover:bg-muted/50 focus-ring flex min-h-14 w-full items-center gap-3 rounded-lg border px-3 py-2 text-left"
      >
        <span className="bg-muted flex size-8 shrink-0 items-center justify-center rounded-md">
          {review.state === 'pending' || review.state === 'resolving' ? (
            <Clock3 className="size-4" aria-hidden />
          ) : review.state === 'denied' ? (
            <X className="size-4" aria-hidden />
          ) : outcomeUnknown ? (
            <ShieldAlert className="size-4" aria-hidden />
          ) : (
            <Check className="size-4" aria-hidden />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{presentation.title}</span>
          <span className="text-muted-foreground block truncate text-xs">
            {presentation.summary}
          </span>
        </span>
        <Badge
          size="xs"
          variant={
            review.state === 'pending' || review.state === 'resolving' ? 'secondary' : 'outline'
          }
        >
          {outcomeUnknown ? 'outcome unknown' : review.state}
        </Badge>
      </button>
    </li>
  );
}

function ManagementReviewDialog({
  reviewRequestId,
  open,
  onOpenChange,
}: {
  reviewRequestId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
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
  const authenticationFailureReason =
    poll.data?.state === 'failed' || poll.data?.state === 'start_unknown'
      ? poll.data.reason
      : undefined;
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
                <div className="border-warning/30 bg-warning/5 flex gap-3 rounded-lg border p-3">
                  <ShieldAlert className="text-warning mt-0.5 size-4 shrink-0" aria-hidden />
                  <div>
                    <p className="text-sm font-medium">This request can’t be approved</p>
                    <p className="text-muted-foreground mt-1 text-sm">
                      The account, agent, or service setup changed after the request was created.
                      You can still deny it.
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
                      : authenticationState === 'failed' ||
                          authenticationState === 'expired' ||
                          authenticationState === 'start_unknown'
                        ? `${authenticationFailureReason ?? 'This sign-in request failed or expired.'} Start a new connection request to try again.`
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
        <dt>Service</dt>
        <dd className="font-medium">{context.toolkit}</dd>
        <dt>Through</dt>
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
  const agent =
    context.kind === 'set_agent_access' || context.kind === 'remove_agent_access'
      ? context.agent
      : null;
  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-lg border p-4 text-sm">
        <dt>Account</dt>
        <dd className="font-medium">{context.connection.label}</dd>
        <dt>Service</dt>
        <dd>{context.connection.toolkit}</dd>
        <dt>Status</dt>
        <dd>{context.connection.status}</dd>
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
          This will remove this account from {context.affectedAgentCount}{' '}
          {context.affectedAgentCount === 1 ? 'agent' : 'agents'}.
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
                <span className="text-sm">{managementOperationLabel(operation.operationSlug)}</span>
                <span className="flex items-center gap-2">
                  <Badge size="xs" variant="secondary">
                    {operation.capabilityClassification}
                  </Badge>
                  <span className="text-foreground text-xs">v{operation.toolkitVersion}</span>
                </span>
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
      return `${connection.providerDisplayName} keeps this sign-in`;
    case 'self-host':
      return `Your ${connection.providerDisplayName} server keeps this sign-in`;
    case 'external':
      return `${connection.providerDisplayName} supplies this connection`;
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
