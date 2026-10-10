import type { MainRequestAdmission } from './services/core/lifecycle/main-request-admission.js';
import { terminalAdmission } from './middleware/terminal-admission.js';
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
import projectRoutes from './routes/projects.js';
import roomRoutes from './routes/rooms.js';
import canvasDocEventRoutes, { canvasDocJsonParser } from './routes/canvas-doc-events.js';
import { createCommunityConnectionsRouter } from './routes/community-connections.js';
import { createRemoteCommunitiesRouter } from './routes/remote-communities.js';
import { requireSpacesEnabled } from './middleware/spaces-enabled.js';
import readCursorRoutes from './routes/read-cursors.js';
import tunnelRoutes from './routes/tunnel.js';
import cloudRoutes from './routes/cloud.js';
import feedbackRoutes, { feedbackJsonParser } from './routes/feedback.js';
import modelRoutes from './routes/models.js';
import subagentRoutes from './routes/subagents.js';
import capabilitiesRoutes from './routes/capabilities.js';
import systemRoutes from './routes/system.js';
import keepAwakeRoutes from './routes/keep-awake.js';
import runtimesRoutes from './routes/runtimes.js';
import uploadRoutes from './routes/uploads.js';
import mcpConfigRoutes from './routes/mcp-config.js';
import errorRoutes from './routes/errors.js';
import debugRoutes from './routes/debug.js';
import eventsRouter from './routes/events.js';
import { generateOpenAPISpec } from './services/core/openapi-registry.js';
import { errorHandler } from './middleware/error-handler.js';
import { hostGuard } from './middleware/host-guard.js';
import {
  createConnectorSignedIngress,
  type ConnectorSignedIngress,
} from './services/connectors/events/signed-ingress.js';
import { requestLogger } from './middleware/request-logger.js';
import { resolveAgentIdentity } from './middleware/agent-identity.js';
import { auditActor } from './middleware/audit-actor.js';
import { auditRequestFallback } from './middleware/audit-request-fallback.js';
import { sessionGate } from './services/core/auth/index.js';
import { expressRequestFacts } from './http/request-facts.js';
import { corsAllowsOrigin, corsRefusal, warnOnWildcardCorsOrigin } from './http/cors-policy.js';
import { createFirstContactMarker } from './http/first-contact.js';
import { API_JSON_BODY_LIMIT } from './http/request-body.js';
import { testControlRouter } from './routes/test-control.js';
import { createMockMcpOAuthRouter } from './routes/mock-mcp-oauth-server.js';
import { env } from './env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Build the CORS middleware: the `cors` package in its delegate form, every
 * decision delegated to {@link corsAllowsOrigin} (`http/cors-policy.ts`), the
 * one rule both chains share.
 *
 * The delegate form (`cors((req, cb) => ...)`) is required because the plain
 * `origin` callback never receives the request, and the policy needs the
 * request's own `Host` and forwarded scheme.
 */
function buildCors(): express.RequestHandler {
  warnOnWildcardCorsOrigin();
  return cors<express.Request>((req, done) => {
    done(null, {
      credentials: true,
      origin: (origin, callback) => {
        if (corsAllowsOrigin(expressRequestFacts(req))) return callback(null, true);
        callback(corsRefusal(origin));
      },
    });
  });
}

