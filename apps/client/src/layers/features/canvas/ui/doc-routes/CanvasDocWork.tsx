/**
 * The canvas header's review of a document's unfinished work, beside its routes.
 *
 * Draws nothing until there is work to review: work that waited a day and never
 * started, or work that started before a restart with an unknown result. Each
 * piece can run again or be cleared, and only by the person's choice. Running
 * uncertain work again asks first, since the agent may already have acted on it.
 *
 * @module features/canvas/ui/doc-routes/CanvasDocWork
 */
import { useCallback, useState } from 'react';
import { History } from 'lucide-react';
import type { CanvasDocRoute, CanvasDocWorkItem } from '@dorkos/shared/canvas-doc-routes';
import { cn, formatRelativeTime } from '@/layers/shared/lib';
import {
  Badge,
  Button,
  ResponsivePopover,
  ResponsivePopoverContent,
  ResponsivePopoverTitle,
  ResponsivePopoverTrigger,
} from '@/layers/shared/ui';
import { routeDestinationLabel } from '../../lib/doc-routes';
import {
  workEventCount,
  workRefusal,
  workReplayBlocked,
  workStatusDetail,
  workStatusLabel,
  workSummary,
} from '../../lib/doc-work';
import { useCanvasDocWork, useCanvasDocWorkActions } from '../../model/use-canvas-doc-work';

interface WorkItemProps {
  documentId: string;
  item: CanvasDocWorkItem;
  route: CanvasDocRoute | undefined;
  online: boolean;
  onAnnounce: (message: string) => void;
}

/** One piece of work: where it was going, what happened, and the two choices. */
function WorkItem({ documentId, item, route, online, onAnnounce }: WorkItemProps) {
  const [confirming, setConfirming] = useState(false);
  const { replay, clear } = useCanvasDocWorkActions(documentId);
  const busy = replay.isPending || clear.isPending;
  const blocked = workReplayBlocked(item);
  const destination = route ? routeDestinationLabel(route.destination) : item.routeId;
  const uncertain = item.status === 'in_doubt';
  const error = replay.error ?? clear.error;

  // Each choice clears the other's refusal, so the message shown is the latest one.
  const runAgain = (confirmRepeat?: true) => {
    clear.reset();
    replay.mutate(
      { batchId: item.batchId, ...(confirmRepeat ? { confirmRepeat } : {}) },
      { onSuccess: () => onAnnounce(`Running again: ${destination}`) }
    );
  };
  const setAside = () => {
    replay.reset();
    clear.mutate(
      { batchId: item.batchId },
      { onSuccess: () => onAnnounce(`Cleared: ${destination}`) }
    );
  };

  return (
    <li
      data-testid={`doc-work-${item.batchId}`}
      data-status={item.status}
      className="bg-muted/40 space-y-2 rounded-md p-3"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <p className="truncate text-sm font-medium" title={destination}>
            {destination}
          </p>
          <p className="text-muted-foreground truncate text-xs">
            {workEventCount(item.eventCount)} · {formatRelativeTime(item.since)}
          </p>
        </div>
        <Badge
          shape="pill"
          variant="outline"
          size="xs"
          tone={uncertain ? 'warning' : 'neutral'}
          className="shrink-0"
        >
          {workStatusLabel(item.status)}
        </Badge>
      </div>
      <p className="text-muted-foreground text-xs">{workStatusDetail(item.status)}</p>
      {blocked && (
        <p
          data-testid={`doc-work-blocked-${item.batchId}`}
          className="text-muted-foreground text-xs"
        >
          {blocked}
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive text-xs">
          {workRefusal(error)}
        </p>
      )}
      {confirming ? (
        <div
          data-testid={`doc-work-confirm-${item.batchId}`}
          className="bg-background space-y-2 rounded-md p-3"
        >
          <p className="text-sm font-medium">Run this again?</p>
          <p className="text-muted-foreground text-xs">It may repeat what the agent already did.</p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              data-testid={`doc-work-confirm-replay-${item.batchId}`}
              disabled={!online || busy}
              onClick={() => runAgain(true)}
            >
              {replay.isPending ? 'Starting…' : 'Run again'}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid={`doc-work-clear-${item.batchId}`}
            disabled={!online || busy}
            onClick={setAside}
          >
            {clear.isPending ? 'Clearing…' : 'Clear'}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid={`doc-work-replay-${item.batchId}`}
            disabled={!online || busy || blocked !== null}
            onClick={() => (uncertain ? setConfirming(true) : runAgain())}
          >
            {replay.isPending ? 'Starting…' : 'Run again'}
          </Button>
        </div>
      )}
    </li>
  );
}

