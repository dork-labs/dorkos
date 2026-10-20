import { LocalBrowserError } from './errors.js';

/** Effect stage only; durable journal start and finish have separate response budgets. */
export const ACTION_EFFECT_RESPONSE_TIMEOUT_MS = 3_000;
export const PAGE_READ_RESPONSE_TIMEOUT_MS = 3_000;
export const CLOSE_RESPONSE_TIMEOUT_MS = 2_000;
export const CLOSING_MESSAGE = 'The browser is still closing. Wait before opening it again.';
export const CLOSING_FAILED_MESSAGE = 'Restart DorkOS to finish closing this browser.';
/** Distinguish a pending close from a failed close without releasing either ownership lease. */
export function closingError(failed: boolean): LocalBrowserError {
  return new LocalBrowserError('busy', failed ? CLOSING_FAILED_MESSAGE : CLOSING_MESSAGE);
}

/** Bound the caller's wait, never the lifetime of the underlying resource or effect. */
export async function responseDeadline<T>(
  operation: Promise<T>,
  timeout: number,
  expired: () => Error
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(expired()), timeout);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A timed-out caller cannot release ownership of an effect that has not actually settled. */
export class BrowserActionFlight {
  private original?: Promise<void>;
  get active(): boolean {
    return !!this.original;
  }

  async run(
    operation: (admit: () => void, dispatch: () => void) => Promise<void>,
    admit: () => void,
    dispatched: () => void,
    invalidate: () => void
  ): Promise<void> {
    if (this.original)
      throw new LocalBrowserError('busy', 'A browser action is finishing. Read the page again.');
    let expired = false;
    let didDispatch = false;
    const readmit = () => {
      if (expired)
        throw new LocalBrowserError('stale_page', 'The page changed. Read it again before acting.');
      admit();
    };
    const original = Promise.resolve().then(() =>
      operation(readmit, () => {
        readmit();
        didDispatch = true;
        dispatched();
      })
    );
    this.original = original;
    void original
      .finally(() => {
        if (this.original === original) this.original = undefined;
        invalidate();
      })
      .catch(() => undefined);
    await responseDeadline(original, ACTION_EFFECT_RESPONSE_TIMEOUT_MS, () => {
      expired = true;
      invalidate();
      return new LocalBrowserError(
        didDispatch ? 'uncertain' : 'stale_page',
        didDispatch
          ? 'The page changed. Check what happened before continuing.'
          : 'The page changed. Read it again before acting.'
      );
    });
  }
}

/** A manual close can settle a stuck protocol close; a failed close never releases ownership. */
export async function resourceClosure(
  close: () => Promise<void>,
  subscribe: (closed: () => void) => () => void
): Promise<void> {
  let unsubscribe: (() => void) | undefined;
  const event = new Promise<void>((resolve) => {
    unsubscribe = subscribe(resolve);
  });
  // A rejected close is not proof that this resource stopped. Retain its lease until the event.
  const requested = Promise.resolve()
    .then(close)
    .catch(() => event);
  try {
    await Promise.race([requested, event]);
  } finally {
    unsubscribe?.();
  }
}
