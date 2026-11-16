/**
 * A tab's own Back and Forward (DOR-4449). A history step is a navigation like
 * any other, so it runs the same address rules: the entry it lands on is
 * checked before the step, every document load on the way (a redirect
 * included) is refused while it runs, and where the page ends up is checked
 * again after. An entry that was fine when it was visited can redirect
 * somewhere refused today, so the first check alone is never enough.
 */
import type { CDPSession, Page } from 'playwright-core';
import type { LocalBrowserHistoryDirection } from '@dorkos/shared/local-browser';
import { LocalBrowserError } from '../errors.js';

/** A tab's history as the browser keeps it: every entry's address, and which one is open. */
export interface PageHistoryEntries {
  index: number;
  entries: readonly { url: string }[];
}

/** Whether a step reached its entry, or a load on the way was refused. */
export type HistoryStepOutcome = 'moved' | 'refused';

/** How one kind of browser reads and moves a tab's history. */
export interface PageHistoryPort {
  /** Read the tab's history. */
  read(page: Page): Promise<PageHistoryEntries>;
  /**
   * Move to entry `index`, which must still show `url`, refusing any document
   * load `allowed` refuses while the step runs. Settles once the page has moved
   * or a load was refused.
   */
  go(
    page: Page,
    index: number,
    url: string,
    allowed: (url: string) => boolean
  ): Promise<HistoryStepOutcome>;
  /** Load `url` as a new page, under the same guard as {@link go}. */
  load(page: Page, url: string, allowed: (url: string) => boolean): Promise<HistoryStepOutcome>;
}

/** How long a step may take before it is called uncertain. */
const HISTORY_STEP_TIMEOUT_MS = 15_000;
/** How long the panel's state read waits on history before saying neither way is open. */
const HISTORY_READ_TIMEOUT_MS = 1_000;
/** How long a refused step waits for Chromium's error page to land before moving on. */
const REFUSED_SETTLE_MS = 3_000;

/** Resolve after `ms`, whatever else happens. */
function settle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The nearest entry each way that the rules still allow. A refused entry is
 * skipped rather than landed on, so Back never walks into a refused page and
 * never strands the person behind one either.
 *
 * @param history - The tab's history.
 * @param allowed - The address rule.
 */
export function historyTargets(
  history: PageHistoryEntries,
  allowed: (url: string) => boolean
): { back: number | null; forward: number | null } {
  const { index, entries } = history;
  let back: number | null = null;
  for (let at = index - 1; at >= 0; at -= 1)
    if (allowed(entries[at]!.url)) {
      back = at;
      break;
    }
  let forward: number | null = null;
  for (let at = index + 1; at < entries.length; at += 1)
    if (allowed(entries[at]!.url)) {
      forward = at;
      break;
    }
  return { back, forward };
}

/** The refusal for a step whose page, or a load on the way to it, is refused. */
export function historyRefusal(): LocalBrowserError {
  return new LocalBrowserError(
    'history_refused',
    'DorkOS doesn’t open that page here, so you stayed on this one.'
  );
}

/**
 * Move a tab one allowed step back or forward and check where it landed. When
 * a load on the way was refused, or the landing is refused (a redirect only
 * the post-check saw), the person is put back on the page they were on, and
 * the step is refused. Chromium shows a refused load as an error page in the
 * entry the person was on, so putting them back is a fresh, guarded load.
 *
 * @param page - The selected tab.
 * @param port - How this browser reads and moves history.
 * @param direction - Back or Forward.
 * @param allowed - The address rule every load and landing must pass.
 */
