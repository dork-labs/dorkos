import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  LocalBrowserHistoryDirection,
  LocalBrowserSignIn,
  LocalBrowserState,
} from '@dorkos/shared/local-browser';
import { useOwnOrigins } from '@/layers/entities/config';
import { isThisAppsAddress, normalizeAddressInput } from '@/layers/shared/lib';
import { useTransport } from '@/layers/shared/model';
import { BrowserChrome, Button } from '@/layers/shared/ui';
import { useBrowserKeys } from '../model/use-browser-keys';
import { useGuestPage } from '../model/use-guest-page';
import type { NativeStillControls } from '../model/use-native-browser-surface';
import { searchAddress } from '../lib/page-error';
import { browserErrorMessage } from '../lib/browser-error-message';
import { refusalNotice } from '../lib/refusal-notice';
import { BrowserPageArea } from './BrowserPageArea';
import { RefusalNotice } from './RefusalNotice';
import { PageAreaBlock } from './PageAreaBlock';

/** The address of a new empty page. */
export const EMPTY_PAGE = 'about:blank';

/** What a new empty page says in its place (DOR-4420 spec §9). */
const EMPTY_PAGE_LINE = 'Type an address or a search above.';

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
  /** The status pill, in the chrome's pill place. */
  status?: ReactNode;
  /** Whether an agent drives the page now, which turns the seam orange. */
  agentDriving?: boolean;
  /**
   * Take the page from an agent that has it, before a chrome action the server
   * doesn't see (Stop). Reload and Enter navigate, which takes it on the server.
   */
  onTakeOver?: () => void;
  /**
   * The chrome's ⋯ menu, given the row's own Forward, which the menu offers
   * while the row is too narrow to show it.
   */
  menu?: (forward: { canForward: boolean; onForward: () => void }) => ReactNode;
  /** The latest plain-window sign-in, so a saved one can offer its own window (DOR-4097). */
  signIn?: LocalBrowserSignIn | null;
  /** Go on with this page in its own window, where a saved sign-in is (DOR-4097). */
  onOpenOwnWindow?: (url: string) => void;
}

