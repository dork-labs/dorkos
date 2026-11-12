import { randomUUID } from 'node:crypto';
import type { LocalBrowserAuditRecord, LocalBrowserAuditWriter } from './action-audit.js';
import type { Page, JSHandle } from 'playwright-core';
import type { LocalBrowserAction, LocalBrowserObservation } from '@dorkos/shared/local-browser';
import { LocalBrowserError } from './errors.js';
import { boundedPageSnapshot } from './observation-limits.js';
import { responseDeadline } from './lifecycle.js';
import type { ObservedPageNodes } from './observation-nodes.js';
import { isInertFillTarget } from './inert-target.js';

/** Each durable journal wait has its own budget, separate from the action effect deadline. */
export const AUDIT_WRITE_RESPONSE_TIMEOUT_MS = 2_000;
const ACTION_TIMEOUT_MS = 750;
/**
 * How long a click or key press waits for a page load it started to commit or fail. Inside the
 * action's whole budget (`ACTION_EFFECT_RESPONSE_TIMEOUT_MS`); a load still going after this is
 * left to the agent's next read.
 */
export const LOAD_SETTLE_MS = 1_000;
/** How long after a click or key press the browser has to start a page load at all. */
export const LOAD_START_MS = 150;
/** The address Chromium shows in place of a page that failed to load. */
const BROWSER_ERROR_PAGE = /^chrome-error:/i;

/** Wait for `promise`, or `ms`, whichever comes first. */
async function within(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    promise,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  clearTimeout(timer);
}

/** Chromium's fixed code for a load it refused, and nothing else of its error text. */
function netErrorCode(reason: string | undefined): string | undefined {
  return /net::(ERR_[A-Z0-9_]+)/.exec(reason ?? '')?.[1];
}

/**
 * The error an agent gets when its action opened a page that didn't load. It names only the host
 * of the request the browser made (never its path or query, which can hold a token) and
 * Chromium's fixed `ERR_…` code: nothing from the page, the response or the error page.
 *
 * @param url - The address the browser requested.
 * @param reason - Chromium's error text for the request, if any.
 */
export function loadFailedError(url: string | undefined, reason: string | undefined) {
  let host: string | undefined;
  try {
    host = url ? new URL(url).host || undefined : undefined;
  } catch {
    host = undefined;
  }
  const code = netErrorCode(reason);
  const why = code ? ` (${code})` : '';
  return new LocalBrowserError(
    'load_failed',
    host
      ? `${host} didn’t load${why}. Read the page again.`
      : `The page didn’t load${why}. Read the page again.`
  );
}

/**
 * Watch the tab's main frame for a load an effect starts, from before the effect is sent. After
 * it, `settle()` waits up to {@link LOAD_SETTLE_MS} for a started load to commit or fail, then
 * throws {@link loadFailedError} when the tab ended on the browser's error page.
 */
function watchMainFrameLoad(page: Page): { settle: () => Promise<void>; stop: () => void } {
  let started = false;
  let failed: { url: string; reason?: string } | undefined;
  let done!: () => void;
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });
  let begun!: () => void;
  const starting = new Promise<void>((resolve) => {
    begun = resolve;
  });
  const isMainLoad = (request: import('playwright-core').Request): boolean => {
    try {
      return request.isNavigationRequest() && request.frame() === page.mainFrame();
    } catch {
      return false;
    }
  };
  const onRequest = (request: import('playwright-core').Request) => {
    if (!isMainLoad(request)) return;
    started = true;
    begun();
  };
  const onFailed = (request: import('playwright-core').Request) => {
    if (!isMainLoad(request)) return;
    const reason = request.failure()?.errorText;
    // A download, or a load the page replaced with another, ends as "aborted". Not a failure.
    if (reason && /ERR_ABORTED/i.test(reason)) return;
    failed = { url: request.url(), reason };
    done();
  };
  const onNavigated = (frame: import('playwright-core').Frame) => {
    if (frame === page.mainFrame()) done();
  };
  const stop = () => {
    page.off('request', onRequest);
    page.off('requestfailed', onFailed);
    page.off('framenavigated', onNavigated);
  };
  page.on('request', onRequest);
  page.on('requestfailed', onFailed);
  page.on('framenavigated', onNavigated);
  return {
    stop,
    settle: async () => {
      try {
        // The browser starts the load a moment after the input lands, so give it that moment.
        if (!started) await within(starting, LOAD_START_MS);
        if (started && !failed) await within(finished, LOAD_SETTLE_MS);
      } finally {
        stop();
      }
      if (failed || BROWSER_ERROR_PAGE.test(page.url()))
        throw loadFailedError(failed?.url, failed?.reason);
    },
  };
}

