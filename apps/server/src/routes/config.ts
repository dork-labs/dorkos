import { Router } from 'express';
import { tunnelManager } from '../services/core/tunnel-manager.js';
import { resolveClaudeCliPath } from '../services/runtimes/claude-code/sdk/sdk-utils.js';
import { configManager } from '../services/core/config-manager.js';
import { env } from '../env.js';
import {
  UserConfigSchema,
  SENSITIVE_CONFIG_KEYS,
  SIDEBAR_PREFS_DEFAULTS,
  SHAPE_USER_PREFS_DEFAULTS,
} from '@dorkos/shared/config-schema';
import { getLatestVersion } from '../services/core/update-checker.js';
import { isTasksEnabled, getTasksInitError } from '../services/tasks/task-state.js';
import { isRelayEnabled, getRelayInitError } from '../services/relay/relay-state.js';
import { getMeshInitError } from '../services/mesh/mesh-state.js';
import { getBoundary } from '../lib/boundary.js';
import { SERVER_VERSION, IS_DEV_BUILD } from '../lib/version.js';
import { logger, logError } from '../lib/logger.js';
import { hasAnyApiKey } from '../services/core/auth/index.js';
import { getMcpLocalToken, rotateMcpLocalToken } from '../services/core/auth/mcp-local-token.js';
import { resolveDorkHome } from '../lib/dork-home.js';

const router = Router();

/** Keys that must be filtered during deep merge to prevent prototype pollution. */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Recursively merge source object into target.
 * Arrays are replaced (not merged). Null values from source override target.
 */
export function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...target };

  for (const [key, sourceValue] of Object.entries(source)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    const targetValue = result[key];

    if (
      sourceValue !== null &&
      typeof sourceValue === 'object' &&
      !Array.isArray(sourceValue) &&
      targetValue !== null &&
      typeof targetValue === 'object' &&
      !Array.isArray(targetValue)
    ) {
      result[key] = deepMerge(
        targetValue as Record<string, unknown>,
        sourceValue as Record<string, unknown>
      );
    } else {
      result[key] = sourceValue;
    }
  }

  return result;
}

/**
 * Extract all dot-path keys from a nested object.
 * Example: { server: { port: 4242 } } -> ['server.port']
 */
function flattenKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  const keys: string[] = [];

  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;

    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      keys.push(...flattenKeys(value as Record<string, unknown>, fullKey));
    } else {
      keys.push(fullKey);
    }
  }

  return keys;
}

/**
 * List the agent runtimes configured on this host.
 *
 * claude-code is always available; codex and opencode are included unless a user
 * has explicitly disabled them in config (both default to enabled).
 */
function configuredRuntimes(): string[] {
  const runtimes = ['claude-code'];
  const config = configManager.get('runtimes');
  if (config?.codex?.enabled !== false) runtimes.push('codex');
  if (config?.opencode?.enabled !== false) runtimes.push('opencode');
  return runtimes;
}

