import { useState } from 'react';
import type { LocalBrowserHistoryDirection, LocalBrowserState } from '@dorkos/shared/local-browser';
import { useOwnOrigins } from '@/layers/entities/config';
import { isThisAppsAddress, normalizeAddressInput } from '@/layers/shared/lib';
import { useTransport } from '@/layers/shared/model';
import { BrowserChrome, Button } from '@/layers/shared/ui';
import { useGuestPage } from '../model/use-guest-page';
import { searchAddress } from '../lib/page-error';
import { BrowserPageArea } from './BrowserPageArea';

/** Props for {@link LocalBrowserView}. */
export interface LocalBrowserViewProps {
  /** The tab the person is looking at, or `null` before one is chosen (no chrome then). */
  tab: LocalBrowserState['tabs'][number] | null;
  /** The live browser connection, which the embedded page follows. */
  connectionId: string | null;
  /** Whether the page sits in the panel (embedded) or in its own window. */
  embedded: boolean;
  /** Everything else that decides whether the native page may show. */
  pageVisible: boolean;
  /** Whether the native page could not be drawn. */
  surfaceUnavailable: boolean;
  /** The native page could not be drawn. */
  onUnavailable: () => void;
  /** Whether another browser action is running. */
  busy: boolean;
  /** Run a browser action through the panel, which owns busy and error. */
  action: (run: () => Promise<LocalBrowserState>) => Promise<boolean>;
  /** Open the browser again after the page could not be drawn. */
  onReconnect: () => void;
}

/**
 * The Agent browser's page: the shared browser chrome over the native page,
 * which runs flush to the panel's edges, in the page area that draws loads and
 * load failures (DOR-4430, DOR-4431). What the person types is read by the
 * shared address rules (DOR-4419); a refusal shows on the chrome's notice line
 * and keeps the typed text. Back and Forward move the page's own history on
 * the server, which re-checks every step against the same address rules and
 * takes the page from an agent that is driving it (DOR-4449); they are enabled
 * only when the server says there is an allowed page that way. Its buttons name themselves
 * with the browser's own hint, not a Radix tooltip, because the desktop host
 * hides the native page under any Radix popper (`use-native-browser-surface`).
 */
export function LocalBrowserView({
  tab,
  connectionId,
  embedded,
  pageVisible,
  surfaceUnavailable,
  onUnavailable,
  busy,
  action,
  onReconnect,
}: LocalBrowserViewProps) {
  const transport = useTransport();
  const ownOrigins = useOwnOrigins();
  // The embedded page's loads and failures (DOR-4430, DOR-4431): Reload turns
  // into Stop while it loads, and a failed load keeps its address in the bar.
  const page = useGuestPage(embedded ? connectionId : null);
  // What the person last typed and went to: only their own words are ever searched for.
  const [typed, setTyped] = useState<{ text: string; host: string } | null>(null);
  const typedFailed = !!typed && !!page.failure && page.failure.host === typed.host;
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

  /** Back or Forward. A refusal or a failure is the panel's to say, as for a navigation. */
  const step = (direction: LocalBrowserHistoryDirection) => {
    setRetry(null);
    void action(() => transport.stepLocalBrowserHistory(direction));
  };

  const submit = (tabId: string, url: string, text: string) => {
    const input = normalizeAddressInput(text, {
      current: url,
      isOwnAddress: (candidate) => isThisAppsAddress(candidate, window.location, ownOrigins),
    });
    if (input.kind === 'refused') {
      holdTyped(tabId, text, input.notice);
      return;
    }
    setRetry(null);
    if (input.kind === 'reload') {
      void go(url);
      return;
    }
    // Only an address the person typed is remembered, for "Search for it" if it fails.
    if (input.kind === 'open') setTyped({ text: text.trim(), host: new URL(input.url).host });
    // Only a real failure reopens the field: a navigation that Pause, Disconnect
    // or another tab replaced must not take focus back from where the person went.
    void go(input.url, input.kind === 'open' ? input.httpFallback : undefined).then((failed) => {
      if (failed) holdTyped(tabId, text, null);
    });
  };

  return (
    <div data-slot="local-browser-view" className="flex min-h-48 flex-1 flex-col">
      {tab && (
        <BrowserChrome
          // A failed load keeps its address in the bar, so Reload retries it (DOR-4430).
          url={page.failure?.url || tab.url}
          canBack={!busy && (tab.canGoBack ?? false)}
          canForward={!busy && (tab.canGoForward ?? false)}
          onBack={() => step('back')}
          onForward={() => step('forward')}
          onReload={() => void go(page.failure?.url || tab.url)}
          loading={page.loading}
          onStop={() => page.run('stop')}
          onSubmit={(text) => submit(tab.id, tab.url, text)}
          busy={busy}
          tooltips={false}
          retry={shownRetry}
          notice={shownRetry?.notice ?? null}
        />
      )}
      {embedded ? (
        <BrowserPageArea
          connectionId={connectionId}
          visible={pageVisible}
          page={page}
          typed={typedFailed}
          onSearch={() => {
            if (typed) void go(searchAddress(typed.text));
          }}
          onUnavailable={onUnavailable}
          disabled={busy}
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
        </BrowserPageArea>
      ) : (
        <p className="text-muted-foreground p-3 text-sm">
          This page is in the separate browser window.
        </p>
      )}
    </div>
  );
}
