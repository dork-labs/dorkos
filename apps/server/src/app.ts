import express from 'express';
import cors from 'cors';
import cookieSession from 'cookie-session';
import crypto from 'node:crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { apiReference } from '@scalar/express-api-reference';
import { PASSCODE_SESSION_MAX_AGE_MS } from '@dorkos/shared/constants';
import sessionRoutes from './routes/sessions.js';
import commandRoutes from './routes/commands.js';
import healthRoutes from './routes/health.js';
import directoryRoutes from './routes/directory.js';
import configRoutes from './routes/config.js';
import fileRoutes from './routes/files.js';
import gitRoutes from './routes/git.js';
import tunnelRoutes from './routes/tunnel.js';
import modelRoutes from './routes/models.js';
import subagentRoutes from './routes/subagents.js';
import capabilitiesRoutes from './routes/capabilities.js';
import systemRoutes from './routes/system.js';
import uploadRoutes from './routes/uploads.js';
import mcpConfigRoutes from './routes/mcp-config.js';
import eventsRouter from './routes/events.js';
import { generateOpenAPISpec } from './services/core/openapi-registry.js';
import { errorHandler } from './middleware/error-handler.js';
import { requestLogger } from './middleware/request-logger.js';
import { tunnelPasscodeAuth } from './middleware/tunnel-auth.js';
import { tunnelManager } from './services/core/tunnel-manager.js';
import { configManager } from './services/core/config-manager.js';
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

  // Dynamic callback: localhost origins + tunnel URL when connected
  const port = String(env.DORKOS_PORT);
  // eslint-disable-next-line no-restricted-syntax -- VITE_PORT is a Vite-specific var not in server env.ts
  const vitePort = process.env.VITE_PORT || '4241';
  const staticOrigins = [
    `http://localhost:${port}`,
    `http://localhost:${vitePort}`,
    `http://127.0.0.1:${port}`,
    `http://127.0.0.1:${vitePort}`,
  ];

  return (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    // Allow requests with no origin (server-to-server, curl, etc.)
    if (!origin) return callback(null, true);

    if (staticOrigins.includes(origin)) return callback(null, true);

    // Check tunnel URL dynamically at request time
    const tunnelUrl = tunnelManager.status.url;
    if (tunnelUrl) {
      const tunnelOrigin = new URL(tunnelUrl).origin;
      if (origin === tunnelOrigin) return callback(null, true);
    }

    callback(new Error(`Origin ${origin} not allowed by CORS`));
  };
}

/** Create and configure the Express application with middleware and routes. */
export function createApp() {
  const app = express();

  // Trust the first proxy (ngrok) for correct req.hostname, req.ip, req.protocol
  app.set('trust proxy', 1);

  app.use(cors({ origin: buildCorsOrigin() }));

  app.use(express.json({ limit: '1mb' }));
  app.use(requestLogger);

  // Session middleware for tunnel passcode authentication
  let sessionSecret = configManager.get('sessionSecret');
  if (!sessionSecret) {
    sessionSecret = crypto.randomBytes(32).toString('hex');
    configManager.set('sessionSecret', sessionSecret);
  }

  app.use(
    cookieSession({
      name: 'dorkos_session',
      keys: [sessionSecret],
      maxAge: PASSCODE_SESSION_MAX_AGE_MS,
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'strict',
    })
  );

  // Gate tunnel requests behind passcode when enabled
  app.use(tunnelPasscodeAuth);

  // API routes
  app.use('/api/sessions', sessionRoutes);
  app.use('/api/commands', commandRoutes);
  app.use('/api/health', healthRoutes);
  app.use('/api/directory', directoryRoutes);
  app.use('/api/config', configRoutes);
  app.use('/api/files', fileRoutes);
  app.use('/api/git', gitRoutes);
  app.use('/api/tunnel', tunnelRoutes);
  app.use('/api/models', modelRoutes);
  app.use('/api/subagents', subagentRoutes);
  app.use('/api/capabilities', capabilitiesRoutes);
  app.use('/api/system', systemRoutes);
  app.use('/api/uploads', uploadRoutes);
  app.use('/api/mcp-config', mcpConfigRoutes);
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
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }
}
