/**
 * The Apps page (`/apps`): every app in one place, behind the sidebar's Apps
 * door (DOR-3970, spec §3–4, §7).
 *
 * Search, then Pinned in pin order, then everything else A–Z, a stable order
 * that never moves under your hand. Off apps come last in the same grid. A
 * failed load is never drawn as "no apps": it says so and offers Try again.
 *
 * @module widgets/apps-home/ui/AppsPage
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { LayoutGrid, Search, SearchX, Store, CircleAlert } from 'lucide-react';
import { LayoutGroup } from 'motion/react';
import { useNavigate } from '@tanstack/react-router';
import {
  matchesAppSearch,
  useAppCatalog,
  useRetryApps,
  type AppEntry,
} from '@/layers/entities/extension';
import { appRoutes, cn } from '@/layers/shared/lib';
import { useIsMobile } from '@/layers/shared/model';
import { Button, EmptyState, Input, PageContainer, Skeleton } from '@/layers/shared/ui';
import { AppTile } from './AppTile';

/** How many skeleton tiles the first paint holds room for. */
const LOADING_TILES = 6;

/** The grid every group shares: 228px minimum tiles, 16px gap. */
const GRID = 'grid grid-cols-[repeat(auto-fill,minmax(228px,1fr))] gap-4';

/** Off apps sink to the end of their group, otherwise A–Z holds. */
function offLast(apps: readonly AppEntry[]): AppEntry[] {
  return [
    ...apps.filter((app) => app.state !== 'off'),
    ...apps.filter((app) => app.state === 'off'),
  ];
}

/** Draw the Apps page. */
export function AppsPage() {
  const catalog = useAppCatalog();
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  // `/` focuses search from anywhere on the page, unless you are already typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('input, textarea, [contenteditable="true"]')
      ) {
        return;
      }
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const getApps = () => void navigate({ ...appRoutes.marketplace(), search: { type: 'plugin' } });

  const { pinnedShown, restShown } = useMemo(() => {
    const pinnedIds = new Set(catalog.pins);
    const byId = new Map(catalog.apps.map((app) => [app.id, app]));
    const pinnedApps = catalog.pins.flatMap((id) => {
      const app = byId.get(id);
      return app ? [app] : [];
    });
    const rest = offLast(catalog.apps.filter((app) => !pinnedIds.has(app.id)));
    return {
      pinnedShown: pinnedApps.filter((app) => matchesAppSearch(app, query)),
      restShown: rest.filter((app) => matchesAppSearch(app, query)),
    };
  }, [catalog.apps, catalog.pins, query]);

  const hasPins = catalog.pins.some((id) => catalog.apps.some((app) => app.id === id));

  const header = (
    <div className="flex flex-wrap items-center gap-3 max-md:flex-col max-md:items-stretch">
      <h1 className="text-2xl font-[650] tracking-tight max-md:sr-only">Apps</h1>
      <div className="relative ml-auto w-[280px] max-md:ml-0 max-md:w-full">
        <Search
          aria-hidden
          className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
        />
        <Input
          ref={searchRef}
          type="search"
          data-testid="apps-search"
          aria-label="Search apps"
          placeholder="Search apps"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query !== '') {
              event.stopPropagation();
              setQuery('');
            }
          }}
          className="pl-8 max-md:h-11 max-md:text-base"
        />
      </div>
      <Button variant="ghost" size="sm" onClick={getApps} className="max-md:hidden">
        <Store aria-hidden />
        Get apps
      </Button>
    </div>
  );

  let body: React.ReactNode;
  if (catalog.status === 'failed') {
    body = <LoadFailedNotice />;
  } else if (catalog.status === 'loading') {
    body = (
      <div className={isMobile ? 'flex flex-col gap-2' : GRID} aria-hidden data-slot="apps-loading">
        {Array.from({ length: LOADING_TILES }, (_, index) => (
          <Skeleton key={index} className={cn(isMobile ? 'h-15' : 'h-17', 'rounded-xl')} />
        ))}
      </div>
    );
  } else if (catalog.apps.length === 0) {
    body = (
      <EmptyState
        icon={LayoutGrid}
        headline="No apps yet"
        description="Apps add pages to DorkOS, like a board or a timesheet. Agents use them too."
        action={{ label: 'Get apps', onClick: getApps }}
        headingLevel={2}
      />
    );
  } else if (pinnedShown.length === 0 && restShown.length === 0) {
    body = (
      <EmptyState
        icon={SearchX}
        headline={`No apps match “${query.trim()}”.`}
        description="Try another name, or find more."
        action={{ label: 'Get apps', onClick: getApps, variant: 'outline' }}
        headingLevel={2}
      />
    );
  } else {
    body = (
      <LayoutGroup id="apps-home">
        <div className="flex flex-col gap-10">
          {pinnedShown.length > 0 && (
            <AppGroup title="Pinned" apps={pinnedShown} pinned asRow={isMobile} />
          )}
          {restShown.length > 0 && (
            <AppGroup
              title={hasPins ? 'Everything else' : 'All apps'}
              apps={restShown}
              pinned={false}
              asRow={isMobile}
            />
          )}
        </div>
      </LayoutGroup>
    );
  }

  return (
    <PageContainer width="wide">
      <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-8 px-6 py-8 max-md:gap-5 max-md:px-4 max-md:py-4">
        {header}
        {body}
      </div>
    </PageContainer>
  );
}

/** One titled group of apps. */
function AppGroup({
  title,
  apps,
  pinned,
  asRow,
}: {
  title: string;
  apps: readonly AppEntry[];
  pinned: boolean;
  asRow: boolean;
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <h2 className="text-muted-foreground text-sm font-medium">{title}</h2>
      <div className={asRow ? 'flex flex-col gap-2' : GRID}>
        {apps.map((app) => (
          <AppTile key={app.id} app={app} pinned={pinned} asRow={asRow} />
        ))}
      </div>
    </section>
  );
}

/** "Couldn't load apps", with Try again that reads "Trying…" while it runs. */
function LoadFailedNotice() {
  const retry = useRetryApps();
  const [trying, setTrying] = useState(false);
  return (
    <div
      role="status"
      data-slot="apps-load-failed"
      className="flex flex-col items-center gap-2 py-16 text-center"
    >
      <CircleAlert aria-hidden className="text-muted-foreground size-6" />
      <h2 className="text-base font-semibold">Couldn’t load apps</h2>
      <p className="text-muted-foreground max-w-sm text-sm">
        Your apps are still installed. DorkOS couldn’t reach them just now.
      </p>
      <Button
        variant="outline"
        size="sm"
        className="mt-2"
        disabled={trying}
        onClick={() => {
          setTrying(true);
          void retry().finally(() => setTrying(false));
        }}
      >
        {trying ? 'Trying…' : 'Try again'}
      </Button>
    </div>
  );
}