export async function stepPageHistory(
  page: Page,
  port: PageHistoryPort,
  direction: LocalBrowserHistoryDirection,
  allowed: (url: string) => boolean
): Promise<void> {
  const history = await port.read(page);
  const target = historyTargets(history, allowed)[direction];
  if (target === null)
    throw new LocalBrowserError(
      'no_history',
      direction === 'back' ? 'There’s no page to go back to.' : 'There’s no page to go forward to.'
    );
  let outcome: HistoryStepOutcome;
  try {
    outcome = await port.go(page, target, history.entries[target]!.url, allowed);
  } catch (error) {
    // A step that failed or ran out of time may still have moved the page: check it.
    if (allowed(page.url())) throw error;
    outcome = 'refused';
  }
  if (outcome === 'moved' && allowed(page.url())) return;
  const origin = history.entries[history.index]!.url;
  // A load refused before anything committed left the person's page as it was.
  const after = await port.read(page).catch(() => null);
  const stayed = after?.index === history.index && after.entries[history.index]?.url === origin;
  if (stayed && allowed(page.url())) throw historyRefusal();
  const restored = allowed(origin)
    ? await port.load(page, origin, allowed).catch(() => 'refused' as const)
    : 'refused';
  if (restored !== 'moved' || !allowed(page.url()))
    await page.goto('about:blank', { waitUntil: 'commit', timeout: HISTORY_STEP_TIMEOUT_MS });
  throw historyRefusal();
}

/**
 * Whether Back and Forward each have an allowed page to go to. A history the
 * browser can't read right now says no to both rather than guess.
 *
 * @param page - The selected tab.
 * @param port - How this browser reads history.
 * @param allowed - The address rule.
 */
export async function historyAvailability(
  page: Page,
  port: PageHistoryPort,
  allowed: (url: string) => boolean
): Promise<{ canGoBack: boolean; canGoForward: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('History read timed out')), HISTORY_READ_TIMEOUT_MS);
  });
  try {
    const targets = historyTargets(await Promise.race([port.read(page), late]), allowed);
    return { canGoBack: targets.back !== null, canGoForward: targets.forward !== null };
  } catch {
    return { canGoBack: false, canGoForward: false };
  } finally {
    clearTimeout(timer);
  }
}

/** The history entry a step must find before it moves, or a refusal that history moved. */
function historyChanged(): LocalBrowserError {
  return new LocalBrowserError('history_changed', 'The page’s history changed. Try again.');
}

/** Fetch's paused-request event, as far as a history step reads it. */
interface PausedDocument {
  requestId: string;
  frameId: string;
  request: { url: string };
}

/**
 * History over the Chrome DevTools Protocol, for the agent's own window. While
 * a step runs, every document request (each redirect hop included) is paused
 * and refused when the rule refuses its address, before anything loads.
 */
export function cdpPageHistory(): PageHistoryPort {
  const sessions = new WeakMap<Page, Promise<CDPSession>>();
  const session = (page: Page): Promise<CDPSession> => {
    let open = sessions.get(page);
    if (!open) {
      open = page.context().newCDPSession(page);
      sessions.set(page, open);
      open.catch(() => sessions.delete(page));
      page.once('close', () => sessions.delete(page));
    }
    return open;
  };
  return {
    async read(page) {
      const { currentIndex, entries } = await (
        await session(page)
      ).send('Page.getNavigationHistory');
      return { index: currentIndex, entries: entries.map(({ url }) => ({ url })) };
    },
    async go(page, index, url, allowed) {
      const cdp = await session(page);
      const { entries } = await cdp.send('Page.getNavigationHistory');
      const entry = entries[index];
      if (!entry || entry.url !== url) throw historyChanged();
      if (!allowed(entry.url)) return 'refused';
      return guarded(page, cdp, allowed, () =>
        cdp.send('Page.navigateToHistoryEntry', { entryId: entry.id })
      );
    },
    async load(page, url, allowed) {
      if (!allowed(url)) return 'refused';
      const cdp = await session(page);
      return guarded(page, cdp, allowed, () =>
        page.goto(url, { waitUntil: 'commit', timeout: HISTORY_STEP_TIMEOUT_MS })
      );
    },
  };
}

/**
 * Run one navigation with every document request paused and refused when the
 * rule refuses its address, and settle once the page moved or a load was refused.
 */
