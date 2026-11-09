import { useMemo } from 'react';
import { useLocation, useRouter } from '@tanstack/react-router';
import { ErrorBoundary } from 'react-error-boundary';
import { AlertTriangle, PackageX, Puzzle } from 'lucide-react';
import { useExtensionPageAtPath } from '@/layers/shared/model';
import { openLink } from '@/layers/shared/lib';
import { useExtensionClientStates } from '@/layers/shared/lib/extension-client-state';
import { EmptyState, PageContainer } from '@/layers/shared/ui';
import { useExtensions } from '@/layers/features/extensions';
import { extensionPageState, type ExtensionPageState } from '../model/extension-page-state';
import { createPageSearchWriter, pageSearchFrom } from '../model/page-search';
import { useSettledPageState } from '../model/use-settled-page-state';
import { DevLinkStrip } from './DevLinkStrip';
import { ExtensionPageNotWorking, ExtensionPageStarting } from './ExtensionPageStatus';

/** The answer for `/x/Not_An_Id`: no extension could have that id. */
const NOT_AN_EXTENSION: ExtensionPageState = { kind: 'not-installed', name: 'This add-on' };

/** Where a person turns an extension on, or lets it run: Settings → Extensions. */
const EXTENSIONS_SETTINGS_LINK = '?settings=extensions';

/**
 * The route at `/x/<extensionId>/<path>`: one extension page, or the honest
 * reason there is none (spec `flow-multiproject` §6.5).
 *
 * Matches the address against the pages that extension registered and renders
 * the one that answers, with its params and a `setSearch` that writes the URL,
 * so a page's own state (`?project=dorkos`) is bookmarkable. While the app is
 * still loading it says "Starting…" — a deep link on reload arrives before the
 * extension has activated and registered anything — and if its load never
 * finishes, that it isn't working, with Try again. Only once it has loaded does
 * a plain empty state say why there is no page.
 */
export function ExtensionPageRoute() {
  const location = useLocation();
  const router = useRouter();
  const at = useExtensionPageAtPath(location.pathname);
  const { extensions, ready, settling } = useExtensions();
  const clientStates = useExtensionClientStates();

  const search = useMemo(() => pageSearchFrom(location.searchStr), [location.searchStr]);
  // One writer per router: it remembers what it last wrote, so two calls in a
  // row compose instead of the second undoing the first.
  const writer = useMemo(() => createPageSearchWriter(router), [router]);
  const setSearch = useMemo(
    () => (next: Record<string, string | null>) => void writer(next),
    [writer]
  );

  // The router only mounts this component on `/x/…`, so `at` is null only for
  // an id no extension could have (`/x/Not_An_Id`) — nothing is installed there.
  const current = at
    ? extensionPageState(at, extensions, ready, settling, clientStates[at.extensionId])
    : NOT_AN_EXTENSION;
  const state = useSettledPageState(current);

  if (state.kind === 'page') {
    const { page, params } = state.at.match;
    // The extension behind this page, for the dev-link strip (DOR-2696).
    const pageRecord = extensions.find((extension) => extension.id === state.at.extensionId);
    const Page = page.component;
    return (
      // Keyed on the page, and reset when the address under it changes, so an
      // error on one page — or on one project's lens — never follows you on.
      <ErrorBoundary
        key={page.id}
        resetKeys={[location.pathname]}
        fallback={<PageFailed name={page.title} />}
      >
        {/* The whole content area, scrolled here. Layout and padding are the
            page's own: a lens page and a settings form want different ones. */}
        <div data-testid="extension-page" className="h-full min-h-0 overflow-y-auto">
          {pageRecord?.devLink && <DevLinkStrip extension={pageRecord} />}
          <Page params={params} search={search} setSearch={setSearch} />
        </div>
      </ErrorBoundary>
    );
  }

  // A held-back answer is already known, so it waits without saying "Starting…".
  if (state.kind === 'loading') return <ExtensionPageStarting quiet={current.kind !== 'loading'} />;
  if (state.kind === 'not-working') return <ExtensionPageNotWorking {...state} />;

  return (
    <PageContainer width="reading">
      <UnavailablePage state={state} />
    </PageContainer>
  );
}

/** Said when an extension's page throws while drawing. */
function PageFailed({ name }: { name: string }) {
  return (
    <PageContainer width="reading">
      <EmptyState
        icon={AlertTriangle}
        tone="destructive"
        headingLevel={2}
        headline={`${name} ran into a problem`}
        description="Reloading the page may fix it."
        action={{ label: 'Reload', variant: 'outline', onClick: () => window.location.reload() }}
      />
    </PageContainer>
  );
}

/** One of the reasons an extension page is not there, in plain words. */
function UnavailablePage({
  state,
}: {
  state: Exclude<
    ExtensionPageState,
    { kind: 'page' } | { kind: 'loading' } | { kind: 'not-working' }
  >;
}) {
  const openExtensions = { onClick: () => void openLink(EXTENSIONS_SETTINGS_LINK) };
  switch (state.kind) {
    case 'not-installed':
      return (
        <EmptyState
          icon={PackageX}
          headingLevel={2}
          headline="This page isn’t available"
          description={`${state.name} isn’t installed.`}
        />
      );
    case 'not-allowed':
      return (
        <EmptyState
          icon={Puzzle}
          headingLevel={2}
          headline="This page isn’t available yet"
          description={`${state.name} isn’t allowed to run yet.`}
          action={{ label: 'Allow it', ...openExtensions }}
        />
      );
    case 'turned-off':
      return (
        <EmptyState
          icon={Puzzle}
          headingLevel={2}
          headline="This page isn’t available"
          description={`${state.name} is turned off.`}
          action={{ label: 'Turn it on', ...openExtensions }}
        />
      );
    case 'broken':
      return (
        <EmptyState
          icon={AlertTriangle}
          tone="destructive"
          headingLevel={2}
          headline="This page isn’t available"
          description={`${state.name} couldn’t start. Settings says why.`}
          action={{ label: 'Open Settings', variant: 'outline', ...openExtensions }}
        />
      );
    case 'no-page':
      return (
        <EmptyState
          icon={PackageX}
          headingLevel={2}
          headline="This page isn’t available"
          description={`${state.name} doesn’t have this page.`}
        />
      );
  }
}
