import { Router } from 'express';
import { createRequire } from 'module';
import { tunnelManager } from '../services/tunnel-manager.js';
import { resolveClaudeCliPath } from '../services/agent-manager.js';
import { DEFAULT_PORT } from '@dorkos/shared/constants';
import { configManager } from '../services/config-manager.js';
import { UserConfigSchema, SENSITIVE_CONFIG_KEYS } from '@dorkos/shared/config-schema';

const require = createRequire(import.meta.url);
const { version: SERVER_VERSION } = require('../../package.json') as { version: string };

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

router.get('/', (_req, res) => {
  let claudeCliPath: string | null = null;
  try {
    claudeCliPath = resolveClaudeCliPath() ?? null;
  } catch {
    // CLI path resolution can fail — fallback to null
  }

  const tunnel = tunnelManager.status;

  res.json({
    version: SERVER_VERSION,
    port: parseInt(process.env.DORKOS_PORT || String(DEFAULT_PORT), 10),
    uptime: process.uptime(),
    workingDirectory: process.cwd(),
    nodeVersion: process.version,
    claudeCliPath,
    tunnel: {
      enabled: tunnel.enabled,
      connected: tunnel.connected,
      url: tunnel.url,
      authEnabled: !!process.env.TUNNEL_AUTH,
      tokenConfigured: !!process.env.NGROK_AUTHTOKEN,
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
