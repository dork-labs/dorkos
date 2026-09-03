import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { apiReference } from '@scalar/express-api-reference';
import sessionRoutes from './routes/sessions.js';
import commandRoutes from './routes/commands.js';
import healthRoutes from './routes/health.js';
import directoryRoutes from './routes/directory.js';
import configRoutes from './routes/config.js';
import fileRoutes from './routes/files.js';
import diffRoutes from './routes/diff.js';
import workbenchServeRoutes from './routes/workbench-serve.js';
import gitRoutes from './routes/git.js';
import workspaceRoutes from './routes/workspaces.js';
import roomRoutes from './routes/rooms.js';
import readCursorRoutes from './routes/read-cursors.js';
import tunnelRoutes from './routes/tunnel.js';
import cloudRoutes from './routes/cloud.js';
import feedbackRoutes from './routes/feedback.js';
import modelRoutes from './routes/models.js';
import subagentRoutes from './routes/subagents.js';
import capabilitiesRoutes from './routes/capabilities.js';
import systemRoutes from './routes/system.js';
import runtimesRoutes from './routes/runtimes.js';
import uploadRoutes from './routes/uploads.js';
import mcpConfigRoutes from './routes/mcp-config.js';
import errorRoutes from './routes/errors.js';
import debugRoutes from './routes/debug.js';
import eventsRouter from './routes/events.js';
import { generateOpenAPISpec } from './services/core/openapi-registry.js';
import { errorHandler } from './middleware/error-handler.js';
import { hostGuard } from './middleware/host-guard.js';
import { requestLogger } from './middleware/request-logger.js';
import { buildAuthRateLimiter } from './middleware/auth-rate-limit.js';
import { resolveAgentIdentity } from './middleware/agent-identity.js';
import { getAuth, toNodeHandler, sessionGate } from './services/core/auth/index.js';
import { resolveTrustedOrigins } from './lib/trusted-origins.js';
import { logger } from './lib/logger.js';
import { testControlRouter } from './routes/test-control.js';
import { createMockMcpOAuthRouter } from './routes/mock-mcp-oauth-server.js';
import { env } from './env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Build the CORS middleware.
 *
 * `DORKOS_CORS_ORIGIN` is the manual override: a comma-separated allowlist.
 * Without it, origins are resolved per request: the static loopback origins plus
 * the live tunnel origin (so a tunnel that connects after boot is trusted
 * without a restart), plus any request whose `Origin` is same-origin with the
 * request itself.
 *
 * A `*` is **not** an allowlist and is ignored, exactly as
 * `isTrustedUpgradeOrigin` has always ignored it on the WebSocket path. The
 * argument that once justified honouring it here — a wildcard
 * `Access-Control-Allow-Origin` is invalid for credentialed requests, so
 * browsers reject it — only covers the credentialed case, and the shipped
 * default posture is `auth.enabled: false`, where the API asks for no
 * credential at all. In that posture a wildcard turns any page the operator
 * visits into a full API client for their DorkOS: it reads sessions, files and
 * diffs cross-origin and POSTs turns back. The operator gets one warning line
 * naming the variable and what to set instead, and the request falls through to
 * the per-request policy below, so an install that reached for `*` to fix a
 * proxy keeps working for every origin that is genuinely its own.
 *
 * The same-origin check exists because the server's loopback allowlist is keyed
 * to the port it listens on *inside* its own process. When the host port is
 * remapped — `docker run -p 4300:4242`, an `ssh -L` forward, a reverse proxy —
 * the browser loads the page on the remapped port and requests same-origin
 * assets with e.g. `Origin: http://localhost:4300`, which the container's own
 * `:4242` allowlist does not contain, so every asset 503s and the cockpit goes
 * blank. Allowing an `Origin` that equals `${req.protocol}://${req.headers.host}`
 * fixes that: it is by definition same-origin traffic and adds no cross-origin
 * exposure (an attacker page at evil.com still sends `Origin: https://evil.com`
 * with its own `Host`, so it is rejected). `trust proxy` is set below, so
 * `req.protocol` honors `X-Forwarded-Proto` behind Caddy/ngrok.
 *
 * The delegate form (`cors((req, cb) => ...)`) is required because the plain
 * `origin` callback never receives the request, and the same-origin comparison
 * needs `req.protocol` and `req.headers.host`.
 */
