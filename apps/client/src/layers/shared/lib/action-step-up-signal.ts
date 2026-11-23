/**
 * "Confirm it's you" before one sensitive action, as an app-wide signal
 * (DOR-3234).
 *
 * A guarded route holds its action and answers `428 step_up_required` with a
 * held-action id. The window's `fetch` (`./person-aware-fetch`) asks for the
 * sheet with that id and waits; the `features/auth` host shows it and answers
 * with how it ended. Each held action gets its own sheet, one at a time, in
 * the order they were asked.
 *
 * Plain module state with a `useSyncExternalStore`-compatible pair, like
 * `./person-step-up-signal`, so the base layer stays free of React.
 *
 * @module shared/lib/action-step-up-signal
 */

import { STEP_UP_REQUIRED_CODE } from '@dorkos/shared/step-up';

type Listener = () => void;

/** How a sheet ended. */
export type ActionStepUpOutcome =
  /** The person confirmed, and the server ran the action: its own answer. */
  | { kind: 'confirmed'; status: number; result: unknown }
  /** Cancelled, refused or failed: nothing ran. */
  | { kind: 'not-confirmed' }
  /** It expired: ask for the action again, which holds it afresh. */
  | { kind: 'ask-again'; reason?: 'different-request' }
  /**
   * A mini app ran since this sign-in: sign in again, then ask for the action
   * again, which holds it afresh in the new session (M1 on #3401).
   */
  | { kind: 'sign-in-again' };

/**
 * What a change says once "Confirm it's you" closed without confirming
 * (DOR-4909). The window's fetch puts it in place of the server's "Confirm
 * it's you to do this.", which read as an instruction after the sheet was
 * gone, so every caller that shows the refusal's words says what is true.
 */
export const STEP_UP_NOT_CONFIRMED_MESSAGE = 'Not confirmed. Nothing changed.';

/**
 * The same, on a card whose answer is a yes (an approval, an Allow): what did
 * not happen is the allowing.
 */
export const STEP_UP_NOT_ALLOWED_MESSAGE = 'Not confirmed. Nothing was allowed.';

/**
 * Whether a change came back because "Confirm it's you" closed without
 * confirming: nothing changed.
 *
 * @param error - What the change rejected with.
 */
export function isStepUpNotConfirmed(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === STEP_UP_REQUIRED_CODE;
}

interface Ask {
  heldActionId: string;
  resolve: (outcome: ActionStepUpOutcome) => void;
  /** What had focus when it opened, to give it back when it closes. */
  openedFrom: HTMLElement | null;
  /** Whether the last ask for this same call expired, so the sheet says so. */
  afterExpiry: boolean;
  afterDifferent: boolean;
}

/** The asks waiting, the first one showing. */
const queue: Ask[] = [];
const listeners = new Set<Listener>();

function notify(): void {
  listeners.forEach((listener) => listener());
}

/**
 * Ask the person to confirm one held action.
 *
 * @param heldActionId - The id the guarded route answered with.
 * @param options - `afterExpiry`: the last ask for this same call expired.
 * @returns How the sheet ended.
 */
export function requestActionStepUp(
  heldActionId: string,
  options: { afterExpiry?: boolean; afterDifferent?: boolean } = {}
): Promise<ActionStepUpOutcome> {
  return new Promise((resolve) => {
    const openedFrom =
      typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    queue.push({
      heldActionId,
      resolve,
      openedFrom,
      afterExpiry: options.afterExpiry ?? false,
      afterDifferent: options.afterDifferent ?? false,
    });
    if (queue.length === 1) notify();
  });
}

/** The query parameter a page outside the app links with: `/?confirm=<held action id>`. */
export const CONFIRM_LINK_PARAM = 'confirm';

/** A held action's id: a ULID, nothing else. */
const HELD_ACTION_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Open the sheet for the held action a link names, once, and take the id out
 * of the address so a reload or a shared link never asks again. Nothing waits
 * on the answer: the page that sent the person here reloads to see it.
 *
 * @param location - Where the app opened, for tests.
 * @param history - The window's history, for tests.
 * @returns Whether a sheet was asked for.
 */
