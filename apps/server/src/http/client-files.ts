/**
 * Serving the app itself: the built client, its shell headers, the
 * missing-bundle trap and the deep-link fallback (DOR-2817,
 * `plans/2026-10-express-to-hono.md` item 26).
 *
 * {@link createClientFiles} is a plain Node request handler, owned by no
 * framework. Until Express leaves the server (DOR-2818) it is the Express
 * app's last handler, so every route either chain serves still wins; after
 * that, it is what the front door falls through to.
 *
 * It is built on `serve-static` and `send`, the file senders `express.static`
 * and `res.sendFile` are, rather than a framework's own static middleware:
 * Hono's (`@hono/node-server/serve-static`) sends no `ETag` or
 * `Last-Modified`, never answers `304`, and would serve a dotfile in the
 * build. `__tests__/contract/spa.contract.test.ts` pins every answer.
 *
 * @module http/client-files
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import send from 'send';
import serveStatic from 'serve-static';
import { createFirstContactMarker } from './first-contact.js';

/**
 * Content-Security-Policy for the app's own page (DOR-560).
 *
 * The app renders agent-authored markdown, gen-UI widgets and marketplace card
 * content on its own privileged origin, where a script can call every `/api`
 * route as you. Until this header existed nothing stopped injected content from
 * pulling a script off the internet and running it there. It is set on the
 * shell document — the only response whose policy governs the app — so the CLI,
 * the desktop shell and the phone all get the same one; the per-route policies
 * on raw file and diff responses (`routes/files.ts`, `routes/diff.ts`) are
 * about different documents and are left exactly as they are.
 *
 * Every directive that is not `'self'` is here because a shipped surface needs
 * it:
 * - `script-src` allows inline because `index.html` carries the boot sentinel
 *   and the theme script — and because a `srcdoc` iframe INHERITS this policy,
 *   so a hash-only script-src would also kill every MCP App's inline script
 *   inside its sandbox (verified in Chromium, not assumed). No remote script
 *   host is listed, and `'unsafe-eval'` is absent; `'wasm-unsafe-eval'` is the
 *   narrow exception the bundled Draco/Basis decoders need to open a
 *   compressed 3D model, and it grants WebAssembly only, never `eval`.
 * - `style-src`/`font-src` name Google Fonts because the appearance settings
 *   load a chosen font family from there.
 * - `img-src`/`media-src`/`frame-src` are open to the web because that is the
 *   product: agent markdown embeds remote images, and the canvas browser frames
 *   whatever page you point it at, including a dev server on another port. They
 *   are no wider than that: `frame-src` omits `data:` and `blob:`, which the
 *   canvas rejects as frame targets anyway (`canvas/lib/browser-url.ts`).
 * - `object-src` is the PDF canvas, which hands the browser's built-in viewer
 *   an `<object>` pointing at a served file, a remote URL, or a
 *   `data:application/pdf` URI (`canvas/lib/media-src.ts`) — the one place the
 *   otherwise-standard `object-src 'none'` would have broken a shipped surface.
 * - `worker-src` allows `blob:` for the workers canvas-confetti and the 3D
 *   decoders build in-page.
 * - `connect-src` reaches the web, and this is the directive it is tempting to
 *   write too tight. Almost everything the app fetches is its own server —
 *   `'self'` covers the `ws://` terminal and event streams on that same origin
 *   too (verified in Chromium) — but real features fetch elsewhere, and the
 *   plain-`http:` one is the trap: before the canvas frames a dev server it
 *   asks the BROWSER whether it can reach `http://localhost:5173`
 *   (`canvas/lib/probe-direct.ts`), and a blocked fetch is indistinguishable
 *   there from a refused connection, so a policy without `http:` reports every
 *   healthy dev server as unreachable and never frames it — while `frame-src`
 *   happily permits the frame it just talked itself out of showing. The tunnel
 *   panel's latency probe and remote CSV/3D canvas sources need the same reach.
 *   The exfiltration this leaves open is the one `img-src` already leaves open
 *   for the same product reason, so the honest accounting is that this
 *   directive keeps the app's fetches describable, not that it seals them.
 *
 * `frame-ancestors 'none'`, `base-uri 'self'` and `form-action 'self'` close
 * the classic non-script escapes: nobody may frame the app, retarget its
 * relative URLs, or post its forms elsewhere.
 *
 * Not covered: the Vite dev server serves its own shell with no header, so this
 * is a production policy. `electron-vite preview` loads the built shell off
 * `file://` and gets none either — neither ships to anyone.
 */
const SHELL_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https: http:",
  "media-src 'self' data: blob: https: http:",
  "object-src 'self' data: https: http:",
  "frame-src 'self' https: http:",
  "worker-src 'self' blob:",
  "connect-src 'self' data: https: http:",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * The headers the SPA shell carries, on both the static hit and the deep-link
 * fallback: what may cache it, and what its page is allowed to do.
 *
 * `no-store` rather than the `max-age=0` + ETag default: the shell names the
 * exact content-hashed bundles of the build that produced it, so a shell held
 * over from a previous version points at files that no longer exist on disk —
 * a blank window with 404s in the console. A revalidating cache usually gets
 * this right; a cache that cannot revalidate (offline, an intercepting proxy,
 * a poisoned entry) does not. The shell is a few KB, so never storing it costs
 * nothing and removes the failure mode outright.
 *
 * The policy is {@link SHELL_CSP}.
 */