router.get('/', async (_req, res) => {
  let claudeCliPath: string | null = null;
  try {
    claudeCliPath = resolveClaudeCliPath() ?? null;
  } catch {
    // CLI path resolution can fail — fallback to null
  }

  const tunnel = tunnelManager.status;
  const latestVersion = await getLatestVersion();

  res.json({
    version: SERVER_VERSION,
    latestVersion,
    isDevMode: IS_DEV_BUILD,
    dismissedUpgradeVersions:
      (configManager.get('ui') as { dismissedUpgradeVersions?: string[] } | undefined)
        ?.dismissedUpgradeVersions ?? [],
    port: env.DORKOS_PORT,
    uptime: process.uptime(),
    workingDirectory: process.cwd(),
    platform: `${process.platform}-${process.arch}`,
    runtimes: configuredRuntimes(),
    boundary: getBoundary(),
    // Set by index.ts at startup before routes are registered — always present at request time
    dorkHome: process.env.DORK_HOME!,
    nodeVersion: process.version,
    claudeCliPath,
    tunnel: {
      ...tunnel,
      authEnabled: tunnel.authEnabled || !!env.TUNNEL_AUTH,
      tokenConfigured:
        tunnel.tokenConfigured || !!(env.NGROK_AUTHTOKEN || configManager.get('tunnel')?.authtoken),
    },
    tasks: {
      enabled: isTasksEnabled(),
      ...(getTasksInitError() && { initError: getTasksInitError() }),
    },
    relay: {
      enabled: isRelayEnabled(),
      ...(getRelayInitError() && { initError: getRelayInitError() }),
    },
    scheduler: configManager.get('scheduler') ?? {
      maxConcurrentRuns: 1,
      timezone: null,
      retentionCount: 100,
    },
    logging: configManager.get('logging') ?? {
      level: 'info',
      maxLogSizeKb: 500,
      maxLogFiles: 14,
    },
    mesh: {
      enabled: true,
      scanRoots: configManager.get('mesh')?.scanRoots ?? [],
      ...(getMeshInitError() && { initError: getMeshInitError() }),
    },
    // Normalize completedAt: an on-disk block written before the field existed
    // omits it (conf's nested defaults-merge is shallow), but the wire contract
    // promises string | null.
    onboarding: (() => {
      const onboarding = configManager.get('onboarding');
      return onboarding
        ? { ...onboarding, completedAt: onboarding.completedAt ?? null }
        : {
            completedSteps: [],
            skippedSteps: [],
            startedAt: null,
            dismissedAt: null,
            completedAt: null,
          };
    })(),
    agentContext: configManager.get('agentContext') ?? {
      relayTools: true,
      meshTools: true,
      adapterTools: true,
      tasksTools: true,
    },
    agents: configManager.get('agents') ?? {
      defaultDirectory: '~/.dork/agents',
      defaultAgent: 'dorkbot',
    },
    mcp: (() => {
      const mcpConfig = configManager.get('mcp');
      // Trim-for-presence: a whitespace-only MCP_API_KEY counts as unset,
      // matching the boot wiring, the token module, and the auth middleware.
      const envKey = env.MCP_API_KEY?.trim() || null;
      const legacyKey = mcpConfig?.apiKey ?? null;
      const localToken = getMcpLocalToken();
      // authSource reports how MCP access is secured:
      //   'env'         — the static MCP_API_KEY override (headless deployments).
      //   'user-keys'   — per-user Better Auth API keys (the current model), or a
      //                   not-yet-seeded legacy config key on its way to becoming one.
      //   'local-token' — login off, no MCP_API_KEY: the per-instance local token
      //                   gates the mutating surface (DOR-278). The surface is
      //                   still gated, so authConfigured is true.
      //   'none'        — the degenerate can't-generate fallback (should not occur
      //                   in a normal login-off boot).
      const authSource: 'env' | 'user-keys' | 'none' | 'local-token' = envKey
        ? 'env'
        : legacyKey || hasAnyApiKey()
          ? 'user-keys'
          : localToken
            ? 'local-token'
            : 'none';
      return {
        enabled: mcpConfig?.enabled ?? true,
        authConfigured: authSource !== 'none',
        authSource,
        // The token value itself deliberately does NOT ride this GET: it is
        // revealed only via POST /api/config/mcp/reveal-token so it never lands
        // in GET caches or logs and never leaks through a generic config dump.
        endpoint: `http://localhost:${env.DORKOS_PORT}/mcp`,
        rateLimit: mcpConfig?.rateLimit ?? { enabled: true, maxPerWindow: 60, windowSecs: 60 },
      };
    })(),
    // Fallback mirrors the schema defaults (Tier 1 channels on, notice-gated).
    telemetry: configManager.get('telemetry') ?? {
      userHasDecided: false,
      install: true,
      heartbeat: true,
      errorReporting: false,
      lastPromptedVersion: null,
      usage: true,
      linkAnalyticsToAccount: false,
      aiMetadata: false,
    },
    auth: configManager.get('auth') ?? { enabled: false },
    workbench: configManager.get('workbench') ?? { defaultViewers: {} },
    // Surface the sidebar organization + Shape prefs so the client can read them
    // via useConfig() (DOR-329, DOR-355). Schema defaults + the backfill
    // migrations guarantee `ui.sidebar`/`ui.shapes` are present; the fallbacks
    // cover the pre-migration read window.
    ui: {
      sidebar: configManager.get('ui')?.sidebar ?? SIDEBAR_PREFS_DEFAULTS,
      shapes: configManager.get('ui')?.shapes ?? SHAPE_USER_PREFS_DEFAULTS,
    },
  });
});