function buildCors(): express.RequestHandler {
  // Trimmed, so a value that is whitespace around a wildcard (or whitespace
  // around nothing) is read as what the operator meant rather than becoming a
  // one-entry allowlist of `" * "` that matches no origin at all and warns
  // about nothing. `isTrustedUpgradeOrigin` treats the socket side the same way.
  // eslint-disable-next-line no-restricted-syntax -- DORKOS_CORS_ORIGIN is not in env.ts (optional CORS override, not worth validating)
  const envOrigin = process.env.DORKOS_CORS_ORIGIN?.trim();

  // A wildcard is no list at all — say so once, then resolve per request.
  if (envOrigin === '*') {
    logger.warn(
      '[CORS] DORKOS_CORS_ORIGIN="*" is ignored: a wildcard would let any web page ' +
        'you visit read and write this DorkOS. Set it to the exact origins that need ' +
        'access instead (comma-separated, e.g. https://dorkos.example.com) and restart.'
    );
  } else if (envOrigin) {
    // User-specified origins (comma-separated) — static, no per-request check.
    const origins = envOrigin.split(',').map((o) => o.trim());
    return cors({ origin: origins, credentials: true });
  }

  // Dynamic per-request policy.
  return cors<express.Request>((req, done) => {
    done(null, {
      credentials: true,
      origin: (origin, callback) => {
        // Allow requests with no origin (server-to-server, curl, etc.)
        if (!origin) return callback(null, true);

        // Static loopback origins + the live tunnel origin.
        if (resolveTrustedOrigins().includes(origin)) return callback(null, true);

        // Same-origin as this very request (host-port remap / forward / proxy).
        const host = req.headers.host;
        if (host && origin === `${req.protocol}://${host}`) return callback(null, true);

        callback(new Error(`Origin ${origin} not allowed by CORS`));
      },
    });
  });
}

/**
 * Build a one-shot `info` marker: the returned function logs `message` the
 * first time it is called and does nothing on every call after that.
 *
 * This closes a diagnostic blind spot that cost a day of an incident.
 * Successful requests are logged at `debug`, so a user's log at the default
 * level contains nothing at all when everything is working — which means it
 * cannot answer the first question a blank window raises: did the cockpit ever
 * reach the server, or is this a server that never came up? One `info` line
 * apiece for the first shell served and the first API call answers it outright,
 * without touching what the request logger does per request.
 *
 * The latch is a closure rather than module state so it is scoped to one
 * Express app — i.e. to one boot, which is what "first" means here — and so a
 * test can prove the once-only behaviour by building two apps.
 *
 * @param message - The line to log, tagged the way `lib/logger.ts` expects.
 */
function createFirstContactMarker(message: string): () => void {
  let logged = false;
  return () => {
    if (logged) return;
    logged = true;
    logger.info(message);
  };
}

