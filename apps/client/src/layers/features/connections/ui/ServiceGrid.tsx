import { useDeferredValue, useState } from 'react';
import { Cable, MessageSquare, Search } from 'lucide-react';
import type {
  ConnectorAppConnections,
  ConnectorCatalogService,
} from '@dorkos/shared/connector-resource-schemas';
import { useConnectorCatalog } from '@/layers/entities/connectors';
import {
  Badge,
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
import { ServiceMark } from './ServiceMark';

/**
 * Search the catalog and choose an app to connect, or a chat app to set up.
 *
 * The popular apps are always listed, even before any way to reach apps is set
 * up; connecting one of those starts with the one-time setup step in the
 * connect dialog. A chat app goes to its own setup, never that step.
 */
export function ServiceGrid({
  onConnect,
  onConnectChat,
}: {
  /** Opens the account sign-in flow for the chosen app. */
  onConnect: (service: ConnectorCatalogService) => void;
  /** Opens the chat app's own setup for the chosen chat app type. */
  onConnectChat: (chatAppType: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const catalog = useConnectorCatalog(deferredQuery);
  const services = catalog.data?.pages.flatMap((page) => page.services) ?? [];
  const warnings = catalog.data?.pages.flatMap((page) => page.warnings) ?? [];
  const emptyHint = emptySearchHint(catalog.data?.pages[0]?.appConnections?.newApps);

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
                <p className="text-sm font-medium">No app matches “{deferredQuery.trim()}”</p>
                <p className="text-muted-foreground mt-1 text-xs">{emptyHint}</p>
              </div>
            ) : (
              <ul className="space-y-2" data-testid="service-catalog-results">
                {services.map((service) => {
                  const chat = service.intents.some((intent) => intent.kind === 'messages');
                  return (
                    <li
                      key={service.serviceSlug}
                      data-testid={`service-result-${service.serviceSlug}`}
                      className="bg-muted/40 rounded-lg p-3"
                    >
                      <div className="flex items-start gap-3">
                        <ServiceMark iconKey={service.iconKey} displayName={service.displayName} />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-sm font-semibold">{service.displayName}</p>
                            {chat && (
                              <Badge variant="secondary" className="text-[11px]">
                                Chat
                              </Badge>
                            )}
                          </div>
                          {service.description && (
                            <p className="text-muted-foreground mt-0.5 text-xs">
                              {service.description}
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2 sm:pl-11">
                        {service.intents.map((intent) =>
                          intent.kind === 'messages' ? (
                            <Button
                              key={`messages-${intent.relayAdapterType}`}
                              size="sm"
                              variant="secondary"
                              onClick={() => {
                                setOpen(false);
                                onConnectChat(intent.relayAdapterType);
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

/**
 * Why a search found nothing, in the one case it is not just the name: while
 * no way to reach apps works, only the popular apps can be listed.
 */
function emptySearchHint(newApps: ConnectorAppConnections['newApps'] | undefined): string {
  if (newApps?.status !== 'setup_needed') return 'Try another name.';
  switch (newApps.reason) {
    case 'nothing_set_up':
      return 'Only popular apps are listed until you connect your first one. After that, search reaches every app DorkOS can connect.';
    case 'own_key_unavailable':
      return 'Only popular apps are listed while your saved key isn’t working.';
    case 'dorkos_account_unavailable':
      return 'Only popular apps are listed while your DorkOS account can’t connect apps.';
  }
}