/**
 * The acts an agent may take without a current page read: the ways to leave a page, so a page it
 * can't read never locks it in (DOR-4192, Security's ruling). Every other act needs the revision
 * from the read it acts on. A close-tab act, when agents get one, belongs here too.
 */
export const LEAVE_ACTIONS: ReadonlySet<LocalBrowserAction['kind']> = new Set(['navigate']);

/**
 * The revision an act is fenced at, or a stale refusal. An act on the page needs the read it
 * names to be the current one. A leave needs no read: it is fenced at the current revision, so a
 * pause or a closing browser while it runs still stops it.
 *
 * @param input - The agent's act.
 * @param observed - The current read, if any.
 * @param hasNodes - Whether that read's node identities are held.
 * @param revision - The browser's current revision.
 * @param stale - Builds the stale-page refusal.
 */
export function actionFence(
  input: LocalBrowserAction,
  observed: LocalBrowserObservation | undefined,
  hasNodes: boolean,
  revision: number,
  stale: () => LocalBrowserError
): number {
  if (LEAVE_ACTIONS.has(input.kind)) return revision;
  if (!observed || !hasNodes || input.revision !== revision || observed.revision !== revision)
    throw stale();
  return input.revision;
}

/** Execute only on the observed DOM identity, with re-admission before every effect. */
export async function performPageAction(
  page: Page,
  observed: LocalBrowserObservation | undefined,
  observedNodes: JSHandle<ObservedPageNodes> | undefined,
  input: LocalBrowserAction,
  admit: () => void,
  dispatched: () => void,
  stale: () => LocalBrowserError
): Promise<void> {
  admit();
  if (!LEAVE_ACTIONS.has(input.kind)) {
    if (!observed || !observedNodes) throw stale();
    const snapshot = await boundedPageSnapshot(page, ACTION_TIMEOUT_MS);
    if (snapshot !== observed.snapshot || page.url() !== observed.url) throw stale();
  }
  admit();
  if (input.kind === 'navigate') {
    // Admission ends at dispatch. A timed-out navigation is never replayed.
    dispatched();
    try {
      await page.goto(input.url, { waitUntil: 'commit', timeout: ACTION_TIMEOUT_MS });
    } catch (error) {
      // A load the browser refused (`net::ERR_…`) says so; anything else stays uncertain.
      const code = netErrorCode(error instanceof Error ? error.message : undefined);
      if (code && code !== 'ERR_ABORTED') throw loadFailedError(input.url, `net::${code}`);
      throw error;
    }
    if (BROWSER_ERROR_PAGE.test(page.url())) throw loadFailedError(input.url, undefined);
  } else if (!observed || !observedNodes) {
    throw stale();
  } else if (input.kind === 'press' || input.kind === 'scroll') {
    // The first body stands for the document; a page can carry more than one (DOR-4192).
    const body = await page.locator('body').first().elementHandle({ timeout: ACTION_TIMEOUT_MS });
    if (!body) throw stale();
    try {
      admit();
      if (!(await observedNodes.evaluate((nodes, element) => nodes.has(element), body)))
        throw stale();
      if (input.kind === 'press') {
        const sameFocus = await observedNodes.evaluate((nodes) => {
          let focusedElement = document.activeElement;
          while (focusedElement?.shadowRoot?.activeElement)
            focusedElement = focusedElement.shadowRoot.activeElement;
          return (
            focusedElement !== null &&
            focusedElement === nodes.focusedElement &&
            focusedElement.isConnected &&
            nodes.has(focusedElement)
          );
        });
        if (!sameFocus) throw stale();
      }
      admit();
      dispatched();
      if (input.kind === 'press') {
        // Enter on a link or a form starts a load, as a click does.
        const load = watchMainFrameLoad(page);
        try {
          await page.keyboard.press(input.key);
        } catch (error) {
          load.stop();
          throw error;
        }
        await load.settle();
      } else await page.mouse.wheel(input.deltaX, input.deltaY);
    } finally {
      void body.dispose().catch(() => undefined);
    }
  } else {
    const locator = page.getByRole(input.role as Parameters<Page['getByRole']>[0], {
      name: input.name,
      exact: true,
    });
    if ((await locator.count()) !== 1)
      throw new LocalBrowserError('ambiguous', 'Choose one visible item. Read the page again.');
    const handle = await locator.elementHandle({ timeout: ACTION_TIMEOUT_MS });
    if (!handle) throw stale();
    try {
      admit();
      if (!(await observedNodes.evaluate((nodes, element) => nodes.has(element), handle)))
        throw stale();
      admit();
      // Bind the original DOM node: Playwright must never re-resolve into a new document.
      if (input.kind === 'click') await handle.click({ trial: true, timeout: ACTION_TIMEOUT_MS });
      else if (!(await handle.isEditable()))
        throw new LocalBrowserError(
          'not_editable',
          'That field can’t be edited. Read the page again.'
        );
      admit();
      const current = await boundedPageSnapshot(page, ACTION_TIMEOUT_MS);
      if (current !== observed.snapshot || page.url() !== observed.url) throw stale();
      // Playwright's editable check does not reject inert fields; fill can affect another focus.
      if (input.kind === 'fill' && (await isInertFillTarget(handle)))
        throw new LocalBrowserError(
          'not_editable',
          'That field can’t be edited. Read the page again.'
        );
      admit();
      dispatched();
      if (input.kind === 'click') {
        // `noWaitAfter` means the click is only sent; whatever load it starts is checked here
        // (DOR-3897), so a click onto the browser's error page never reports success.
        const load = watchMainFrameLoad(page);
        try {
          await handle.click({ timeout: ACTION_TIMEOUT_MS, noWaitAfter: true });
        } catch (error) {
          load.stop();
          throw error;
        }
        await load.settle();
      } else await handle.fill(input.text, { timeout: ACTION_TIMEOUT_MS });
    } finally {
      void handle.dispose().catch(() => undefined);
    }
  }
}