router.patch('/', (req, res) => {
  try {
    const patch = req.body;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return res.status(400).json({ error: 'Request body must be a JSON object' });
    }

    const current = configManager.getAll();
    const merged = deepMerge(current as unknown as Record<string, unknown>, patch);
    const parseResult = UserConfigSchema.safeParse(merged);

    if (!parseResult.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }

    // Check for sensitive keys in patch
    const warnings: string[] = [];
    const patchKeys = flattenKeys(patch);
    logger.debug(`[Config] Patched: ${Object.keys(patch).join(', ')}`);
    for (const key of patchKeys) {
      if (SENSITIVE_CONFIG_KEYS.includes(key as (typeof SENSITIVE_CONFIG_KEYS)[number])) {
        const warning = `'${key}' contains sensitive data. Consider using environment variables instead.`;
        warnings.push(warning);
        logger.warn(`[Config] ${warning}`);
      }
    }

    // Apply each top-level key from the validated result
    const validated = parseResult.data;
    for (const [key] of Object.entries(patch)) {
      if (key in validated) {
        type ConfigKey = keyof typeof validated;
        const configKey = key as ConfigKey;
        configManager.set(configKey, validated[configKey]);
      }
    }

    return res.json({
      success: true,
      config: configManager.getAll(),
      ...(warnings.length > 0 && { warnings }),
    });
  } catch (err) {
    logger.error('[Config] PATCH failed', logError(err));
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/** PUT /api/config/agents/defaultAgent — set the default agent by name. */
router.put('/agents/defaultAgent', (req, res) => {
  try {
    const { value } = req.body ?? {};
    if (typeof value !== 'string' || !value.trim()) {
      return res.status(400).json({ error: 'Body must include a non-empty "value" string' });
    }

    const agents = configManager.get('agents') ?? {
      defaultDirectory: '~/.dork/agents',
      defaultAgent: 'dorkbot',
    };
    configManager.set('agents', { ...agents, defaultAgent: value.trim() });
    logger.debug(`[Config] Default agent set to "${value.trim()}"`);

    return res.json({ success: true, defaultAgent: value.trim() });
  } catch (err) {
    logger.error('[Config] PUT agents/defaultAgent failed', logError(err));
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/config/mcp/rotate-token — regenerate the per-instance local MCP
 * token (DOR-278).
 *
 * Only applies in login-off mode with no `MCP_API_KEY` override — those are the
 * only conditions under which the local token gates the surface. When an env
 * override is set or login is on, the local token does not apply, so this 409s
 * rather than silently minting a token that nothing would honor. On success it
 * writes a fresh `0600` token, refreshes the cached value the middleware and the
 * config DTO read, and returns it so the settings tab can show the new value.
 * Rotating invalidates every previously configured client until it re-pastes.
 */
router.post('/mcp/rotate-token', (_req, res) => {
  try {
    if (env.MCP_API_KEY?.trim()) {
      return res.status(409).json({
        error:
          'The local MCP token does not apply while MCP_API_KEY is set — that environment variable is the bearer clients use.',
      });
    }
    if (configManager.get('auth')?.enabled === true) {
      return res.status(409).json({
        error:
          'The local MCP token does not apply while login is on — clients authenticate with their personal API keys.',
      });
    }

    const dorkHome = resolveDorkHome();
    const localToken = rotateMcpLocalToken(dorkHome);
    return res.json({ localToken });
  } catch (err) {
    logger.error('[Config] POST mcp/rotate-token failed', logError(err));
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/config/mcp/reveal-token — return the per-instance local MCP token
 * (DOR-278).
 *
 * The token deliberately does not ride `GET /api/config`: a POST-only reveal
 * never lands in GET caches or logs, and the settings tab fetches it on demand
 * instead of every config read carrying the secret. Same applicability rules as
 * rotate: 409 when an `MCP_API_KEY` override is set or login is on (the local
 * token does not apply there).
 *
 * Honest scope note: in login-off mode this endpoint sits behind the same
 * loopback trust boundary as the cockpit, so any local process with socket
 * reach can call it just as the settings tab does — the cockpit and a local
 * process are indistinguishable without login. The reveal endpoint therefore
 * does not (and cannot) make the token unreadable to local callers; turning on
 * login is the boundary that does.
 */
router.post('/mcp/reveal-token', (_req, res) => {
  try {
    if (env.MCP_API_KEY?.trim()) {
      return res.status(409).json({
        error:
          'The local MCP token does not apply while MCP_API_KEY is set — that environment variable is the bearer clients use.',
      });
    }
    if (configManager.get('auth')?.enabled === true) {
      return res.status(409).json({
        error:
          'The local MCP token does not apply while login is on — clients authenticate with their personal API keys.',
      });
    }

    const localToken = getMcpLocalToken();
    if (!localToken) {
      return res.status(404).json({
        error:
          'No local MCP token has been generated for this instance. Restart DorkOS to generate one.',
      });
    }
    return res.json({ localToken });
  } catch (err) {
    logger.error('[Config] POST mcp/reveal-token failed', logError(err));
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
