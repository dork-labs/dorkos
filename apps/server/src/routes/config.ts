import { Router } from 'express';
import { createRequire } from 'module';
import { tunnelManager } from '../services/core/tunnel-manager.js';
import { resolveClaudeCliPath } from '../lib/sdk-utils.js';
import { configManager } from '../services/core/config-manager.js';
import { env } from '../env.js';
import { UserConfigSchema, SENSITIVE_CONFIG_KEYS } from '@dorkos/shared/config-schema';
import { getLatestVersion } from '../services/core/update-checker.js';
import { isPulseEnabled } from '../services/pulse/pulse-state.js';
import { isRelayEnabled } from '../services/relay/relay-state.js';
import { isMeshEnabled } from '../services/mesh/mesh-state.js';
import { getBoundary } from '../lib/boundary.js';

declare const __CLI_VERSION__: string | undefined;

// Use build-time injected version when bundled; fall back to root package.json in dev mode
let SERVER_VERSION: string;
if (typeof __CLI_VERSION__ !== 'undefined') {
  SERVER_VERSION = __CLI_VERSION__;
} else {
  const req = createRequire(import.meta.url);
  SERVER_VERSION = (req('../../package.json') as { version: string }).version;
}

const router = Router();

/**
 * Recursively merge source object into target.
 * Arrays are replaced (not merged). Null values from source override target.
 */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...target };

  for (const [key, sourceValue] of Object.entries(source)) {
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
    port: env.DORKOS_PORT,
    uptime: process.uptime(),
    workingDirectory: process.cwd(),
    boundary: getBoundary(),
    nodeVersion: process.version,
    claudeCliPath,
    tunnel: {
      enabled: tunnel.enabled,
      connected: tunnel.connected,
      url: tunnel.url,
      authEnabled: !!env.TUNNEL_AUTH,
      tokenConfigured: !!(env.NGROK_AUTHTOKEN || configManager.get('tunnel')?.authtoken),
    },
    pulse: {
      enabled: isPulseEnabled(),
    },
    relay: {
      enabled: isRelayEnabled(),
    },
    mesh: {
      enabled: isMeshEnabled(),
      scanRoots: configManager.get('mesh')?.scanRoots ?? [],
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
    for (const key of patchKeys) {
      if (SENSITIVE_CONFIG_KEYS.includes(key as (typeof SENSITIVE_CONFIG_KEYS)[number])) {
        warnings.push(`'${key}' contains sensitive data. Consider using environment variables instead.`);
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
  } catch (error) {
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