/** Create and configure the Express application with middleware and routes. */
export function createApp() {
  const app = express();

  // Trust the first proxy (ngrok) for correct req.hostname, req.ip, req.protocol
  app.set('trust proxy', 1);

  // Mounted ahead of every other `/api` handler, the host guard included: a
  // request that arrives and is then rejected still proves the client reached
  // this process, which is the only thing this line claims.
  const noteFirstApiRequest = createFirstContactMarker('[Client] first API request');
  app.use('/api', (_req, _res, next) => {
    noteFirstApiRequest();
    next();
  });

  // `credentials: true` sends Access-Control-Allow-Credentials: true so the
  // browser accepts cross-origin responses to the client's `credentials:
  // 'include'` fetches (auth cookies) — the desktop dev renderer (a distinct
  // Vite origin) is the sole cross-origin surface; the web app is same-origin
  // via the Vite proxy. Credentials only ever ride an origin this server named,
  // because no branch of `buildCors` answers with a wildcard.
  app.use(buildCors());

  // Never let a browser guess the type of anything this server sends. Set
  // app-wide rather than per response so a route added later inherits it. The
  // routes that already set the same header byte-for-byte (files, diffs, room
  // exports and attachments, avatars, workbench) keep their own line, because
  // each documents why sniffing would be dangerous for that exact payload.
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });

  // Host allowlist on the API surface (DOR-532). CORS alone cannot stop DNS
  // rebinding: a page at `http://evil.com:4242` that re-points `evil.com` at
  // 127.0.0.1 is same-origin to the browser, so it sends no preflight and
  // satisfies both the no-Origin and the same-origin branches above. The `Host`
  // header still says `evil.com`, and this rejects it. Mounted before
  // `express.json` so a rejected body is never parsed, and before the Better
  // Auth handler so `/api/auth/*` is covered too. Inert when login is on (auth
  // cookies are origin-scoped) or when the container escape hatch is set — see
  // `middleware/host-guard.ts`.
  app.use('/api', hostGuard);

  // Better Auth handler — mounted BEFORE express.json because Better Auth parses
  // its own request body (mounting after express.json breaks it). Express 5
  // wildcard syntax is `*splat` (a bare `*` throws under path-to-regexp v8). The
  // handler is always mounted in the running server (index.ts calls initAuth
  // before createApp), even when `config.auth.enabled` is false, so the
  // enable-login flow can create the owner account before the flag flips. The
  // guard only skips the mount in unit tests that build the app without auth.
  const auth = getAuth();
  if (auth) {
    // Defense-in-depth brute-force throttle on sign-in/sign-up (DOR-281),
    // mounted BEFORE the auth handler so it sheds attempts first. App-wide with
    // an internal `skip` (like `sessionGate`) so it counts only credential POSTs
    // and never touches session-check GETs or non-auth routes. This layers over
    // Better Auth's own built-in throttle, which is production-only and
    // short-windowed — see `middleware/auth-rate-limit.ts`.
    app.use(buildAuthRateLimiter({ maxAttempts: env.DORKOS_AUTH_SIGNIN_RATE_LIMIT }));
    app.all('/api/auth/*splat', toNodeHandler(auth));
  }

  app.use(express.json({ limit: '1mb' }));
  app.use(requestLogger);

  // Session gate — when `config.auth.enabled` is true, require a Better Auth
  // session cookie or a per-user API key on `/api/*` and `/mcp` (exemptions for
  // SPA assets, `/api/auth/*`, and `/api/health`). Mounted app-wide before the
  // API routes so it also covers the `/mcp` mount added later on this same app
  // in `index.ts`. Zero-overhead pass-through when login is disabled.
  app.use(sessionGate);

  // Agent identity — resolves an `X-DorkOS-Agent` token onto
  // `res.locals.agentIdentity` so capability invocations can be attributed to
  // the agent that made them. Mounted AFTER `sessionGate` (which owns the
  // auth decision) and before the routes, app-wide so it also covers the `/mcp`
  // mount added later in `index.ts`. Never rejects: a request without a token
  // behaves exactly as it does today.
  app.use(resolveAgentIdentity);

  // API routes
  app.use('/api/sessions', sessionRoutes);
  app.use('/api/commands', commandRoutes);
  app.use('/api/health', healthRoutes);
  app.use('/api/directory', directoryRoutes);
  app.use('/api/config', configRoutes);
  app.use('/api/files', fileRoutes);
  app.use('/api/diff', diffRoutes);
  app.use('/api/workbench', workbenchServeRoutes);
  app.use('/api/git', gitRoutes);
  app.use('/api/workspaces', workspaceRoutes);
  app.use('/api/rooms', roomRoutes);
  app.use('/api/read-cursors', readCursorRoutes);
  app.use('/api/tunnel', tunnelRoutes);
  app.use('/api/cloud', cloudRoutes);
  app.use('/api/feedback', feedbackRoutes);
  app.use('/api/models', modelRoutes);
  app.use('/api/subagents', subagentRoutes);
  app.use('/api/capabilities', capabilitiesRoutes);
  app.use('/api/system', systemRoutes);
  app.use('/api/runtimes', runtimesRoutes);
  app.use('/api/events', eventsRouter);
  app.use('/api/uploads', uploadRoutes);
  app.use('/api/mcp-config', mcpConfigRoutes);
  app.use('/api/errors', errorRoutes);
  // Diagnostic reads (`GET /api/debug/*`). Mounted here rather than in
  // `index.ts` — it needs no singleton the composition root has to hand it, only
  // `app.locals.debugDeps`, which `index.ts` sets alongside the deep-health bag.
  // ALWAYS mounted and read-only: an env gate would make it unavailable in the
  // one situation it exists for, because enabling it needs a restart and a
  // restart destroys the in-memory state you wanted to read. It carries only
  // what a span may carry, and inherits `hostGuard` + `sessionGate` with no
  // carve-out — see `routes/debug.ts`.
  app.use('/api/debug', debugRoutes);

  // Test control routes — only mounted when DORKOS_TEST_RUNTIME=true.
  // The router is always imported (safe: no vitest/SDK deps), but routes are
  // only reachable when the env var is set, so production is unaffected.
  if (env.DORKOS_TEST_RUNTIME) {
    app.use('/api/test', testControlRouter);
    // The mock OAuth-protected MCP server (DOR-952) — mounted at the app ROOT so
    // it can serve the `/.well-known/*` discovery paths there (RFC 9728/8414),
    // alongside its `/api/test/mcp-oauth/*` auth + MCP endpoints. Gated the same
    // way, so none of these paths exist in production.
    app.use(createMockMcpOAuthRouter());
  }

  // OpenAPI spec + interactive docs
  const spec = generateOpenAPISpec();
  app.get('/api/openapi.json', (_req, res) => res.json(spec));
  app.use('/api/docs', apiReference({ content: spec }));

  return app;
}

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
 * `null` to leave `express.static`'s defaults alone.
 *
 * Only the two paths whose caching can actually break the app are named: the
 * shell file, and the directory of hashed bundles. Everything else at the dist
 * root (favicon, manifest, icons) keeps `max-age=0` + ETag — cheap to
 * revalidate, and harmless when stale.
 *
 * @param distPath - Absolute path of the client dist root.
 * @param filePath - Absolute path of the file `express.static` resolved.
 */
