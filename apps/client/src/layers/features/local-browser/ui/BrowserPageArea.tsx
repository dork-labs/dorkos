import { useRef, type ReactNode } from 'react';
import { useNativeBrowserSurface } from '../model/use-native-browser-surface';
import type { GuestPage } from '../model/use-guest-page';
import { pageErrorBlock, type PageErrorAction } from '../lib/page-error';
import { BrowserLoadingBar } from './BrowserLoadingBar';
import { PageErrorBlock } from './PageErrorBlock';
import { NativeBrowserStill } from './NativeBrowserStill';

/** Props for {@link BrowserPageArea}. */
interface BrowserPageAreaProps {
  connectionId: string | null;
  /** Everything else that decides whether the native page may show. */
  visible: boolean;
  page: GuestPage;
  /** Whether the person typed the address that failed; only then can it be searched for. */
  typed: boolean;
  /** Runs "Search for it" with the person's own words. */
  onSearch: () => void;
  onUnavailable: () => void;
  disabled?: boolean;
  /** What shows in place of the page when it couldn't be shown at all. */
  children?: ReactNode;
}

/**
 * The embedded page under the browser's controls: the loading seam, the native page, and the
 * block DorkOS draws in its place when a load fails (DOR-4430, DOR-4431). A failed page hides
 * the native view, so the block is never covered by Chromium's own error page.
 */
export function BrowserPageArea({
  connectionId,
  visible,
  page,
  typed,
  onSearch,
  onUnavailable,
  disabled,
  children,
}: BrowserPageAreaProps) {
  const surface = useRef<HTMLDivElement>(null);
  const block = page.failure ? pageErrorBlock(page.failure, typed) : null;
  // While an app layer covers the page, a still of it sits in its place (DOR-4438).
  const still = useNativeBrowserSurface(surface, connectionId, visible && !block, onUnavailable);
  const act = (action: PageErrorAction) => {
    if (action === 'search') onSearch();
    else page.run(action);
  };
  return (
    <div className="flex min-h-48 flex-1 flex-col">
      <BrowserLoadingBar loading={page.loading} />
      <div
        ref={surface}
        data-slot="native-browser-surface"
        className="bg-muted/20 relative min-h-48 flex-1 rounded-lg"
      >
        {block ? (
          <div className="absolute inset-0 flex overflow-y-auto p-4">
            <PageErrorBlock block={block} onAction={act} disabled={disabled} />
          </div>
        ) : (
          <>
            {still && <NativeBrowserStill still={still} />}
            {children}
          </>
        )}
      </div>
    </div>
  );
}
