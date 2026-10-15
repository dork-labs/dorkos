import { randomUUID } from 'node:crypto';
import type { LocalBrowserAuditRecord, LocalBrowserAuditWriter } from './action-audit.js';
import type { Page, JSHandle } from 'playwright-core';
import type { LocalBrowserAction, LocalBrowserObservation } from '@dorkos/shared/local-browser';
import { LocalBrowserError } from './errors.js';
import { boundedPageSnapshot } from './observation-limits.js';
import { responseDeadline } from './lifecycle.js';
import { isInertFillTarget } from './inert-target.js';

/** Each durable journal wait has its own budget, separate from the action effect deadline. */
export const AUDIT_WRITE_RESPONSE_TIMEOUT_MS = 2_000;
const ACTION_TIMEOUT_MS = 750;

/** Execute only on the observed DOM identity, with re-admission before every effect. */
export async function performPageAction(
  page: Page,
  observed: LocalBrowserObservation,
  observedNodes: JSHandle<Set<Element>>,
  input: LocalBrowserAction,
  admit: () => void,
  dispatched: () => void,
  stale: () => LocalBrowserError
): Promise<void> {
  admit();
  const snapshot = await boundedPageSnapshot(page, ACTION_TIMEOUT_MS);
  if (snapshot !== observed.snapshot || page.url() !== observed.url) {
    throw stale();
  }
  admit();
  if (input.kind === 'navigate') {
    // Admission ends at dispatch. A timed-out navigation is never replayed.
    dispatched();
    await page.goto(input.url, { waitUntil: 'commit', timeout: ACTION_TIMEOUT_MS });
  } else if (input.kind === 'press' || input.kind === 'scroll') {
    const body = await page.locator('body').elementHandle({ timeout: ACTION_TIMEOUT_MS });
    if (!body) throw stale();
    try {
      admit();
      if (!(await observedNodes.evaluate((nodes, element) => nodes.has(element), body)))
        throw stale();
      admit();
      dispatched();
      if (input.kind === 'press') await page.keyboard.press(input.key);
      else await page.mouse.wheel(input.deltaX, input.deltaY);
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
      if (input.kind === 'click')
        await handle.click({ timeout: ACTION_TIMEOUT_MS, noWaitAfter: true });
      else await handle.fill(input.text, { timeout: ACTION_TIMEOUT_MS });
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
            outcome: dispatched ? 'unknown' : 'refused',
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