const SHELL_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': SHELL_CSP,
} as const;

/**
 * Cache-Control for content-hashed bundles under `/assets/`.
 *
 * The filename changes whenever the bytes do, so a cached copy can never be
 * wrong — cache it for a year and let the shell (never stored, above) decide
 * which filenames are current. A year is the conventional "effectively
 * forever" max-age rather than any specified ceiling; `immutable` additionally
 * suppresses the revalidation request a reload would otherwise send.
 */
const IMMUTABLE_ASSET_HEADER = 'public, max-age=31536000, immutable';

/** Directory, relative to the client dist root, holding Vite's content-hashed output. */
const HASHED_ASSET_DIR = 'assets';

/**
 * Pick the Cache-Control for one file served out of the client dist, or
 * `null` to leave the static handler's defaults alone.
 *
 * Only the two paths whose caching can actually break the app are named: the
 * shell file, and the directory of hashed bundles. Everything else at the dist
 * root (favicon, manifest, icons) keeps `max-age=0` + ETag — cheap to
 * revalidate, and harmless when stale.
 *
 * @param distPath - Absolute path of the client dist root.
 * @param filePath - Absolute path of the file the static handler resolved.
 */
function cacheControlForDistFile(distPath: string, filePath: string): string | null {
  if (path.basename(filePath) === 'index.html') return SHELL_HEADERS['Cache-Control'];
  const relative = path.relative(distPath, filePath);
  if (relative.split(path.sep)[0] === HASHED_ASSET_DIR) return IMMUTABLE_ASSET_HEADER;
  return null;
}

/** A Node request handler that hands on what it does not answer, or an error. */
export type ClientFilesHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (error?: unknown) => void
) => void;

/**
 * Whether a path falls under the hashed-bundle folder, the way an Express
 * `app.use('/assets')` mount matched it: ignoring case, at a segment boundary.
 */
function underAssets(url: string): boolean {
  const pathname = (url.split('?')[0] ?? url).toLowerCase();
  return pathname === `/${HASHED_ASSET_DIR}` || pathname.startsWith(`/${HASHED_ASSET_DIR}/`);
}

/**
 * Build the handler that serves the client out of `distPath`. It answers GET
 * and HEAD only, and hands every other method on.
 *
 * 1. A file in the build, with the shell's policy on `index.html` and the
 *    cache rule {@link cacheControlForDistFile} picks.
 * 2. A GET/HEAD under `/assets/` that matched no file is a missing hashed
 *    bundle, not a client route: a plain 404, so it can never reach the
 *    fallback. Without this, a stale or broken reference to a hashed bundle
 *    presents as a silent blank window (the shell loads, its script tag 404s
 *    into HTML, nothing renders) instead of a diagnosable 404 in the network
 *    tab (DOR-1474).
 * 3. Anything else is a deep link: the shell, so client-side routes resolve.
 *    Sent from the `{ root }` it lives in, never an absolute path, so the
 *    request's own path cannot steer which file goes out.
 *
 * Both places the shell can leave this process are latched for the
 * first-contact line, because which one answers depends only on whether the
 * URL was a deep link, and the line is about the shell reaching a browser at
 * all (`http/first-contact.ts`).
 *
 * @param distPath - Absolute path of the client build.
 * @returns The handler.
 */
export function createClientFiles(distPath: string): ClientFilesHandler {
  const noteShellServed = createFirstContactMarker('[Client] first index.html served');
  const files = serveStatic(distPath, {
    setHeaders: (res, filePath) => {
      if (path.basename(filePath) === 'index.html') {
        noteShellServed();
        // The shell served straight off disk (`/`, `/index.html`) has to carry
        // the policy too — the fallback below is only reached by deep links,
        // so setting it there alone would leave the app's most common entry
        // unprotected.
        res.setHeader('Content-Security-Policy', SHELL_HEADERS['Content-Security-Policy']);
      }
      const cacheControl = cacheControlForDistFile(distPath, filePath);
      if (cacheControl) res.setHeader('Cache-Control', cacheControl);
    },
  });

  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    files(req, res, (error?: unknown) => {
      if (error) return next(error);
      const url = req.url ?? '/';
      if (underAssets(url)) {
        const body = `Not found: ${url}`;
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Length', Buffer.byteLength(body));
        res.end(req.method === 'HEAD' ? undefined : body);
        return;
      }
      // Latched once the shell has gone out, so the line means it did. Claiming
      // it before the send would put "first index.html served" in the log of a
      // build whose dist is missing — precisely the boot where the line would
      // be read most carefully, and most misleading.
      send(req, 'index.html', { root: distPath })
        .on('headers', (out: ServerResponse) => {
          for (const [name, value] of Object.entries(SHELL_HEADERS)) out.setHeader(name, value);
        })
        .on('error', (sendError: unknown) => next(sendError))
        .on('end', noteShellServed)
        .pipe(res);
    });
  };
}
