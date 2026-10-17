/**
 * The canvas header's route control for the open document.
 *
 * Draws nothing for a document without declared routes, which is nearly every
 * document. For one with routes it is a compact button naming how many are on
 * and how many wait on a person; it opens the list of routes, each with its
 * destination, events, state, end time and limits, and the Review/Allow and
 * Turn off actions. A declared route is shown Off until someone allows it:
 * nothing is enabled by silence.
 *
 * @module features/canvas/ui/doc-routes/CanvasDocRoutes
 */
import { useCallback, useState } from 'react';
import { Waypoints } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import {
  Button,
  ResponsivePopover,
  ResponsivePopoverContent,
  ResponsivePopoverTitle,
  ResponsivePopoverTrigger,
} from '@/layers/shared/ui';
import { routesSummary } from '../../lib/doc-routes';
import { useBrowserOnline, useCanvasDocRoutes } from '../../model/use-canvas-doc-routes';
import { CanvasDocRouteItem } from './CanvasDocRouteItem';

/** What the trigger says: the state worth a glance, never a bare count of routes. */
function triggerSummary(on: number, waiting: number): string {
  if (waiting > 0) return `${waiting} waiting`;
  if (on > 0) return `${on} on`;
  return 'Off';
}

/**
 * Route controls for one document.
 *
 * @param documentId - The open document.
 */
export function CanvasDocRoutes({ documentId }: { documentId: string }) {
  const [open, setOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const online = useBrowserOnline();
  const routes = useCanvasDocRoutes(documentId, open);
  const announce = useCallback((message: string) => setAnnouncement(message), []);

  const list = routes.data?.routes ?? [];
  // No routes, or none known yet: the header stays as it was.
  if (list.length === 0) return null;
  const { on, waiting } = routesSummary(list);
  const summary = triggerSummary(on, waiting);

  return (
    <div
      data-testid="doc-routes-bar"
      className="text-muted-foreground flex items-center justify-end border-b px-3 py-1 text-xs"
    >
      <ResponsivePopover open={open} onOpenChange={setOpen} modal fullHeight>
        <ResponsivePopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="doc-routes-trigger"
            aria-label={`Event routes: ${summary}`}
            className="h-6 gap-1.5 px-1.5"
          >
            <Waypoints className="size-3.5" />
            Routes
            <span
              className={cn(
                'flex items-center gap-1',
                waiting > 0 ? 'text-status-warning-fg' : 'text-muted-foreground'
              )}
            >
              {waiting > 0 && (
                <span aria-hidden className="bg-status-warning size-1.5 rounded-full" />
              )}
              {summary}
            </span>
          </Button>
        </ResponsivePopoverTrigger>
        <ResponsivePopoverContent
          align="end"
          aria-label="Event routes"
          data-testid="doc-routes-panel"
          className="flex max-h-[min(70vh,36rem)] w-[min(24rem,calc(100vw-2rem))] flex-col gap-3 overflow-y-auto p-3"
        >
          <ResponsivePopoverTitle>Event routes</ResponsivePopoverTitle>
          <div className="space-y-1">
            <h3 className="hidden text-sm font-medium md:block">Event routes</h3>
            <p className="text-muted-foreground text-xs">
              Events start work only on routes you allow.
            </p>
          </div>
          {!online && (
            <p
              data-testid="doc-routes-offline"
              className="bg-status-warning-bg text-status-warning-fg rounded-md px-2 py-1.5 text-xs"
            >
              Offline. Changes wait until you reconnect.
            </p>
          )}
          {routes.isError && (
            <div role="alert" className="flex items-center justify-between gap-2 text-xs">
              <span className="text-destructive">Couldn’t refresh routes.</span>
              <Button type="button" variant="ghost" size="sm" onClick={() => void routes.refetch()}>
                Try again
              </Button>
            </div>
          )}
          <ul className="space-y-2" aria-label="Declared routes">
            {list.map((route) => (
              <CanvasDocRouteItem
                key={route.id}
                documentId={documentId}
                route={route}
                online={online}
                onAnnounce={announce}
              />
            ))}
          </ul>
          <p role="status" aria-live="polite" className="sr-only">
            {announcement}
          </p>
        </ResponsivePopoverContent>
      </ResponsivePopover>
    </div>
  );
}
