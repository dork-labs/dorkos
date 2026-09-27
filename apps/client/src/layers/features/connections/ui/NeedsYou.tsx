import { useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { ConnectorCatalogService } from '@dorkos/shared/connector-resource-schemas';
import { CONNECTOR_AUTHENTICATION_FLOW_TTL_MS } from '@dorkos/shared/connector-schemas';
import {
  useConnectorAgentRequests,
  useConnectorManagementReviews,
} from '@/layers/entities/connectors';
import { Button } from '@/layers/shared/ui';
import { accountAppName } from '../lib/app-list';
import { pendingReviewLine, unsettledReviewLine, type NeedsYouLine } from '../lib/needs-you-copy';

/**
 * How long a decided review whose result is unknown keeps asking to be
 * checked: a week, by policy (ADR 260927-033250). After that it is history,
 * still reachable by its link, and no longer pressing.
 */
const UNKNOWN_OUTCOME_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long an approved connect keeps asking the person to finish signing in:
 * as long as its sign-in can be finished, and no longer. Its sign-in is not
 * read from here on purpose: reading a flow's state moves it on, and the
 * review dialog reads it only once the person continues.
 */
const OPEN_SIGN_IN_WINDOW_MS = CONNECTOR_AUTHENTICATION_FLOW_TTL_MS;

/** How often an open page re-checks those windows, so old items age out. */
const CLOCK_TICK_MS = 60 * 1000;

interface NeedsYouProps {
  /** Catalog services by id, for app names. */
  services: ReadonlyMap<string, ConnectorCatalogService>;
  /** Open one agent's request to use an app. */
  onOpenRequest: (requestId: string) => void;
  /** Open one program's request to change a connection. */
  onOpenReview: (reviewRequestId: string) => void;
}

/**
 * Decisions waiting on the owner, at the top of the page: agents asking to use
 * an app, tools or programs asking to change a connection, and two decided
 * requests that still need the person (an approved connect whose sign-in
 * may still be open, and an approved change DorkOS could not confirm). Each opens its
 * own dialog.
 *
 * Renders nothing when nothing waits, so the page's first line is only ever
 * spent on something the person has to do. A read that failed says so in one
 * quiet line with a retry, rather than looking like "nothing waits".
 */
export function NeedsYou({ services, onOpenRequest, onOpenReview }: NeedsYouProps) {
  const requests = useConnectorAgentRequests('pending');
  const pending = useConnectorManagementReviews('pending');
  const resolved = useConnectorManagementReviews('resolved');

  const now = useMinuteClock();
  const unsettled = (resolved.data ?? []).filter(
    (review) =>
      review.state === 'approved' &&
      ((review.resolution.kind === 'connect_authentication_required' &&
        now - Date.parse(review.resolvedAt) < OPEN_SIGN_IN_WINDOW_MS) ||
        (review.resolution.kind === 'outcome_unknown' &&
          now - Date.parse(review.resolvedAt) < UNKNOWN_OUTCOME_WINDOW_MS))
  );
  const failed = [requests, pending, resolved].filter((query) => query.isError);

  const hasItems =
    (requests.data?.length ?? 0) + (pending.data?.length ?? 0) + unsettled.length > 0;
  if (!hasItems && failed.length === 0) return null;

  return (
    <section
      aria-labelledby="connections-needs-you"
      data-testid="needs-you"
      className="bg-status-warning-bg/60 rounded-xl p-1.5"
    >
      <h2
        id="connections-needs-you"
        className="text-status-warning-fg px-2.5 pt-1.5 pb-1 text-xs font-semibold"
      >
        Needs you
      </h2>
      <ul>
        {(requests.data ?? []).map((request) => (
          <NeedsYouRow
            key={`request-${request.requestId}`}
            testId={`needs-you-request-${request.requestId}`}
            line={{
              title: `${request.agent.displayName} wants to use ${accountAppName(request.serviceSlug, services)}`,
              detail: request.reason,
            }}
            onOpen={() => onOpenRequest(request.requestId)}
          />
        ))}
        {(pending.data ?? []).map((review) => (
          <NeedsYouRow
            key={`review-${review.reviewRequestId}`}
            testId={`needs-you-review-${review.reviewRequestId}`}
            line={pendingReviewLine(review, services)}
            onOpen={() => onOpenReview(review.reviewRequestId)}
          />
        ))}
        {unsettled.map((review) => {
          const line = unsettledReviewLine(review, services);
          return line ? (
            <NeedsYouRow
              key={`review-${review.reviewRequestId}`}
              testId={`needs-you-review-${review.reviewRequestId}`}
              line={line}
              onOpen={() => onOpenReview(review.reviewRequestId)}
            />
          ) : null;
        })}
      </ul>
      {failed.length > 0 && (
        <p className="text-muted-foreground flex flex-wrap items-center gap-x-2 px-2.5 pb-1.5 text-xs">
          Couldn’t check for requests waiting on you.
          <Button
            variant="link"
            size="xs"
            className="h-auto p-0"
            onClick={() => failed.forEach((query) => void query.refetch())}
          >
            Try again
          </Button>
        </p>
      )}
    </section>
  );
}

/** The time, refreshed each minute, so an open page ages items out on its own. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** One waiting decision: who asks for what, what it means, and Review. */
function NeedsYouRow({
  testId,
  line,
  onOpen,
}: {
  testId: string;
  line: NeedsYouLine;
  onOpen: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        data-testid={testId}
        onClick={onOpen}
        className="hover:bg-background/60 focus-ring flex min-h-12 w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors"
      >
        <span className="min-w-0 flex-1">
          {/* Two lines on a phone, where one would cut the ask in half. */}
          <span className="line-clamp-2 block text-sm font-medium sm:line-clamp-1">
            {line.title}
          </span>
          <span className="text-muted-foreground line-clamp-2 block text-xs sm:line-clamp-1">
            {line.detail}
          </span>
        </span>
        <span className="text-muted-foreground flex shrink-0 items-center gap-0.5 text-xs font-medium">
          Review
          <ChevronRight className="size-3.5" aria-hidden />
        </span>
      </button>
    </li>
  );
}
