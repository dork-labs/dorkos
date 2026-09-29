import { useState } from 'react';
import { Search } from 'lucide-react';
import type {
  ConnectorAppConnections,
  ConnectorCatalogService,
} from '@dorkos/shared/connector-resource-schemas';
import { TOUR_ANCHORS } from '@/layers/shared/config';
import { cn } from '@/layers/shared/lib';
import { Button, Input, QueryErrorState, Skeleton } from '@/layers/shared/ui';
import {
  appsOnShelf,
  appUses,
  SHELF_LABELS,
  shelvesFor,
  type AppShelf,
  type YourAppRow,
} from '../../lib/app-list';
import type { AppListData } from '../../model/use-app-list';
import { ChatAppsOff } from '../ChatAppsOff';
import { CatalogAppRowView, YourAppRowView } from './AppRow';

/** Props for {@link AppList}. */
export interface AppListProps {
  /** What is in the search box. */
  query: string;
  /** Change the search. */
  onQueryChange: (query: string) => void;
  /** The rows and the reads behind them (see `useAppList`). */
  data: AppListData;
  /** Open a row's side panel. */
  onOpenRow: (row: YourAppRow) => void;
  /** Run a row's one action. */
  onRowAction: (row: YourAppRow) => void;
  /** The row whose action is running, if any. */
  pendingRowId?: string | null;
  /** Start connecting an app from "All apps". */
  onConnect: (service: ConnectorCatalogService) => void;
}

/**
 * The Connections page's one list (design record §1, §2, §8): a search box,
 * "Yours" (everything connected, one row each), and "All apps" with shelf
 * chips and a small "For developers" group at the bottom.
 *
 * On a first visit there is no "Yours" section at all; the search and "All
 * apps" are the empty state. The popular apps are always listed, even before
 * any way to reach apps is set up.
 */