/** Create and configure the Express application with middleware and routes. */
export function createApp(options: {
  admission: MainRequestAdmission;
  connectorEventIngress?: ConnectorSignedIngress;
}) {
  const app = express();
  app.use(terminalAdmission(options.admission));

  // Trust one forwarded hop. Today that feeds one thing: `req.ip`, which the
  // rate limiters read (as `forwardedAddress`) only when `DORKOS_TRUST_PROXY`
  // says a proxy is in front. A reverse proxy or the tunnel names the real
  // scheme in `X-Forwarded-Proto` too, which Better Auth reads itself
  // (`http/better-auth.ts`).
  //
  // NOTHING SECURITY-RELEVANT MAY READ WHAT THIS DERIVES (DOR-1711). On a direct
  // connection the "first proxy" is the caller, so `req.ip`, `req.ips` and
  // `req.hostname` are all attacker-written: anyone can send
  // `X-Forwarded-For: 1.2.3.4` and become `req.ip`. Two consequences are already
  // enforced elsewhere and must stay that way:
  //   - the origin and host decisions read RAW headers and the RAW socket —
  //     `middleware/host-guard.ts`, `middleware/browser-origin.ts`,
  //     `lib/trusted-origins.ts`;
  //   - every rate limiter keys through `middleware/rate-limit-key.ts`, which
  //     reads the socket peer unless `DORKOS_TRUST_PROXY` explicitly says a
  //     proxy is in front. Until DOR-1711 they all inherited this line, so a
  //     rotating `X-Forwarded-For` bought unlimited buckets and the sign-in
  //     brute-force limiter counted nothing.
  // One trusted hop. `forwardedClientAddress` in `http/request-facts.ts` gives
  // the Hono chain the same `req.ip`; change both together.
  app.set('trust proxy', 1);

  // After terminal admission, but ahead of the other `/api` handlers: a
  // request that arrives and is then rejected still proves the client reached
  // this running process, which is the only thing this line claims.
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
  // `express.json` so a rejected body is never parsed. (Better Auth now answers
  // from the Hono chain, behind that chain's copy of this guard:
  // `http/better-auth.ts`.) Inert when login is on (auth
  // cookies are origin-scoped) or when the container escape hatch is set — see
  // `middleware/host-guard.ts`.
  app.use('/api', hostGuard);
  if (options.connectorEventIngress) {
    app.post(
      '/api/connectors/webhooks/:providerInstanceId',
      ...createConnectorSignedIngress(options.connectorEventIngress)
    );
  }

  // Feedback submissions carry an opt-in screenshot inline as a `data:` URL, so
  // this one path parses with a larger ceiling than the app-wide limit below.
  // Mounted BEFORE that parser deliberately: body-parser skips a request whose
  // body another parser already read, so the same middleware placed on the
  // feedback router (mounted further down) would never bind and the app-wide
  // 1 MB limit would 413 the submission first. Path-scoped, so nothing else
  // gains the larger ceiling.
  app.use('/api/feedback', feedbackJsonParser);
  // Preserve signed webhook bytes before JSON consumes the stream. This only
  // parses: sessionGate and the Relay receiver still own authorization/dispatch.
  app.post('/api/relay/webhooks/:adapterId', express.raw({ type: '*/*', limit: '1mb' }));
  // Page envelopes have a smaller wire ceiling than ordinary API requests.
  app.use('/api/canvas/docs', canvasDocJsonParser);
  app.use(express.json({ limit: API_JSON_BODY_LIMIT }));
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
  // Who is acting, for the audit log (spec `audit-trail`). After both gates,
  // so it reads what they decided rather than deciding again.
  app.use(auditActor);
  // A mutating request no choke point recorded still leaves a line.
  app.use(auditRequestFallback);

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
  app.use('/api/projects', projectRoutes);
  app.use('/api/rooms', roomRoutes);
  app.use('/api/canvas/docs', canvasDocEventRoutes);
  // Spaces are an experiment, off by default (DOR-2740): both refuse until a
  // person turns `spaces.enabled` on. This machine's own rooms are above.
  app.use('/api/community-connections', requireSpacesEnabled, createCommunityConnectionsRouter());
  app.use('/api/communities', requireSpacesEnabled, createRemoteCommunitiesRouter());
  app.use('/api/read-cursors', readCursorRoutes);
  app.use('/api/tunnel', tunnelRoutes);
  app.use('/api/cloud', cloudRoutes);
  app.use('/api/feedback', feedbackRoutes);
  app.use('/api/models', modelRoutes);
  app.use('/api/subagents', subagentRoutes);
  app.use('/api/capabilities', capabilitiesRoutes);
  app.use('/api/system', systemRoutes);
  app.use('/api/keep-awake', keepAwakeRoutes);
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
