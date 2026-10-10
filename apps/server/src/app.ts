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
import { createRemoteAccessRouter } from './routes/remote-access.js';
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
import { managedHostGuard } from './middleware/managed-host-guard.js';
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
import { createClientFiles } from './http/client-files.js';
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
  // A managed remote-access hostname is served only through the managed
  // ingress, which checks the edge proof; on this listener it is refused before
  // any logger or route sees it.
  app.use(managedHostGuard);

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
  app.use('/api/remote-access', createRemoteAccessRouter());
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

  // In production, serve the built client: the last thing the server answers,
  // and only what no route above claimed (`http/client-files.ts`).
  if (env.NODE_ENV === 'production') {
    app.use(createClientFiles(env.CLIENT_DIST_PATH ?? path.join(__dirname, '../../client/dist')));
  }
}
