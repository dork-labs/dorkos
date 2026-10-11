import { checkA2aExposure } from '../services/core/auth/exposure-guard.js';
import { configManager } from '../services/core/config-manager.js';
import { logger } from '../lib/logger.js';
import { createA2aRouter } from '../routes/a2a.js';
import { buildA2aRateLimiters } from '../middleware/a2a-rate-limit.js';
import { createDiscoveryRouter } from '../routes/discovery.js';
import { createExtensionsRouter } from '../routes/extensions.js';
import { createExtensionRoutesMiddleware } from '../middleware/extension-routes.js';
import { createMcpAuth } from '../middleware/mcp-auth.js';
import { env } from '../env.js';
import type { Express } from 'express';
import type { Db } from '@dorkos/db';

interface OptionalGatewayPorts {
  readonly extensionManager: Parameters<typeof createExtensionsRouter>[0] | undefined;
  readonly meshCore: Parameters<typeof createA2aRouter>[0]['meshCore'] | undefined;
  readonly relayCore: Parameters<typeof createA2aRouter>[0]['relay'] | undefined;
  readonly db: Db;
  readonly dorkHome: string;
  readonly port: number;
  readonly mountedRouters: string[];
}
/** Mount optional extension, discovery and A2A surfaces in the original fixed order. */
export function mountOptionalGateways(app: Express, ports: OptionalGatewayPorts): void {
  // Mount Extensions routes if extension system initialized successfully.
  if (ports.extensionManager) {
    app.use(
      '/api/extensions',
      createExtensionsRouter(
        ports.extensionManager,
        ports.dorkHome,
        () => env.DORKOS_DEFAULT_CWD ?? null
      )
    );

    // Delegate /api/ext/:id/* to extension-registered Express routers
    app.use('/api/ext/:id', createExtensionRoutesMiddleware(ports.extensionManager));

    ports.mountedRouters.push('extensions');
  }

  // Mount Discovery routes when MeshCore is available (delegates to ports.meshCore.discover())
  if (ports.meshCore) {
    app.use('/api/discovery', createDiscoveryRouter(ports.meshCore));
    ports.mountedRouters.push('discovery');
  }

  // Mount A2A gateway if enabled — requires both Relay (message routing) and Mesh (agent registry)
  //
  // The gate is `a2a.enabled` in config, with `DORKOS_A2A_ENABLED` winning in
  // BOTH directions when it is present — the same shape Tasks and Relay use
  // above, so a headless deployment keeps deciding from its environment and the
  // Experiments section can honestly report the setting as locked (DOR-1304).
  const a2aEnabled =
    // eslint-disable-next-line no-restricted-syntax -- Checking presence, not value: env.ts can't distinguish "unset" from "set to false"
    'DORKOS_A2A_ENABLED' in process.env
      ? env.DORKOS_A2A_ENABLED
      : (configManager.get('a2a')?.enabled ?? false);
  if (a2aEnabled && ports.relayCore && ports.meshCore) {
    // The A2A surface is guarded by createMcpAuth({ surface: 'a2a' }). In
    // login-off mode the per-instance local token gates JSON-RPC execution, but
    // that token is a loopback-trust mechanism (a 0600 file only a local operator
    // can read) — it does not make the surface safe on a non-loopback bind. So the
    // exposure guard still keys off a network-reachable credential (an env key,
    // the legacy compat key, or login) to decide whether A2A may mount off loopback.
    //
    // This answers "may A2A face the network?" and nothing else. It is NOT what
    // Agent Cards advertise: execution is gated in every posture, so cards state
    // the bearer requirement unconditionally (DOR-1824, agent-card-generator.ts).
    const authConfigured =
      !!env.MCP_API_KEY?.trim() ||
      !!configManager.get('mcp')?.apiKey ||
      configManager.get('auth')?.enabled === true;

    // Exposure guard: refuse to mount the external A2A surface (JSON-RPC plus
    // the agent-card discovery endpoints) on a non-loopback host when nothing
    // gates it — otherwise remote prompt execution against every agent would be
    // open to the network. Unlike the bind check this is not a hard exit: the
    // loopback cockpit stays usable; only the A2A surface is withheld.
    const a2aExposure = checkA2aExposure({
      host: env.DORKOS_HOST,
      authConfigured,
      allowInsecureBind: env.DORKOS_ALLOW_INSECURE_BIND,
    });
    if (!a2aExposure.allowed) {
      logger.error(`[A2A] ${a2aExposure.reason}`);
      // Also to stderr so an operator starting from a terminal sees why the
      // surface they enabled did not come up.
      console.error(`\n${a2aExposure.reason}\n`);
    } else {
      if (a2aExposure.warning) logger.warn(`[A2A] ${a2aExposure.warning}`);

      // Advertised card URL: prefer the explicit public URL — behind a proxy or
      // tunnel the {host}:{port} bind is non-routable (e.g. http://0.0.0.0:ports.port).
      // Trailing slashes are stripped so `${baseUrl}/a2a` stays clean.
      const baseUrl = (env.DORKOS_PUBLIC_URL ?? `http://${env.DORKOS_HOST}:${ports.port}`).replace(
        /\/+$/,
        ''
      );
      const version = env.DORKOS_VERSION_OVERRIDE ?? '0.0.0';
      const { rpc: rpcRateLimiter, card: cardRateLimiter } = buildA2aRateLimiters({
        rpcMaxPerMinute: env.DORKOS_A2A_RPC_RATE_LIMIT,
        cardMaxPerMinute: env.DORKOS_A2A_CARD_RATE_LIMIT,
      });

      const { router: a2aRouter, fleetCardHandler } = createA2aRouter({
        meshCore: ports.meshCore,
        relay: ports.relayCore,
        db: ports.db,
        baseUrl,
        version,
        rpcRateLimiter,
        cardRateLimiter,
      });

      // Fleet Agent Card at the spec well-known path (AGENT_CARD_PATH in the
      // A2A SDK — standard clients discover the card here). The legacy
      // /.well-known/agent.json path is kept during the transition. Cards get
      // the lighter discovery limiter, applied before auth so unauthenticated
      // scraping is throttled too.
      const a2aAuth = createMcpAuth({ surface: 'a2a' });
      app.get('/.well-known/agent-card.json', cardRateLimiter, a2aAuth, fleetCardHandler);
      app.get('/.well-known/agent.json', cardRateLimiter, a2aAuth, fleetCardHandler);

      // Per-agent cards and JSON-RPC under /a2a (per-route limiters live in the router)
      app.use('/a2a', a2aAuth, a2aRouter);

      // Names the credential a caller must send. "none" was never true here —
      // execution is gated in every posture; only WHICH credential changes.
      // With login OFF but an env/legacy key set, acceptor 4 in mcp-auth.ts is
      // gated on `!authEnabled` — not on the key — so the local token still
      // passes there too. Name every credential that works, or the line trades
      // one lie for a smaller one.
      const a2aAuthMode = authConfigured
        ? 'auth: API key, login, or local MCP token'
        : 'auth: local MCP token (loopback)';
      logger.info(
        `[A2A] Gateway mounted (fleet card: /.well-known/agent-card.json, RPC: POST /a2a, ${a2aAuthMode})`
      );
    }
  }
}