interface CanvasDocWorkProps {
  documentId: string;
  /** The document's declared routes, for where each piece of work was going. */
  routes: readonly CanvasDocRoute[];
  online: boolean;
}

/**
 * Unfinished work for one document. Draws nothing when there is none.
 *
 * @param documentId - The open document.
 * @param routes - Its declared routes; the work is only read when there are some.
 * @param online - False while the browser reports no connection; changes wait.
 */
export function CanvasDocWork({ documentId, routes, online }: CanvasDocWorkProps) {
  const [open, setOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const work = useCanvasDocWork(documentId, routes.length > 0, open);
  const announce = useCallback((message: string) => setAnnouncement(message), []);
  const items = work.data?.items ?? [];

  // Outside the popover, so a change that empties the list and closes it is
  // still said out loud. No `status` role: the route list beside it owns that.
  const live = (
    <p aria-live="polite" className="sr-only">
      {announcement}
    </p>
  );
  if (items.length === 0) return live;
  const summary = workSummary(items.length);
  const uncertain = items.some((item) => item.status === 'in_doubt');

  return (
    <>
      {live}
      <ResponsivePopover open={open} onOpenChange={setOpen} modal fullHeight>
        <ResponsivePopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="doc-work-trigger"
            aria-label={`Unfinished work: ${summary}`}
            className="h-6 gap-1.5 px-1.5"
          >
            <History className="size-3.5" />
            <span
              className={cn(
                'flex items-center gap-1',
                uncertain ? 'text-status-warning-fg' : 'text-muted-foreground'
              )}
            >
              {uncertain && (
                <span aria-hidden className="bg-status-warning size-1.5 rounded-full" />
              )}
              {summary}
            </span>
          </Button>
        </ResponsivePopoverTrigger>
        <ResponsivePopoverContent
          align="end"
          aria-label="Unfinished work"
          data-testid="doc-work-panel"
          className="flex max-h-[min(70vh,36rem)] w-[min(24rem,calc(100vw-2rem))] flex-col gap-3 overflow-y-auto p-3"
        >
          <ResponsivePopoverTitle>Unfinished work</ResponsivePopoverTitle>
          <div className="space-y-1">
            <h3 className="hidden text-sm font-medium md:block">Unfinished work</h3>
            <p className="text-muted-foreground text-xs">Nothing runs again until you choose.</p>
          </div>
          {!online && (
            <p className="bg-status-warning-bg text-status-warning-fg rounded-md px-2 py-1.5 text-xs">
              Offline. Changes wait until you reconnect.
            </p>
          )}
          {work.isError && (
            <div role="alert" className="flex items-center justify-between gap-2 text-xs">
              <span className="text-destructive">Couldn’t refresh this list.</span>
              <Button type="button" variant="ghost" size="sm" onClick={() => void work.refetch()}>
                Try again
              </Button>
            </div>
          )}
          <ul className="space-y-2" aria-label="Work to review">
            {items.map((item) => (
              <WorkItem
                key={item.batchId}
                documentId={documentId}
                item={item}
                route={routes.find((route) => route.id === item.routeId)}
                online={online}
                onAnnounce={announce}
              />
            ))}
          </ul>
        </ResponsivePopoverContent>
      </ResponsivePopover>
    </>
  );
}
