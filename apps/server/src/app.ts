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
import eventsRouter from './routes/events.js';
import { generateOpenAPISpec } from './services/core/openapi-registry.js';
import { errorHandler } from './middleware/error-handler.js';
import { requestLogger } from './middleware/request-logger.js';
import { buildAuthRateLimiter } from './middleware/auth-rate-limit.js';
import { getAuth, toNodeHandler, sessionGate } from './services/core/auth/index.js';
import { resolveTrustedOrigins } from './lib/trusted-origins.js';
import { testControlRouter } from './routes/test-control.js';
import { env } from './env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Build a dynamic CORS origin callback that checks tunnel URL at request time.
 *
 * When a tunnel is connected, its origin is dynamically added to the allowlist
 * so that requests from the tunnel URL are accepted without restarting the server.
 */
function buildCorsOrigin(): cors.CorsOptions['origin'] {
  // eslint-disable-next-line no-restricted-syntax -- DORKOS_CORS_ORIGIN is not in env.ts (optional CORS override, not worth validating)
  const envOrigin = process.env.DORKOS_CORS_ORIGIN;

  // Explicit wildcard opt-in
  if (envOrigin === '*') return '*';

  // User-specified origins (comma-separated) — static, no tunnel check needed
  if (envOrigin) {
    return envOrigin.split(',').map((o) => o.trim());
  }

  // Dynamic callback: static loopback origins + the live tunnel origin,
  // resolved per request via the shared trusted-origin policy.
  return (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    // Allow requests with no origin (server-to-server, curl, etc.)
    if (!origin) return callback(null, true);

    if (resolveTrustedOrigins().includes(origin)) return callback(null, true);

    callback(new Error(`Origin ${origin} not allowed by CORS`));
  };
}

/** Create and configure the Express application with middleware and routes. */
export function createApp() {
  const app = express();

  // Trust the first proxy (ngrok) for correct req.hostname, req.ip, req.protocol
  app.set('trust proxy', 1);

  // `credentials: true` sends Access-Control-Allow-Credentials: true so the
  // browser accepts cross-origin responses to the client's `credentials:
  // 'include'` fetches (auth cookies) — the desktop dev renderer (a distinct
  // Vite origin) is the sole cross-origin surface; the web cockpit is
  // same-origin via the Vite proxy. Note: this doesn't affect the explicit
  // `DORKOS_CORS_ORIGIN='*'` opt-in above — wildcard ACAO is invalid for
  // credentialed requests per the fetch spec, so browsers reject it
  // regardless of this flag; that path stays wildcard for non-credentialed use.
  app.use(cors({ origin: buildCorsOrigin(), credentials: true }));

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
  app.use('/api/tunnel', tunnelRoutes);
  app.use('/api/cloud', cloudRoutes);
  app.use('/api/feedback', feedbackRoutes);
  app.use('/api/models', modelRoutes);
  app.use('/api/subagents', subagentRoutes);
  app.use('/api/capabilities', capabilitiesRoutes);
  app.use('/api/system', systemRoutes);
  app.use('/api/runtimes', runtimesRoutes);
  app.use('/api/uploads', uploadRoutes);
  app.use('/api/mcp-config', mcpConfigRoutes);
  app.use('/api/errors', errorRoutes);
  app.use('/api/events', eventsRouter);

  // Test control routes — only mounted when DORKOS_TEST_RUNTIME=true.
  // The router is always imported (safe: no vitest/SDK deps), but routes are
  // only reachable when the env var is set, so production is unaffected.
  if (env.DORKOS_TEST_RUNTIME) {
    app.use('/api/test', testControlRouter);
  }

  // OpenAPI spec + interactive docs
  const spec = generateOpenAPISpec();
  app.get('/api/openapi.json', (_req, res) => res.json(spec));
  app.use('/api/docs', apiReference({ content: spec }));

  return app;
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
    app.use(express.static(distPath));
    // SPA fallback: serve index.html for any GET/HEAD not handled by static
    // assets or the API routes above, so client-side deep links resolve. Two
    // Express 5 details: (1) a bare app.get('*') throws under path-to-regexp v8,
    // so use a pathless terminal middleware (matching app.get('*')'s GET+HEAD
    // scope, not all methods); (2) res.sendFile with an ABSOLUTE path 404s for
    // multi-segment request URLs (send resolves the request path against it) —
    // the { root } form serves index.html reliably regardless of req.url.
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      res.sendFile('index.html', { root: distPath });
    });
  }
}
