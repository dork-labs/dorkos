import { useState, type ReactNode, type RefObject } from 'react';
import type { LocalBrowserState } from '@dorkos/shared/local-browser';
import { useOwnOrigins } from '@/layers/entities/config';
import { isThisAppsAddress, normalizeAddressInput } from '@/layers/shared/lib';
import { useTransport } from '@/layers/shared/model';
import { BrowserChrome, Button } from '@/layers/shared/ui';

/** Props for {@link LocalBrowserView}. */
export interface LocalBrowserViewProps {
  /** The tab the person is looking at, or `null` before one is chosen (no chrome then). */
  tab: LocalBrowserState['tabs'][number] | null;
  /** Whether the page sits in the panel (embedded) or in its own window. */
  embedded: boolean;
  /** Where the desktop host draws the native page, when embedded. */
  surface: RefObject<HTMLDivElement | null>;
  /** Whether the native page could not be drawn. */
  surfaceUnavailable: boolean;
  /** Whether another browser action is running. */
  busy: boolean;
  /** Run a browser action through the panel, which owns busy and error. */
  action: (run: () => Promise<LocalBrowserState>) => Promise<boolean>;
  /** Open the browser again after the page could not be drawn. */
  onReconnect: () => void;
  /** The status pill, in the chrome's pill place. */
  status?: ReactNode;
  /** Whether an agent drives the page now, which turns the seam orange. */
  agentDriving?: boolean;
}

/**
 * The Agent browser's page: the shared browser chrome over the native page,
 * which runs flush to the panel's edges. What the person types is read by the
 * shared address rules (DOR-4419); a refusal shows on the chrome's notice line
 * and keeps the typed text. Back and Forward stay disabled until the page's own
 * history can be moved (DOR-4449). Its buttons name themselves
 * with the browser's own hint, not a Radix tooltip, because the desktop host
 * hides the native page under any Radix popper (`use-native-browser-surface`).
 */
export function LocalBrowserView({
  tab,
  embedded,
  surface,
  surfaceUnavailable,
  busy,
  action,
  onReconnect,
  status,
  agentDriving = false,
}: LocalBrowserViewProps) {
  const transport = useTransport();
  const ownOrigins = useOwnOrigins();
  /**
   * What was typed, held when it did not open so the field reopens on it, with
   * the notice when the address rules refused it. A navigation that failed has
   * no notice here: the panel says why.
   */
  const [retry, setRetry] = useState<{
    tabId: string;
    draft: string;
    attempt: number;
    notice: string | null;
  } | null>(null);
  const holdTyped = (tabId: string, typed: string, notice: string | null) =>
    setRetry((last) => ({ tabId, draft: typed.trim(), attempt: (last?.attempt ?? 0) + 1, notice }));
  // What was held belongs to the tab it was typed in; another tab starts clean.
  const shownRetry = retry && tab && retry.tabId === tab.id ? retry : null;

  /** Navigate, and answer whether it failed: an action a newer one replaced did not. */
  const go = async (url: string, fallback?: string) => {
    let failed = false;
    await action(async () => {
      try {
        return await transport.navigateLocalBrowser(url);
      } catch (cause) {
        // Only a bare host the person typed carries a fallback, and only a page
        // that could not connect at all tries it, once (DOR-4419).
        const code = (cause as { code?: string } | null)?.code;
        if (fallback && code === 'navigation_unreachable') {
          try {
            return await transport.navigateLocalBrowser(fallback);
          } catch (again) {
            failed = true;
            throw again;
          }
        }
        failed = true;
        throw cause;
      }
    });
    return failed;
  };

  const submit = (tabId: string, url: string, typed: string) => {
    const input = normalizeAddressInput(typed, {
      current: url,
      isOwnAddress: (candidate) => isThisAppsAddress(candidate, window.location, ownOrigins),
    });
    if (input.kind === 'refused') {
      holdTyped(tabId, typed, input.notice);
      return;
    }
    setRetry(null);
    if (input.kind === 'reload') {
      void go(url);
      return;
    }
    // Only a real failure reopens the field: a navigation that Pause, Disconnect
    // or another tab replaced must not take focus back from where the person went.
    void go(input.url, input.kind === 'open' ? input.httpFallback : undefined).then((failed) => {
      if (failed) holdTyped(tabId, typed, null);
    });
  };

  return (
    <div data-slot="local-browser-view" className="flex min-h-48 flex-1 flex-col">
      {tab && (
        <BrowserChrome
          url={tab.url}
          canBack={false}
          canForward={false}
          onReload={() => void go(tab.url)}
          onSubmit={(typed) => submit(tab.id, tab.url, typed)}
          busy={busy}
          tooltips={false}
          retry={shownRetry}
          notice={shownRetry?.notice ?? null}
          status={status}
          agentDriving={agentDriving}
        />
      )}
      {embedded ? (
        <div
          ref={surface}
          data-slot="native-browser-surface"
          className="bg-muted/20 relative min-h-48 flex-1"
        >
          {surfaceUnavailable && (
            <div className="space-y-2 p-3">
              <p role="alert" className="text-sm">
                Couldn’t show the page. Reconnect to try again.
              </p>
              <Button size="sm" variant="outline" onClick={onReconnect} disabled={busy}>
                Reconnect
              </Button>
            </div>
          )}
        </div>
      ) : (
        <p className="text-muted-foreground p-3 text-sm">
          This page is in the separate browser window.
        </p>
      )}
    </div>
  );
}
