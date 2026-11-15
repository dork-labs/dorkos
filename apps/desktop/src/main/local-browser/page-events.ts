import type { WebContents } from 'electron';
import { isWebLink } from '../window-manager';

/** The app's own read of one guest page: whether it is loading, and why its last load failed. */
export interface GuestPageState {
  connectionId: string;
  loading: boolean;
  /**
   * The last main-frame load that failed, until a page commits. `code` is Chromium's fixed
   * `ERR_…` code, or `CRASHED` when the page's process went away. `host` and `url` come from
   * the browser's own record of the request, never from what an agent asked for.
   */
  failure: { code: string; host: string; url: string } | null;
}

/** What the app may ask of a guest page. Retry loads only the address the browser recorded. */
type GuestPageAction = 'read' | 'stop' | 'retry' | 'back' | 'reload';
const ACTIONS = new Set<GuestPageAction>(['read', 'stop', 'retry', 'back', 'reload']);

/** Is `value` one of the actions the app may ask for? */
export function isGuestPageAction(value: unknown): value is GuestPageAction {
  return typeof value === 'string' && ACTIONS.has(value as GuestPageAction);
}

type Contents = Pick<
  WebContents,
  'on' | 'removeListener' | 'stop' | 'reload' | 'loadURL' | 'isLoading' | 'navigationHistory'
>;

/**
 * Follow one guest page's loads for the app's loading bar and error blocks (DOR-4430,
 * DOR-4431). `publish` gets the whole state on every change.
 *
 * @param connectionId - The guest's connection.
 * @param contents - The guest page.
 * @param publish - Sends the state to the window that shows the page.
 */
export function watchGuestPage(
  connectionId: string,
  contents: Contents,
  publish: (state: GuestPageState) => void
) {
  const state: GuestPageState = { connectionId, loading: false, failure: null };
  const read = (): GuestPageState => ({ ...state, failure: state.failure && { ...state.failure } });
  const send = () => publish(read());
  const onStart = () => {
    state.loading = true;
    send();
  };
  const onStop = () => {
    state.loading = false;
    send();
  };
  // The page a crash would take down, so the crash block can name it.
  let committed = '';
  // A page that commits, the error page aside, ends the failure: Electron emits
  // `did-navigate` only for pages that aren't the error page.
  const onNavigate = (_event: unknown, url: string) => {
    committed = url;
    if (!state.failure) return;
    state.failure = null;
    send();
  };
  const onFail = (
    _event: unknown,
    errorCode: number,
    errorDescription: string,
    validatedURL: string,
    isMainFrame: boolean
  ) => {
    if (!isMainFrame || !/^ERR_[A-Z0-9_]+$/.test(errorDescription)) return;
    if (errorDescription === 'ERR_ABORTED' || !isWebLink(validatedURL)) return;
    let host: string;
    try {
      host = new URL(validatedURL).host;
    } catch {
      return;
    }
    state.failure = { code: errorDescription, host, url: validatedURL };
    send();
  };
  const onGone = () => {
    const url = isWebLink(committed) ? committed : '';
    state.loading = false;
    state.failure = { code: 'CRASHED', host: url ? new URL(url).host : '', url };
    send();
  };
  contents.on('did-start-loading', onStart);
  contents.on('did-stop-loading', onStop);
  contents.on('did-navigate', onNavigate);
  contents.on('did-fail-load', onFail);
  contents.on('render-process-gone', onGone);
  return {
    /** The state as it stands. */
    read,
    /** Do what the app asked; anything that loads reports through `publish` as usual. */
    run(action: GuestPageAction): void {
      if (action === 'stop') contents.stop();
      else if (action === 'reload') contents.reload();
      else if (action === 'retry') {
        const url = state.failure?.url;
        if (url && isWebLink(url)) void contents.loadURL(url).catch(() => undefined);
      } else if (action === 'back') {
        if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
        else void contents.loadURL('about:blank').catch(() => undefined);
      }
    },
    dispose(): void {
      contents.removeListener('did-start-loading', onStart);
      contents.removeListener('did-stop-loading', onStop);
      contents.removeListener('did-navigate', onNavigate);
      contents.removeListener('did-fail-load', onFail);
      contents.removeListener('render-process-gone', onGone);
    },
  };
}
