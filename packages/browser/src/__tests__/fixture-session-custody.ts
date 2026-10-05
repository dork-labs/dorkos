import type { CDPSession, Browser } from 'playwright-core';
import { fixtureWait } from './fixture-manager-custody.js';

/** Exact public close event plus the original detach attempt; error text and PID absence grant nothing. */
export function ownFixtureSession(session: CDPSession, browser?: Browser) {
  let closeObserved = false;
  let originalConnectionClosed = false;
  let returned!: () => void;
  const originalEvent = new Promise<void>((resolve) => {
    returned = resolve;
  });
  if (browser) {
    const onDisconnected = browser.on;
    Reflect.apply(onDisconnected, browser, [
      'disconnected',
      (original: Browser) => {
        if (original === browser) {
          originalConnectionClosed = true;
          returned();
        }
      },
    ]);
  }
  const on = session.on,
    detach = session.detach;
  Reflect.apply(on, session, [
    'close',
    (original: CDPSession) => {
      if (original === session) {
        closeObserved = true;
        returned();
      }
    },
  ]);
  let closing:
    | Promise<Readonly<{ observed: boolean; detached: boolean; originalCloseObserved: boolean }>>
    | undefined;
  return Object.freeze({
    session,
    close() {
      closing ??= (async () => {
        let detached = false;
        try {
          await Reflect.apply(detach, session, []);
          detached = true;
        } catch {
          /* Preserve the distinct actual event proof, never infer one from this error. */
        }
        if (!closeObserved && !originalConnectionClosed) {
          try {
            await fixtureWait(originalEvent, 2000, 'FIXTURE_SESSION_RETURN_UNOBSERVED');
          } catch {
            /* Exact event remains unobserved; retain the original instead of claiming return. */
          }
        }
        return Object.freeze({
          observed: closeObserved || originalConnectionClosed,
          detached,
          originalCloseObserved: closeObserved,
        });
      })();
      return closing;
    },
  });
}