/** Durable action receipts follow the bounded caller result; late acknowledgements cannot rewrite it. */
export async function auditPageAction(
  page: Page | undefined,
  identity: Pick<LocalBrowserAuditRecord, 'sessionId' | 'mode' | 'connectionId' | 'tabId'>,
  input: LocalBrowserAction,
  audit: LocalBrowserAuditWriter,
  perform: (
    dispatch: () => void
  ) => Promise<import('@dorkos/shared/local-browser').LocalBrowserState>
) {
  const origin = page
    ? (() => {
        try {
          return new URL(page.url()).origin;
        } catch {
          return null;
        }
      })()
    : null;
  const record: LocalBrowserAuditRecord = {
    operationId: randomUUID(),
    sessionId: identity.sessionId,
    mode: identity.mode,
    kind: input.kind,
    origin,
    connectionId: identity.connectionId,
    tabId: identity.tabId,
    startedAt: new Date().toISOString(),
    phase: 'started',
    outcome: 'unknown',
  };
  // Timing out this write ends admission permanently: there is no continuation into perform().
  try {
    await responseDeadline(
      Promise.resolve().then(() => audit(record)),
      AUDIT_WRITE_RESPONSE_TIMEOUT_MS,
      () =>
        new LocalBrowserError('audit_unavailable', 'Couldn’t record the browser action. Try again.')
    );
  } catch {
    throw new LocalBrowserError(
      'audit_unavailable',
      'Couldn’t record the browser action. Try again.'
    );
  }
  let dispatched = false;
  let state: import('@dorkos/shared/local-browser').LocalBrowserState;
  try {
    state = await perform(() => {
      dispatched = true;
    });
  } catch (error) {
    try {
      await responseDeadline(
        Promise.resolve().then(() =>
          audit({
            ...record,
            phase: 'finished',
            outcome:
              error instanceof LocalBrowserError && error.code === 'load_failed'
                ? 'failed'
                : dispatched
                  ? 'unknown'
                  : 'refused',
          })
        ),
        AUDIT_WRITE_RESPONSE_TIMEOUT_MS,
        uncertainAction
      );
    } catch {
      if (dispatched) throw uncertainAction();
    }
    if (error instanceof LocalBrowserError) throw error;
    throw uncertainAction();
  }
  const successWrite = Promise.resolve().then(() =>
    audit({ ...record, phase: 'finished', outcome: 'succeeded' })
  );
  try {
    await responseDeadline(successWrite, AUDIT_WRITE_RESPONSE_TIMEOUT_MS, uncertainAction);
    return state;
  } catch {
    // Preserve journal order: a late success write must settle before its correcting unknown record.
    const unknownWrite = successWrite
      .catch(() => undefined)
      .then(() =>
        audit({
          ...record,
          phase: 'finished',
          outcome: 'unknown',
        })
      );
    void unknownWrite.catch(() => undefined);
    await responseDeadline(unknownWrite, AUDIT_WRITE_RESPONSE_TIMEOUT_MS, uncertainAction).catch(
      () => undefined
    );
    throw uncertainAction();
  }
}

function uncertainAction(): LocalBrowserError {
  return new LocalBrowserError(
    'uncertain',
    'The page changed. Check what happened before continuing.'
  );
}