async function guarded(
  page: Page,
  cdp: CDPSession,
  allowed: (url: string) => boolean,
  navigate: () => Promise<unknown>
): Promise<HistoryStepOutcome> {
  let refuse: () => void = () => undefined;
  const refused = new Promise<'refused'>((resolve) => {
    refuse = () => resolve('refused');
  });
  let mainFrameId: string | undefined;
  const onPaused = ({ requestId, frameId, request }: PausedDocument) => {
    const ok = allowed(request.url);
    // Every refused document is refused; only the page's own load refuses the step.
    if (!ok && frameId === mainFrameId) refuse();
    const answer = ok
      ? cdp.send('Fetch.continueRequest', { requestId })
      : cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
    void answer.catch(() => undefined);
  };
  cdp.on('Fetch.requestPaused', onPaused);
  try {
    mainFrameId = (await cdp.send('Page.getFrameTree')).frameTree.frame.id;
    await cdp.send('Fetch.enable', {
      patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }],
    });
    const landed = page
      .waitForEvent('framenavigated', {
        predicate: (frame) => frame === page.mainFrame(),
        timeout: HISTORY_STEP_TIMEOUT_MS,
      })
      .then(() => 'moved' as const);
    landed.catch(() => undefined);
    // A refused load can fail the navigation call itself; the refusal still wins.
    const moving = navigate();
    moving.catch(() => undefined);
    await Promise.race([moving, refused]);
    const outcome = await Promise.race([landed, refused]);
    // A refused load still commits Chromium's error page a moment later. Let it
    // land before anything else moves the page, or that move is interrupted.
    if (outcome === 'refused') await Promise.race([landed, settle(REFUSED_SETTLE_MS)]);
    return outcome;
  } catch (error) {
    // Stop the load while every request is still guarded, so nothing commits after.
    await cdp.send('Page.stopLoading').catch(() => undefined);
    if (error instanceof LocalBrowserError) throw error;
    throw new LocalBrowserError(
      'navigation_uncertain',
      'Couldn’t finish opening the page. Check the browser.'
    );
  } finally {
    // Disable before letting go, so no paused request is left unanswered.
    await cdp.send('Fetch.disable').catch(() => undefined);
    cdp.off('Fetch.requestPaused', onPaused);
  }
}

/** The Mac app's side of history: it reads, re-checks and moves its native page itself. */
export interface EmbeddedHistoryBridge {
  history(refused: readonly string[]): Promise<PageHistoryEntries>;
  goToHistory(index: number, url: string, refused: readonly string[]): Promise<HistoryStepOutcome>;
}

/**
 * History for the Mac app's native page. The app's main process re-checks the
 * entry and refuses refused loads and redirects itself (`page-history.ts` in
 * the desktop app), against DorkOS's full list of its own addresses, which
 * every call hands it; the landing check in {@link stepPageHistory} backs it up.
 *
 * @param bridge - The desktop bridge's history calls for this page; throws on a Mac app too old to have them.
 * @param refused - DorkOS's own addresses, as `localBrowserAppOrigins` lists them.
 */
export function embeddedPageHistory(
  bridge: () => EmbeddedHistoryBridge,
  refused: () => readonly string[]
): PageHistoryPort {
  return {
    read: async () => bridge().history(refused()),
    async go(page, index, url, allowed) {
      if (!allowed(url)) return 'refused';
      const landed = page
        .waitForEvent('framenavigated', {
          predicate: (frame) => frame === page.mainFrame(),
          timeout: HISTORY_STEP_TIMEOUT_MS,
        })
        .catch(() => undefined);
      const outcome = await bridge().goToHistory(index, url, refused());
      // The host answers once its page moved; let this connection see the move too.
      if (outcome === 'moved') await landed;
      return outcome;
    },
    // The host refuses a refused redirect itself (its `will-redirect` guard).
    async load(page, url, allowed) {
      if (!allowed(url)) return 'refused';
      try {
        await page.goto(url, { waitUntil: 'commit', timeout: HISTORY_STEP_TIMEOUT_MS });
        return 'moved';
      } catch {
        return 'refused';
      }
    },
  };
}