export function openActionStepUpFromLink(
  location: Pick<Location, 'href'> = window.location,
  history: Pick<History, 'replaceState' | 'state'> = window.history
): boolean {
  const url = new URL(location.href);
  const id = url.searchParams.get(CONFIRM_LINK_PARAM);
  if (id === null) return false;
  url.searchParams.delete(CONFIRM_LINK_PARAM);
  history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
  if (!HELD_ACTION_ID.test(id)) return false;
  void requestActionStepUp(id);
  return true;
}

/** Where the held actions this tab already reloaded for are kept, for this tab only. */
const RELOADED_KEY = 'dorkos.step-up.reloaded';

/** How many reloaded ids are kept; older ones have long expired. */
const RELOADED_KEPT = 20;

function reloadedIds(storage: Pick<Storage, 'getItem'>): string[] {
  try {
    const parsed = JSON.parse(storage.getItem(RELOADED_KEY) ?? '[]') as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Whether this tab already reloaded once for `heldActionId` (DOR-5086). A page
 * too old to confirm from reloads by itself at most once per held action, so
 * a page that is still refused after its reload can never loop.
 *
 * @param heldActionId - The held action's id.
 * @param storage - This tab's session storage, for tests.
 */
export function stepUpReloadedFor(
  heldActionId: string,
  storage: Pick<Storage, 'getItem'> = window.sessionStorage
): boolean {
  return reloadedIds(storage).includes(heldActionId);
}

/**
 * Note that this tab reloads for `heldActionId`, before it does.
 *
 * @param heldActionId - The held action's id.
 * @param storage - This tab's session storage, for tests.
 * @returns Whether the note was kept. When it wasn't (storage off or full),
 *   nothing may reload by itself: the next page could not tell it already had.
 */
export function noteStepUpReload(
  heldActionId: string,
  storage: Pick<Storage, 'getItem' | 'setItem'> = window.sessionStorage
): boolean {
  const ids = [...reloadedIds(storage).filter((id) => id !== heldActionId), heldActionId];
  try {
    storage.setItem(RELOADED_KEY, JSON.stringify(ids.slice(-RELOADED_KEPT)));
    return reloadedIds(storage).includes(heldActionId);
  } catch {
    return false;
  }
}

/**
 * Load this page afresh and reopen the sheet for `heldActionId` there
 * (DOR-5086). A confirm counts only from a page the server sent after the
 * last mini app risk cleared (DOR-5026), and only a real page load brings a
 * fresh stamp. Only the id travels, in the address, as a link from outside
 * the app would carry it: the new page asks the server what it is.
 *
 * @param heldActionId - The held action to reopen.
 * @param location - This page's location, for tests.
 */
export function reloadToConfirm(
  heldActionId: string,
  location: Pick<Location, 'href' | 'assign'> = window.location
): void {
  const url = new URL(location.href);
  url.searchParams.set(CONFIRM_LINK_PARAM, heldActionId);
  location.assign(url.toString());
}

/**
 * Close the sheet for `heldActionId`, say how it ended, and show the next one.
 * A late answer for a sheet that already closed does nothing, so it can never
 * end the next held action's sheet with another action's result.
 *
 * @param heldActionId - The held action the answer is for.
 * @param outcome - How it ended.
 */
export function finishActionStepUp(heldActionId: string, outcome: ActionStepUpOutcome): void {
  if (queue[0]?.heldActionId !== heldActionId) return;
  const ask = queue.shift();
  if (!ask) return;
  notify();
  ask.resolve(outcome);
  if (queue.length === 0 && ask.openedFrom?.isConnected) {
    const back = ask.openedFrom;
    queueMicrotask(() => back.focus());
  }
}

/** The held action whose sheet is showing, or `null`. */
export function getActionStepUpShowing(): string | null {
  return queue[0]?.heldActionId ?? null;
}

/** Whether the sheet that is showing follows one that expired. */
export function getActionStepUpAfterExpiry(): boolean {
  return queue[0]?.afterExpiry ?? false;
}

/** Subscribe to the sheet opening, changing and closing; returns an unsubscribe function. */
export function subscribeActionStepUp(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether the previous confirmation named a different stored request. */
export function getActionStepUpAfterDifferent(): boolean {
  return queue[0]?.afterDifferent ?? false;
}