function cacheControlForDistFile(distPath: string, filePath: string): string | null {
  if (path.basename(filePath) === 'index.html') return SHELL_HEADERS['Cache-Control'];
  const relative = path.relative(distPath, filePath);
  if (relative.split(path.sep)[0] === HASHED_ASSET_DIR) return IMMUTABLE_ASSET_HEADER;
  return null;
}

/**
 * Finalize the Express app by adding the API 404 catch-all, error handler,
 * and production SPA serving. Must be called after all API routes are mounted.
 */
export function finalizeApp(app: express.Express): void {
  // API 404 -- must come after all /api routes, before SPA catch-all
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found', code: 'API_NOT_FOUND' });
  });

  // Error handler (must be after routes)
  app.use(errorHandler);

  // In production, serve the built React app
  if (env.NODE_ENV === 'production') {
    const distPath = env.CLIENT_DIST_PATH ?? path.join(__dirname, '../../client/dist');
    // Both places the shell can leave this process are latched, because which
    // one answers depends only on whether the URL was a deep link — and the
    // marker is about the shell reaching a browser at all. See
    // `createFirstContactMarker`.
    const noteShellServed = createFirstContactMarker('[Client] first index.html served');
    app.use(
      express.static(distPath, {
        setHeaders: (res, filePath) => {
          if (path.basename(filePath) === 'index.html') {
            noteShellServed();
            // The shell served straight off disk (`/`, `/index.html`) has to
            // carry the policy too — the fallback below is only reached by deep
            // links, so setting it there alone would leave the app's most
            // common entry unprotected.
            res.setHeader('Content-Security-Policy', SHELL_HEADERS['Content-Security-Policy']);
          }
          const cacheControl = cacheControlForDistFile(distPath, filePath);
          if (cacheControl) res.setHeader('Cache-Control', cacheControl);
        },
      })
    );
    // A GET/HEAD under /assets/ that express.static above didn't already
    // serve is a missing hashed bundle, not a client route -- 404 it here so
    // it can't reach the SPA fallback below. Without this, a stale or broken
    // reference to a hashed bundle presents as a silent blank window (the
    // shell loads, its script tag 404s into HTML, nothing renders) instead of
    // a diagnosable 404 in the network tab (DOR-1474).
    app.use('/assets', (req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      res.status(404).type('text/plain').send(`Not found: ${req.originalUrl}`);
    });

    // SPA fallback: serve index.html for any GET/HEAD not handled by static
    // assets or the API routes above, so client-side deep links resolve. Two
    // Express 5 details: (1) a bare app.get('*') throws under path-to-regexp v8,
    // so use a pathless terminal middleware (matching app.get('*')'s GET+HEAD
    // scope, not all methods); (2) res.sendFile with an ABSOLUTE path 404s for
    // multi-segment request URLs (send resolves the request path against it) —
    // the { root } form serves index.html reliably regardless of req.url.
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      // Latched from the callback, so the marker means the shell actually went
      // out. Claiming it before the send would put "first index.html served"
      // in the log of a build whose dist is missing — precisely the boot where
      // the line would be read most carefully, and most misleading. Supplying
      // a callback makes error handling ours, so the failure is forwarded the
      // way `sendFile` forwards it on its own.
      res.sendFile('index.html', { root: distPath, headers: SHELL_HEADERS }, (err) => {
        if (err) return next(err);
        noteShellServed();
      });
    });
  }
}
