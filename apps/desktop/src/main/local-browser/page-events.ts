import type { WebContents } from 'electron';
import { classifyRefusal, type LocalBrowserRefusal } from '@dorkos/shared/local-browser-refusal';
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
  /**
   * The page the browser shows is a site refusing this browser (DOR-4097), read from its
   * committed address and title only. The host is from the address, never the page.
   */
  refusal: LocalBrowserRefusal | null;
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
  | 'on'
  | 'removeListener'
  | 'stop'
  | 'reload'
  | 'loadURL'
  | 'isLoading'
  | 'navigationHistory'
  | 'executeJavaScriptInIsolatedWorld'
>;

/**
 * DOR-4662: "Access Denied" is any site's 403 title; only Akamai's reference host on the
 * page makes it a block. The shell asks that one question in a script world of its own,
 * which the page's scripts can't reach (999 is Electron's own), and hears only yes or no.
 */
const AKAMAI_TITLE = /^access denied$/i;
const PROBE_WORLD = 1407;
const PROBE_TIMEOUT_MS = 500;
const AKAMAI_PROBE =
  "document.documentElement !== null && document.documentElement.textContent.includes('errors.edgesuite.net')";

/** Whether the page names Akamai's reference: true only for a real true, in time. */
async function namesAkamaiReference(contents: Contents): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), PROBE_TIMEOUT_MS);
  });
  try {
    const asked = contents
      .executeJavaScriptInIsolatedWorld(PROBE_WORLD, [{ code: AKAMAI_PROBE }])
      .then((answer: unknown) => answer === true)
      .catch(() => false);
    return await Promise.race([asked, late]);
  } finally {
    clearTimeout(timer);
  }
}

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
  const state: GuestPageState = { connectionId, loading: false, failure: null, refusal: null };
  const read = (): GuestPageState => ({
    ...state,
    failure: state.failure && { ...state.failure },
    refusal: state.refusal && { ...state.refusal },
  });
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
  let title = '';
  // The Akamai check's answer, for this page only: any commit starts a new page.
  let akamaiReference = false;
  let page = 0;
  // Re-read the refusal from the committed page; publish only when it changed.
  const recheck = (): boolean => {
    const next = isWebLink(committed)
      ? classifyRefusal({ url: committed, title, akamaiReference })
      : null;
    if (next?.kind === state.refusal?.kind && next?.host === state.refusal?.host) return false;
    state.refusal = next;
    return true;
  };
  // A page that commits, the error page aside, ends the failure: Electron emits
  // `did-navigate` only for pages that aren't the error page.
  const onNavigate = (_event: unknown, url: string) => {
    committed = url;
    title = '';
    akamaiReference = false;
    page += 1;
    const refusalChanged = recheck();
    if (!state.failure && !refusalChanged) return;
    state.failure = null;
    send();
  };
  const onInPage = (_event: unknown, url: string, isMainFrame: boolean) => {
    if (!isMainFrame) return;
    committed = url;
    akamaiReference = false;
    page += 1;
    if (recheck()) send();
  };
  const onTitle = (_event: unknown, next: string) => {
    title = next;
    if (recheck()) send();
    if (!AKAMAI_TITLE.test(next.trim()) || !isWebLink(committed)) return;
    const asking = page;
    void namesAkamaiReference(contents).then((names) => {
      // An answer for a page the browser has since left belongs to nobody.
      if (asking !== page || !names) return;
      akamaiReference = true;
      if (recheck()) send();
    });
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
  contents.on('did-navigate-in-page', onInPage);
  contents.on('page-title-updated', onTitle);
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
      contents.removeListener('did-navigate-in-page', onInPage);
      contents.removeListener('page-title-updated', onTitle);
      contents.removeListener('did-fail-load', onFail);
      contents.removeListener('render-process-gone', onGone);
    },
  };
}
