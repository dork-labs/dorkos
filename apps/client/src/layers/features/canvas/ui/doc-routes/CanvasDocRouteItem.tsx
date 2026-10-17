/**
 * One declared route in a document's route controls, with its in-place review.
 *
 * Allowing is always two steps: Review asks the server for the exact details an
 * approval would bind, and Allow sends back only the hash of what was shown.
 * Nothing the person did not see can be granted.
 *
 * @module features/canvas/ui/doc-routes/CanvasDocRouteItem
 */
import { useId, useState } from 'react';
import type { CanvasDocRoute, CanvasDocRouteState } from '@dorkos/shared/canvas-doc-routes';
import {
  Badge,
  Button,
  DetailRow,
  SegmentedControl,
  SegmentedControlItem,
  Spinner,
  type StatusTone,
} from '@/layers/shared/ui';
import {
  ROUTE_EXPIRY_CHOICES,
  formatRouteTime,
  routeDestinationLabel,
  routeExpiryFrom,
  routeLimitsLabel,
  routeRefusal,
  routeStateDetail,
  routeStateLabel,
  type RouteExpiryChoice,
} from '../../lib/doc-routes';
import {
  useCanvasDocRouteActions,
  useCanvasDocRouteReview,
} from '../../model/use-canvas-doc-routes';

const STATE_TONES: Record<CanvasDocRouteState, StatusTone> = {
  no_grant: 'neutral',
  granted: 'success',
  waiting: 'warning',
  suspended: 'warning',
  revoked: 'neutral',
  expired: 'neutral',
};

interface CanvasDocRouteItemProps {
  documentId: string;
  route: CanvasDocRoute;
  /** False while the browser reports no connection; changes wait. */
  online: boolean;
  /** Say a finished change out loud, for anyone not looking. */
  onAnnounce: (message: string) => void;
}

/** The review panel: the server's exact details, an end time, and Allow. */
function RouteReview({
  documentId,
  route,
  online,
  onDone,
  onAnnounce,
}: Omit<CanvasDocRouteItemProps, 'route'> & { route: CanvasDocRoute; onDone: () => void }) {
  const headingId = useId();
  const [choice, setChoice] = useState<RouteExpiryChoice>('day');
  const [expiresAt, setExpiresAt] = useState(() => routeExpiryFrom('day'));
  const review = useCanvasDocRouteReview(documentId, route.id, expiresAt);
  const { approve } = useCanvasDocRouteActions(documentId);
  const details = review.data;

  const allow = () => {
    if (!details) return;
    approve.mutate(
      { routeId: route.id, expiresAt: details.expiresAt, reviewHash: details.reviewHash },
      {
        onSuccess: () => {
          onAnnounce(`${route.id} is on.`);
          onDone();
        },
      }
    );
  };

  return (
    <section
      aria-labelledby={headingId}
      data-testid={`doc-route-review-${route.id}`}
      className="bg-background space-y-3 rounded-md p-3"
    >
      <h4 id={headingId} className="text-sm font-medium">
        Allow this route?
      </h4>
      {/* Above the details, so loading them never moves the control under the pointer. */}
      <SegmentedControl
        aria-label="How long"
        value={choice}
        onValueChange={(value) => {
          setChoice(value as RouteExpiryChoice);
          setExpiresAt(routeExpiryFrom(value as RouteExpiryChoice));
        }}
      >
        {ROUTE_EXPIRY_CHOICES.map((item) => (
          <SegmentedControlItem key={item.value} value={item.value}>
            {item.label}
          </SegmentedControlItem>
        ))}
      </SegmentedControl>
      {/* Holds the four rows' height while they load, so the buttons stay put. */}
      <div className="min-h-20 space-y-1.5 text-xs">
        {details ? (
          <>
            <DetailRow label="Goes to" align="start" wrap>
              {routeDestinationLabel(details.destination)}
            </DetailRow>
            <DetailRow label="Events" align="start" wrap>
              <code className="font-mono">{details.allowedTypes.join(', ')}</code>
            </DetailRow>
            <DetailRow label="Limits" align="start" wrap>
              {routeLimitsLabel(details.limits)}
            </DetailRow>
            <DetailRow label="Ends" align="start" wrap>
              {formatRouteTime(details.expiresAt)}
            </DetailRow>
          </>
        ) : review.isError ? (
          <p role="alert" className="text-destructive">
            {routeRefusal(review.error)}
          </p>
        ) : (
          <p className="text-muted-foreground flex items-center gap-2">
            <Spinner size="xs" />
            Checking details…
          </p>
        )}
      </div>
      {approve.isError && (
        <p role="alert" className="text-destructive text-xs">
          {routeRefusal(approve.error)}
        </p>
      )}
      <div className="flex justify-end gap-2">
        {review.isError && (
          <Button type="button" variant="ghost" size="sm" onClick={() => void review.refetch()}>
            Try again
          </Button>
        )}
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          data-testid={`doc-route-allow-${route.id}`}
          disabled={!details || !online || approve.isPending}
          onClick={allow}
        >
          {approve.isPending ? 'Allowing…' : 'Allow route'}
        </Button>
      </div>
    </section>
  );
}

/**
 * One route row: where it goes, what it listens for, its state, and what a
 * person can do about it.
 */
export function CanvasDocRouteItem({
  documentId,
  route,
  online,
  onAnnounce,
}: CanvasDocRouteItemProps) {
  const [reviewing, setReviewing] = useState(false);
  const { revoke } = useCanvasDocRouteActions(documentId);
  const granted = route.state === 'granted' && route.grant !== null;

  const turnOff = () => {
    if (!route.grant) return;
    revoke.mutate(
      { routeId: route.id, grantId: route.grant.grantId },
      { onSuccess: () => onAnnounce(`${route.id} is off.`) }
    );
  };

  return (
    <li
      data-testid={`doc-route-${route.id}`}
      data-state={route.state}
      className="bg-muted/40 space-y-2 rounded-md p-3"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <p
            className="truncate text-sm font-medium"
            title={routeDestinationLabel(route.destination)}
          >
            {routeDestinationLabel(route.destination)}
          </p>
          <p className="text-muted-foreground truncate text-xs">
            <code className="font-mono">{route.on}</code> · {route.id}
          </p>
        </div>
        <Badge
          shape="pill"
          variant="outline"
          size="xs"
          tone={STATE_TONES[route.state]}
          data-testid={`doc-route-state-${route.id}`}
          className="shrink-0"
        >
          {routeStateLabel(route.state)}
        </Badge>
      </div>
      <p className="text-muted-foreground text-xs">{routeStateDetail(route)}</p>
      {granted && route.grant && (
        <p className="text-muted-foreground text-xs">{routeLimitsLabel(route.grant.limits)}</p>
      )}
      {revoke.isError && (
        <p role="alert" className="text-destructive text-xs">
          {routeRefusal(revoke.error)}
        </p>
      )}
      {reviewing ? (
        <RouteReview
          documentId={documentId}
          route={route}
          online={online}
          onAnnounce={onAnnounce}
          onDone={() => setReviewing(false)}
        />
      ) : (
        <div className="flex justify-end">
          {granted ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid={`doc-route-turn-off-${route.id}`}
              disabled={!online || revoke.isPending}
              onClick={turnOff}
            >
              {revoke.isPending ? 'Turning off…' : 'Turn off'}
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid={`doc-route-review-button-${route.id}`}
              disabled={!online}
              onClick={() => setReviewing(true)}
            >
              Review
            </Button>
          )}
        </div>
      )}
    </li>
  );
}
