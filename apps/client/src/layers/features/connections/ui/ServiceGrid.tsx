import { useDeferredValue, useState } from 'react';
import { Cable, MessageSquare, Search } from 'lucide-react';
import type { ConnectorCatalogService } from '@dorkos/shared/connector-resource-schemas';
import { useConnectorCatalog } from '@/layers/entities/connectors';
import { useOpenConnections } from '@/layers/shared/model';
import {
  Button,
  Input,
  QueryErrorState,
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  Skeleton,
} from '@/layers/shared/ui';
import { FALLBACK_SERVICE_ICON, SERVICE_ICONS } from '../lib/presentation';

/** Search the bounded catalog and choose one service or native messaging setup. */
export function ServiceGrid({
  onConnect,
}: {
  /** Opens the account authentication flow for the chosen service. */
  onConnect: (service: ConnectorCatalogService) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const catalog = useConnectorCatalog(deferredQuery);
  const openConnections = useOpenConnections();
  const services = catalog.data?.pages.flatMap((page) => page.services) ?? [];
  const warnings = catalog.data?.pages.flatMap((page) => page.warnings) ?? [];

  return (
    <>
      <Button data-testid="connect-service" onClick={() => setOpen(true)}>
        <Cable className="size-4" aria-hidden />
        Connect service
      </Button>
      <ResponsiveDialog open={open} onOpenChange={setOpen}>
        <ResponsiveDialogContent className="max-h-[90vh] sm:max-w-2xl [&>[data-slot=dialog-content-close]]:absolute [&>[data-slot=dialog-content-close]]:top-4 [&>[data-slot=dialog-content-close]]:right-4 [&>[data-slot=dialog-content-close]]:m-0 [&>[data-slot=dialog-content-close]]:opacity-100">
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>Connect a service</ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              Search once, then choose how you want to use the service.
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
          <ResponsiveDialogBody className="space-y-4 pb-4">
            <div className="relative">
              <Search
                className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
                aria-hidden
              />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="pl-9"
                aria-label="Search services"
                placeholder="Search Gmail, Slack, Notion…"
              />
            </div>

            {catalog.isPending ? (
              <div className="space-y-2" aria-label="Loading services">
                <Skeleton className="h-16 rounded-lg" />
                <Skeleton className="h-16 rounded-lg" />
                <Skeleton className="h-16 rounded-lg" />
              </div>
            ) : catalog.isError ? (
              <QueryErrorState
                title="Couldn’t load services"
                description="Try the catalog again. Your connected accounts are unchanged."
                onRetry={() => void catalog.refetch()}
                isRetrying={catalog.isFetching}
              />
            ) : services.length === 0 ? (
              <div className="bg-muted/40 rounded-lg p-6 text-center">
                <p className="text-sm font-medium">No matching services</p>
                <p className="text-muted-foreground mt-1 text-xs">
                  Try another name. Custom service setup is available under Advanced account setup
                  on the Connections page.
                </p>
              </div>
            ) : (
              <ul className="space-y-2" data-testid="service-catalog-results">
                {services.map((service) => {
                  const Icon =
                    SERVICE_ICONS[service.iconKey.toLowerCase()] ??
                    SERVICE_ICONS[service.serviceSlug.toLowerCase()] ??
                    FALLBACK_SERVICE_ICON;
                  return (
                    <li
                      key={service.serviceSlug}
                      data-testid={`service-result-${service.serviceSlug}`}
                      className="bg-muted/40 rounded-lg p-3"
                    >
                      <div className="flex items-center gap-2">
                        <Icon className="text-muted-foreground size-4" aria-hidden />
                        <p className="text-sm font-semibold">{service.displayName}</p>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {service.intents.map((intent) =>
                          intent.kind === 'messages' ? (
                            <Button
                              key={`messages-${intent.relayAdapterType}`}
                              size="sm"
                              variant="secondary"
                              onClick={() => {
                                setOpen(false);
                                openConnections('messaging');
                              }}
                            >
                              <MessageSquare className="size-3.5" aria-hidden />
                              {intent.displayName}
                            </Button>
                          ) : (
                            <Button
                              key="account"
                              size="sm"
                              variant="secondary"
                              onClick={() => {
                                setOpen(false);
                                onConnect(service);
                              }}
                            >
                              <Cable className="size-3.5" aria-hidden />
                              {intent.displayName}
                            </Button>
                          )
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            {catalog.hasNextPage && (
              <Button
                variant="secondary"
                className="w-full"
                onClick={() => void catalog.fetchNextPage()}
                disabled={catalog.isFetchingNextPage}
              >
                {catalog.isFetchingNextPage ? 'Loading…' : 'Load more services'}
              </Button>
            )}
            {warnings.map((warning) => (
              <p
                key={`${warning.code}-${warning.message}`}
                className="text-muted-foreground text-xs"
              >
                {warning.message}
              </p>
            ))}
          </ResponsiveDialogBody>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </>
  );
}