export function AppList({
  query,
  onQueryChange,
  data,
  onOpenRow,
  onRowAction,
  pendingRowId = null,
  onConnect,
}: AppListProps) {
  const [shelf, setShelf] = useState<AppShelf>('popular');
  const searching = query.trim() !== '';
  const { catalog, relay } = data;
  const chatAppsOn = relay.enabled;

  const general = data.available.filter((service) => service.category !== 'developer');
  const developer = data.available.filter((service) => service.category === 'developer');
  const shelves = shelvesFor(general);
  const activeShelf = shelves.includes(shelf) ? shelf : 'popular';
  const listed = searching ? general : appsOnShelf(general, activeShelf);
  const warnings = catalog.data?.pages.flatMap((page) => page.warnings) ?? [];
  const newApps = catalog.data?.pages[0]?.appConnections?.newApps;
  const nothingFound =
    searching && !catalog.isPending && data.yours.length === 0 && data.available.length === 0;

  const rowFor = (service: ConnectorCatalogService, actionLabel: string) => {
    const uses = appUses(service);
    const chatOnly = uses.chatType !== null && !uses.account;
    const blocked = chatOnly && !chatAppsOn;
    return (
      <CatalogAppRowView
        key={service.serviceSlug}
        service={service}
        chat={uses.chatType !== null}
        actionLabel={actionLabel}
        onConnect={blocked ? undefined : onConnect}
        unavailableLabel="Turned off"
      />
    );
  };

  return (
    <div className="space-y-8" data-testid={TOUR_ANCHORS.relayIntegrations}>
      <div className="relative">
        <Search
          className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
          aria-hidden
        />
        <Input
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          className="pl-9"
          aria-label="Search apps"
          placeholder="Search apps"
          data-testid="app-search"
        />
      </div>

      {data.yoursLoading ? (
        <div className="space-y-2" aria-label="Loading your apps">
          <Skeleton className="h-14 rounded-lg" />
          <Skeleton className="h-14 rounded-lg" />
        </div>
      ) : data.yoursError ? (
        <QueryErrorState
          title="Couldn’t load your apps"
          description="Try again. Nothing about your apps was changed."
          onRetry={data.retryYours}
        />
      ) : (
        data.yours.length > 0 && (
          <section aria-labelledby="connections-yours" className="space-y-2">
            <h2 id="connections-yours" className="text-sm font-semibold">
              Yours
            </h2>
            <ul className="-mx-3 space-y-0.5" data-testid="yours-list">
              {data.yours.map((row) => (
                <YourAppRowView
                  key={row.id}
                  row={row}
                  onOpen={onOpenRow}
                  onAction={onRowAction}
                  actionPending={pendingRowId === row.id}
                />
              ))}
            </ul>
          </section>
        )
      )}

      {nothingFound ? (
        <div className="bg-muted/40 rounded-xl p-6 text-center">
          <p className="text-sm font-medium">No app matches “{query.trim()}”</p>
          <p className="text-muted-foreground mt-1 text-xs">{emptySearchHint(newApps)}</p>
        </div>
      ) : (
        <section aria-labelledby="connections-all-apps" className="space-y-3">
          <h2 id="connections-all-apps" className="text-sm font-semibold">
            {searching ? 'Apps' : 'All apps'}
          </h2>

          {!searching && shelves.length > 2 && (
            <div
              role="group"
              aria-label="Show apps by kind"
              className="-mx-4 flex scrollbar-none gap-1.5 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0"
            >
              {shelves.map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  aria-pressed={candidate === activeShelf}
                  onClick={() => setShelf(candidate)}
                  className={cn(
                    'focus-ring shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors',
                    candidate === activeShelf
                      ? 'bg-foreground text-background'
                      : 'bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground'
                  )}
                >
                  {SHELF_LABELS[candidate]}
                </button>
              ))}
            </div>
          )}

          {catalog.isPending ? (
            <div className="space-y-2" aria-label="Loading apps">
              <Skeleton className="h-14 rounded-lg" />
              <Skeleton className="h-14 rounded-lg" />
              <Skeleton className="h-14 rounded-lg" />
            </div>
          ) : catalog.isError ? (
            <QueryErrorState
              title="Couldn’t load the app list"
              description="Try again. Your connected apps are unchanged."
              onRetry={() => void catalog.refetch()}
              isRetrying={catalog.isFetching}
            />
          ) : (
            <>
              {listed.length > 0 && (
                <ul className="-mx-3 space-y-0.5" data-testid="all-apps-list">
                  {listed.map((service) => rowFor(service, 'Connect'))}
                </ul>
              )}
              {(searching || activeShelf === 'all') && catalog.hasNextPage && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void catalog.fetchNextPage()}
                  disabled={catalog.isFetchingNextPage}
                >
                  {catalog.isFetchingNextPage ? 'Loading…' : 'Show more apps'}
                </Button>
              )}
            </>
          )}

          <ChatAppsLine data={data} />
          {warnings.map((warning) => (
            <p key={`${warning.code}-${warning.message}`} className="text-muted-foreground text-xs">
              {warning.message}
            </p>
          ))}
        </section>
      )}

      {developer.length > 0 && !catalog.isPending && (
        <section aria-labelledby="connections-developers" className="space-y-2">
          <h2 id="connections-developers" className="text-muted-foreground text-xs font-semibold">
            For developers
          </h2>
          <ul className="-mx-3 space-y-0.5">
            {developer.map((service) => rowFor(service, 'Set up'))}
          </ul>
        </section>
      )}
    </div>
  );
}

/**
 * One quiet line when chat apps can't be used here, instead of a wall: they
 * couldn't be checked, or they aren't running — and then the line carries the
 * one step that turns them on ({@link ChatAppsOff}).
 */
function ChatAppsLine({ data }: { data: AppListData }) {
  const { relay } = data;
  if (data.chatAppsError) {
    return (
      <p className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs">
        Couldn’t load your chat apps.
        <Button variant="link" size="xs" className="h-auto p-0" onClick={data.retryChatApps}>
          Try again
        </Button>
      </p>
    );
  }
  if (relay.isError) {
    return (
      <p className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs">
        Couldn’t check chat apps.
        <Button
          variant="link"
          size="xs"
          className="h-auto p-0"
          onClick={relay.retry}
          disabled={relay.isRetrying}
        >
          {relay.isRetrying ? 'Checking…' : 'Try again'}
        </Button>
      </p>
    );
  }
  return <ChatAppsOff relay={relay} variant="line" />;
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
    case 'dorkos_account_unlinked':
      return 'Only popular apps are listed while your DorkOS account isn’t linked.';
  }
}
