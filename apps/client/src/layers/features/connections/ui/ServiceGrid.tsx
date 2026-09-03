import { useState } from 'react';
import { Cable } from 'lucide-react';
import type { ConnectorToolkit } from '@dorkos/shared/connector-provider';
import { Button, Skeleton } from '@/layers/shared/ui';
import { useConnectorToolkits } from '@/layers/entities/connectors';
import { FALLBACK_SERVICE_ICON, SERVICE_ICONS } from '../lib/presentation';
import { ConnectDialog } from './ConnectDialog';

/**
 * The service-first grid: Gmail, Slack, Linear, Notion… tiles with one verb,
 * Connect. Which provider carries the connection is invisible here — the
 * connect dialog routes through `recommendConnector`. Empty state points at
 * provider setup; provider degradations surface as honest warnings.
 */
export function ServiceGrid() {
  const { data, isLoading, isError, error } = useConnectorToolkits();
  const [connecting, setConnecting] = useState<ConnectorToolkit | null>(null);

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-28 rounded-lg" />
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <p role="alert" className="text-destructive text-sm">
        Could not load services: {error.message}
      </p>
    );
  }

  const toolkits = data?.toolkits ?? [];
  const warnings = data?.warnings ?? [];

  return (
    <div className="space-y-3">
      {toolkits.length === 0 ? (
        <div className="bg-card rounded-lg border p-8 text-center">
          <Cable className="text-muted-foreground/60 mx-auto size-8" aria-hidden />
          <p className="mt-3 text-sm font-medium">No services to connect yet</p>
          <p className="text-muted-foreground mx-auto mt-1 max-w-sm text-sm">
            Add a provider key under Providers below, and the services it can reach will show up
            here.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {toolkits.map((toolkit) => (
            <ServiceTile
              key={toolkit.slug}
              toolkit={toolkit}
              onConnect={() => setConnecting(toolkit)}
            />
          ))}
        </div>
      )}

      {warnings.map((warning) => (
        <p key={warning.provider} className="text-muted-foreground text-xs">
          Some services may be missing: {warning.message}
        </p>
      ))}

      <ConnectDialog service={connecting} onClose={() => setConnecting(null)} />
    </div>
  );
}

/**
 * One service tile: icon, name, and the single Connect verb. Also renderable
 * standalone (Dev Playground) via explicit props.
 *
 * @param props - The toolkit to draw and its connect handler.
 * @param props.toolkit - The connectable service.
 * @param props.onConnect - Called when the person clicks Connect.
 */
export function ServiceTile({
  toolkit,
  onConnect,
}: {
  toolkit: ConnectorToolkit;
  onConnect: () => void;
}) {
  const Icon = SERVICE_ICONS[toolkit.slug.toLowerCase()] ?? FALLBACK_SERVICE_ICON;
  return (
    <div
      data-testid={`service-tile-${toolkit.slug}`}
      className="bg-card card-interactive shadow-soft flex flex-col items-start gap-3 rounded-lg border p-4"
    >
      {/* `w-full`: the card is a column with `items-start`, which sizes each
          child to its own content rather than stretching it to the card's
          width — so without it, a long service name had nothing forcing this
          row narrower than its own text and painted past the card's padding
          instead of truncating (DOR-1747). `min-w-0` is what then lets the
          row shrink below that content size at all. */}
      <div className="flex w-full min-w-0 items-center gap-2">
        <Icon className="text-muted-foreground size-4 shrink-0" aria-hidden />
        <span className="truncate text-sm font-medium">{toolkit.displayName}</span>
      </div>
      <Button
        size="sm"
        variant="secondary"
        className="mt-auto w-full"
        onClick={onConnect}
        aria-label={`Connect ${toolkit.displayName}`}
      >
        Connect
      </Button>
    </div>
  );
}
