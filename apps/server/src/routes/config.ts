import { Router } from 'express';
import { tunnelManager } from '../services/core/tunnel-manager.js';
import { resolveClaudeCliPath } from '../services/runtimes/claude-code/sdk-utils.js';
import { configManager } from '../services/core/config-manager.js';
import { env } from '../env.js';
import { UserConfigSchema, SENSITIVE_CONFIG_KEYS } from '@dorkos/shared/config-schema';
import { getLatestVersion } from '../services/core/update-checker.js';
import { isTasksEnabled, getTasksInitError } from '../services/tasks/task-state.js';
import { isRelayEnabled, getRelayInitError } from '../services/relay/relay-state.js';
import { getMeshInitError } from '../services/mesh/mesh-state.js';
import { getBoundary } from '../lib/boundary.js';
import { SERVER_VERSION, IS_DEV_BUILD } from '../lib/version.js';
import { logger, logError } from '../lib/logger.js';

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
    onboarding: configManager.get('onboarding') ?? {
      completedSteps: [],
      skippedSteps: [],
      startedAt: null,
      dismissedAt: null,
    },
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
      const mcpApiKeyFromEnv = env.MCP_API_KEY ?? null;
      const mcpApiKeyFromConfig = mcpConfig?.apiKey ?? null;
      const effectiveApiKey = mcpApiKeyFromEnv ?? mcpApiKeyFromConfig;
      return {
        enabled: mcpConfig?.enabled ?? true,
        authConfigured: !!effectiveApiKey,
        authSource: mcpApiKeyFromEnv ? 'env' : mcpApiKeyFromConfig ? 'config' : 'none',
        endpoint: `http://localhost:${env.DORKOS_PORT}/mcp`,
        rateLimit: mcpConfig?.rateLimit ?? { enabled: true, maxPerWindow: 60, windowSecs: 60 },
      };
    })(),
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
 * Generate a new MCP API key, persist it to config, and return it in plaintext.
 * This is the only endpoint that returns the raw key — all subsequent reads
 * return authConfigured: true but never expose the key value.
 */
router.post('/mcp/generate-key', (_req, res) => {
  try {
    const raw = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('hex');
    const newKey = `dork_${raw}`;

    const current = configManager.get('mcp') ?? {
      enabled: true,
      apiKey: null,
      rateLimit: { enabled: true, maxPerWindow: 60, windowSecs: 60 },
    };
    configManager.set('mcp', { ...current, apiKey: newKey });
    logger.info('[Config] MCP API key generated');

    return res.status(201).json({ apiKey: newKey });
  } catch (err) {
    logger.error('[Config] Failed to generate MCP API key', logError(err));
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Remove the config-stored MCP API key.
 * Does not affect the MCP_API_KEY environment variable override.
 */
router.delete('/mcp/api-key', (_req, res) => {
  try {
    const current = configManager.get('mcp') ?? {
      enabled: true,
      apiKey: null,
      rateLimit: { enabled: true, maxPerWindow: 60, windowSecs: 60 },
    };
    configManager.set('mcp', { ...current, apiKey: null });
    logger.info('[Config] MCP API key removed');
    return res.json({ success: true });
  } catch (err) {
    logger.error('[Config] Failed to remove MCP API key', logError(err));
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
