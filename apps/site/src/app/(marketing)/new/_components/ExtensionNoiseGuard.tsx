'use client';

import { useEffect } from 'react';

/**
 * Message thrown by `chrome.runtime` messaging when an extension's background
 * worker is gone. Only extension code can produce it — this site never calls
 * the extension APIs — so matching on it cannot hide one of our own errors.
 */
const EXTENSION_DISCONNECT = 'Could not establish connection. Receiving end does not exist.';

/**
 * Keeps a broken browser extension from drowning the dev console.
 *
 * Extensions that inject a script into the page's main world (1Password's
 * `injected.js`, wallet content scripts) report their failures against this
 * document, so a dead extension worker looks like thousands of page errors.
 * They fire once per DOM probe, and an animated page gives them a lot to probe.
 *
 * This suppresses only that one exact message, logs once so the cause stays
 * visible, and is inert in production — a real fix means reloading the
 * offending extension, which only the person at the browser can do.
 */
export function ExtensionNoiseGuard() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;
    let suppressed = 0;
    const onRejection = (event: PromiseRejectionEvent) => {
      const message = typeof event.reason === 'string' ? event.reason : event.reason?.message;
      if (message !== EXTENSION_DISCONNECT) return;
      event.preventDefault();
      suppressed += 1;
      if (suppressed === 1) {
        console.info(
          '[home] Silencing repeated "%s" rejections. They come from a browser extension whose ' +
            'background worker has died (1Password and wallet extensions inject into this page), ' +
            'not from this site. Reload or disable that extension to stop them at the source. ' +
            'Count so far: window.__suppressedExtensionErrors',
          EXTENSION_DISCONNECT
        );
      }
      (window as { __suppressedExtensionErrors?: number }).__suppressedExtensionErrors = suppressed;
    };
    window.addEventListener('unhandledrejection', onRejection);
    return () => window.removeEventListener('unhandledrejection', onRejection);
  }, []);

  return null;
}