/**
 * The Agent browser's page: the shared browser chrome over the native page,
 * which runs flush to the panel's edges, in the page area that draws loads and
 * load failures (DOR-4430, DOR-4431). What the person types is read by the
 * shared address rules (DOR-4419); a refusal shows on the chrome's notice line
 * and keeps the typed text. Back and Forward move the page's own history on
 * the server, which re-checks every step against the same address rules and
 * takes the page from an agent that is driving it (DOR-4449); they are enabled
 * only when the server says there is an allowed page that way. A button's
 * tooltip opens only once a still of the page is drawn under it (DOR-4438), so
 * the page never blinks out; with no still, the button keeps a plain hint.
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
  status,
  agentDriving = false,
  onTakeOver,
  menu,
  signIn,
  onOpenOwnWindow,
}: LocalBrowserViewProps) {
  const transport = useTransport();
  const ownOrigins = useOwnOrigins();
  // The embedded page's loads and failures (DOR-4430, DOR-4431): Reload turns
  // into Stop while it loads, and a failed load keeps its address in the bar.
  const page = useGuestPage(embedded ? connectionId : null);
  // A site refusing this browser (DOR-4097). Dismiss holds for this page only.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const refused =
    tab &&
    refusalNotice({
      refusal: page.refusal,
      url: tab.url,
      failure: page.failure,
      signIn,
      dismissed,
    });
  const answerRefusal = () => {
    if (!refused || !tab) return;
    if (refused.action.kind === 'own-window') onOpenOwnWindow?.(tab.url);
    // The plain window opens on the site's origin, never the page's own path.
    else void action(() => transport.signInLocalBrowser({ url: new URL(tab.url).origin }));
  };
  const [focusAddress, setFocusAddress] = useState(0);
  // What the person last typed and went to: only their own words are ever searched for.
  const [typed, setTyped] = useState<{ text: string; host: string } | null>(null);
  const typedFailed = !!typed && !!page.failure && page.failure.host === typed.host;
  // A tooltip over the embedded page opens only once a still of the page is under it,
  // so the page never blinks out; with no still, the button keeps a plain hint.
  const stillControls = useRef<NativeStillControls | null>(null);
  const keepStillControls = useCallback((controls: NativeStillControls | null) => {
    stillControls.current = controls;
  }, []);
  const tooltipStill = useMemo(
    () => ({
      prepare: () => stillControls.current?.prepare() ?? Promise.resolve(false),
      release: () => stillControls.current?.release(),
    }),
    []
  );
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
  /** Why the last Back or Forward was refused, on the notice line like a refused address (spec §6). */
  const [stepNotice, setStepNotice] = useState<{ tabId: string; text: string } | null>(null);
  const shownStepNotice = stepNotice && tab && stepNotice.tabId === tab.id ? stepNotice.text : null;

  /** Navigate once, asking the server for the bare-host fallback when allowed. */
  const go = async (url: string, fallback = false) => {
    let failed = false;
    await action(async () => {
      try {
        return await (fallback
          ? transport.navigateLocalBrowser(url, { httpFallback: true })
          : transport.navigateLocalBrowser(url));
      } catch (cause) {
        failed = true;
        throw cause;
      }
    });
    return failed;
  };

  /**
   * Back or Forward. A step the address rules refused says so on the notice line,
   * as a refused address does, and the page stays where it was; any other failure
   * is the panel's to say, as for a navigation.
   */
  const step = (direction: LocalBrowserHistoryDirection) => {
    setRetry(null);
    setStepNotice(null);
    const tabId = tab?.id;
    void action(async () => {
      try {
        return await transport.stepLocalBrowserHistory(direction);
      } catch (cause) {
        if ((cause as { code?: string } | null)?.code !== 'history_refused' || !tabId) throw cause;
        setStepNotice({ tabId, text: browserErrorMessage(cause) });
        return transport.getLocalBrowserState();
      }
    });
  };

  const submit = (tabId: string, url: string, text: string) => {
    const input = normalizeAddressInput(text, {
      current: url,
      isOwnAddress: (candidate) => isThisAppsAddress(candidate, window.location, ownOrigins),
    });
    setStepNotice(null);
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
    void go(input.url, input.kind === 'open' && Boolean(input.httpFallback)).then((failed) => {
      if (failed) holdTyped(tabId, text, null);
    });
  };

  const canForward = !busy && (tab?.canGoForward ?? false);
  const onForward = () => step('forward');

  // The browser's keys, with focus in the panel or forwarded from the page (DOR-4432).
  const onKeyDown = useBrowserKeys({
    connectionId: embedded ? connectionId : null,
    loading: page.loading,
    // Each answers whether it acted, so a key with nothing to do is left to the app.
    onFocusAddress: () => {
      if (!tab) return false;
      setFocusAddress((request) => request + 1);
      return true;
    },
    onReload: () => {
      if (!tab || busy) return false;
      void go(page.failure?.url || tab.url);
      return true;
    },
    onBack: () => {
      if (!tab || busy || !tab.canGoBack) return false;
      step('back');
      return true;
    },
    onForward: () => {
      if (!canForward) return false;
      onForward();
      return true;
    },
    onStop: () => {
      if (!tab) return false;
      page.run('stop');
      return true;
    },
    onCopyAddress: () => {
      if (!tab || !navigator.clipboard) return false;
      void navigator.clipboard.writeText(page.failure?.url || tab.url).catch(() => undefined);
      return true;
    },
  });

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- the panel's keys reach it from the controls inside; it takes no focus itself
    <div
      data-slot="local-browser-view"
      // Esc here reverts the address or stops a load; it never closes the sheet around it.
      data-keeps-escape
      onKeyDown={onKeyDown}
      className="flex min-h-48 flex-1 flex-col"
    >
      {tab && (
        <BrowserChrome
          // A failed load keeps its address in the bar, so Reload retries it (DOR-4430).
          url={page.failure?.url || tab.url}
          openedOverHttp={tab.openedOverHttp}
          focusAddress={focusAddress}
          canBack={!busy && (tab.canGoBack ?? false)}
          canForward={canForward}
          onBack={() => step('back')}
          onForward={onForward}
          onReload={() => void go(page.failure?.url || tab.url)}
          loading={page.loading}
          onStop={() => {
            // Stopping is using the page, so it takes it from the agent too (DOR-4428).
            page.run('stop');
            onTakeOver?.();
          }}
          onSubmit={(text) => submit(tab.id, tab.url, text)}
          busy={busy}
          tooltipStill={embedded ? tooltipStill : undefined}
          retry={shownRetry}
          notice={shownRetry?.notice ?? shownStepNotice}
          pageNotice={
            refused && (
              <RefusalNotice
                notice={refused}
                onAction={answerRefusal}
                onDismiss={() => setDismissed(refused.key)}
                disabled={busy}
              />
            )
          }
          status={status}
          agentDriving={agentDriving}
          menu={menu?.({ canForward, onForward })}
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
          // With no allowed page behind, "Go back" opens an empty page instead.
          onBack={() => (tab?.canGoBack ? step('back') : void go('about:blank'))}
          onUnavailable={onUnavailable}
          disabled={busy}
          onStillControls={keepStillControls}
        >
          {surfaceUnavailable ? (
            <div className="absolute inset-0 flex flex-col">
              <PageAreaBlock>
                <p role="alert" className="text-sm">
                  Couldn’t show the page. Reconnect to try again.
                </p>
                <Button size="sm" variant="outline" onClick={onReconnect} disabled={busy}>
                  Reconnect
                </Button>
              </PageAreaBlock>
            </div>
          ) : (
            tab?.url === EMPTY_PAGE && (
              // The panel keeps the native page hidden while it is empty, so this shows.
              <div className="absolute inset-0 flex flex-col">
                <PageAreaBlock>
                  <p className="text-muted-foreground text-center text-sm">{EMPTY_PAGE_LINE}</p>
                </PageAreaBlock>
              </div>
            )
          )}
        </BrowserPageArea>
      ) : (
        <PageAreaBlock>
          <p className="text-muted-foreground text-center text-sm">
            This page is in the separate browser window.
          </p>
        </PageAreaBlock>
      )}
    </div>
  );
}
