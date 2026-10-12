import type { MainRequestAdmission } from './services/core/lifecycle/main-request-admission.js';
import { terminalAdmission } from './middleware/terminal-admission.js';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { createCommunityConnectionsRouter } from './routes/community-connections.js';
import { createRemoteCommunitiesRouter } from './routes/remote-communities.js';
import { gateCommunityConnections, gateRemoteCommunities } from './middleware/spaces-enabled.js';
import { errorHandler } from './middleware/error-handler.js';
import { hostGuard } from './middleware/host-guard.js';
import { managedHostGuard } from './middleware/managed-host-guard.js';
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
export function createApp(options: { admission: MainRequestAdmission }) {
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
  // `express.json` so a rejected body is never parsed. (Better Auth and the
  // signed connector webhook now answer from the Hono chain, behind that
  // chain's copy of this guard: `http/better-auth.ts`,
  // `services/connectors/events/signed-ingress.ts`.) Inert when login is on (auth
  // cookies are origin-scoped) or when the container escape hatch is set — see
  // `middleware/host-guard.ts`.
  app.use('/api', hostGuard);

  app.use(express.json({ limit: API_JSON_BODY_LIMIT }));
  app.use(requestLogger);

  // Session gate — when `config.auth.enabled` is true, require a Better Auth
  // session cookie or a per-user API key on `/api/*` and `/mcp` (exemptions for
  // SPA assets, `/api/auth/*`, and `/api/health`). Mounted app-wide before the
  // API routes so it also covers the mounts `index.ts` adds later on this same
  // app. (`/mcp` itself answers from the Hono chain, which runs the same gate.)
  // Zero-overhead pass-through when login is disabled.
  app.use(sessionGate);

  // Agent identity — resolves an `X-DorkOS-Agent` token onto
  // `res.locals.agentIdentity` so capability invocations can be attributed to
  // the agent that made them. Mounted AFTER `sessionGate` (which owns the
  // auth decision) and before the routes, app-wide so it also covers the mounts
  // added later in `index.ts`. Never rejects: a request without a token
  // behaves exactly as it does today.
  app.use(resolveAgentIdentity);
  // Who is acting, for the audit log (spec `audit-trail`). After both gates,
  // so it reads what they decided rather than deciding again.
  app.use(auditActor);
  // A mutating request no choke point recorded still leaves a line.
  app.use(auditRequestFallback);

  // API routes
  // Spaces are an experiment, off by default (DOR-2740): both refuse until a
  // person turns `spaces.enabled` on, except for the official space (spec
  // `official-community-space` D5), which each gate lets through by its
  // `:ref`. This machine's own rooms answer from the Hono chain
  // (`routes/rooms.ts`).
  app.use(
    '/api/community-connections',
    gateCommunityConnections(),
    createCommunityConnectionsRouter()
  );
  app.use('/api/communities', gateRemoteCommunities(), createRemoteCommunitiesRouter());

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
