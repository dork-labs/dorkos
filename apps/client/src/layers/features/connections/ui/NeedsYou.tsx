import { ChevronRight } from 'lucide-react';
import type { ConnectorCatalogService } from '@dorkos/shared/connector-resource-schemas';
import {
  useConnectorAgentRequests,
  useConnectorManagementReviews,
} from '@/layers/entities/connectors';
import { accountAppName } from '../lib/app-list';
import { presentManagementReview } from '../lib/management-review-presentation';

interface NeedsYouProps {
  /** Catalog services by id, for app names. */
  services: ReadonlyMap<string, ConnectorCatalogService>;
  /** Open one agent's request to use an app. */
  onOpenRequest: (requestId: string) => void;
  /** Open one program's request to change a connection. */
  onOpenReview: (reviewRequestId: string) => void;
}

/** One waiting decision, ready to render. */
interface NeedsYouItem {
  key: string;
  title: string;
  detail: string;
  open: () => void;
}

/**
 * Decisions waiting on the owner, at the top of the page: agents asking to use
 * an app, and tools or programs asking to change a connection. Each opens its
 * own dialog. Renders nothing at all when nothing is waiting, so the page's
 * first line is only ever spent on something the person has to do.
 */
export function NeedsYou({ services, onOpenRequest, onOpenReview }: NeedsYouProps) {
  const requests = useConnectorAgentRequests('pending');
  const reviews = useConnectorManagementReviews('pending');

  const items: NeedsYouItem[] = [
    ...(requests.data ?? []).map((request) => ({
      key: `request-${request.requestId}`,
      title: `${request.agent.displayName} wants to use ${accountAppName(request.serviceSlug, services)}`,
      detail: request.reason,
      open: () => onOpenRequest(request.requestId),
    })),
    ...(reviews.data ?? []).map((review) => {
      const presentation = presentManagementReview(review);
      return {
        key: `review-${review.reviewRequestId}`,
        title: presentation.title,
        detail: presentation.summary,
        open: () => onOpenReview(review.reviewRequestId),
      };
    }),
  ];

  if (items.length === 0) return null;

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
        {items.map((item) => (
          <li key={item.key}>
            <button
              type="button"
              data-testid={`needs-you-${item.key}`}
              onClick={item.open}
              className="hover:bg-background/60 focus-ring flex min-h-12 w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{item.title}</span>
                <span className="text-muted-foreground block truncate text-xs">{item.detail}</span>
              </span>
              <span className="text-muted-foreground flex shrink-0 items-center gap-0.5 text-xs font-medium">
                Review
                <ChevronRight className="size-3.5" aria-hidden />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
