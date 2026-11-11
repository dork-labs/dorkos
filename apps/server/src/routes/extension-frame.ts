/**
 * `GET /api/extension-frame` — the empty document every app's screens run in
 * (DOR-3293).
 *
 * The client puts an app in an `<iframe sandbox="allow-scripts">` pointed here,
 * never in a `srcdoc` frame: a `srcdoc` document inherits the app shell's CSP,
 * whose `script-src` allows `'unsafe-inline'`. This response sends its own
 * policy instead. It sandboxes the document whatever the frame attribute says,
 * runs only scripts that carry this response's nonce, and reaches no network.
 *
 * The page carries no app code and no data, only a bootstrap that takes the
 * frame runtime once, from the window that framed it, and runs it under the
 * same nonce. The runtime then receives the app's approved bundle over the
 * private port the host hands it (`apps/client/src/layers/features/extensions/frame/`).
 *
 * @module routes/extension-frame
 */
import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import type { ApiEnv } from '../http/api-chain.js';
import { resolveAuthTrustedOrigins } from '../lib/trusted-origins.js';

/**
 * Runs once in the frame: keeps the nonce for the runtime, then accepts one
 * runtime message from the parent window and runs it. Anything from another
 * window, or a second message, is ignored.
 */
const BOOTSTRAP = `(() => {
  const nonce = document.currentScript.nonce;
  Object.defineProperty(globalThis, '__dorkosFrameNonce', { value: nonce });
  addEventListener('message', function boot(event) {
    if (event.source !== parent || !event.data || event.data.type !== 'dorkos-frame-runtime') return;
    if (typeof event.data.runtime !== 'string') return;
    removeEventListener('message', boot);
    const script = document.createElement('script');
    script.nonce = nonce;
    script.textContent = event.data.runtime;
    document.head.append(script);
  });
})();`;

/**
 * The frame document's policy, around one nonce.
 *
 * - `sandbox allow-scripts`: an opaque origin even if the iframe attribute is
 *   ever dropped; no forms, popups, downloads or top navigation.
 * - `script-src 'nonce-…'`: only scripts DorkOS put there, never `'unsafe-inline'`.
 * - `connect-src 'none'`: the app reaches DorkOS only through the bridge.
 * - `style-src`/`font-src`: the host's own styles and font choice, copied in.
 * - `img-src`/`media-src` `blob:`: pictures and video an app fetched through
 *   the bridge (Security, 2026-11-10).
 *
 * @param nonce - This response's nonce.
 */
export function extensionFrameCsp(nonce: string): string {
  return [
    'sandbox allow-scripts',
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    'img-src data: blob:',
    'media-src blob:',
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors 'self' ${resolveAuthTrustedOrigins().join(' ')}`,
  ].join('; ');
}

/** The frame document's routes. */
export function createExtensionFrameRoutes(): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();
  router.get('/', (c) => {
    const nonce = randomBytes(18).toString('base64url');
    c.header('Content-Security-Policy', extensionFrameCsp(nonce));
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    return c.html(
      `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script nonce="${nonce}">${BOOTSTRAP}</script></body></html>`
    );
  });
  return router;
}
