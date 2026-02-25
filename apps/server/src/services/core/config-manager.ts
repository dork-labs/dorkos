import Conf from 'conf';
import { z } from 'zod';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  UserConfigSchema,
  USER_CONFIG_DEFAULTS,
  SENSITIVE_CONFIG_KEYS,
} from '@dorkos/shared/config-schema';
import type { UserConfig } from '@dorkos/shared/config-schema';
import { logger } from '../../lib/logger.js';

const jsonSchemaFull = z.toJSONSchema(UserConfigSchema, {
  target: 'jsonSchema2019-09',
}) as { properties?: Record<string, unknown> };
const jsonSchemaProperties = jsonSchemaFull.properties ?? {};

/**
 * Manages persistent user configuration at ~/.dork/config.json.
 *
 * Uses `conf` for atomic JSON I/O with Ajv validation via the JSON Schema
 * generated from UserConfigSchema. Handles first-run detection, corrupt
 * config recovery (backup + recreate), and sensitive field warnings.
 */
class ConfigManager {
  private store: Conf<UserConfig>;
  private _isFirstRun = false;

  constructor(dorkHome?: string) {
    const configDir =
      dorkHome ?? process.env.DORK_HOME ?? path.join(os.homedir(), '.dork');
    const configPath = path.join(configDir, 'config.json');
    this._isFirstRun = !fs.existsSync(configPath);

    try {
      this.store = new Conf<UserConfig>({
        configName: 'config',
        cwd: configDir,
        schema: jsonSchemaProperties as any,
        defaults: USER_CONFIG_DEFAULTS,
        clearInvalidConfig: false,
        projectVersion: '1.0.0',
        migrations: {
          '1.0.0': (store) => {
            if (!store.has('version')) {
              store.set('version', 1);
            }
          },
        },
      });
    } catch (error) {
      if (fs.existsSync(configPath)) {
        const backupPath = configPath + '.bak';
        fs.copyFileSync(configPath, backupPath);
        fs.unlinkSync(configPath);
        logger.warn(`Corrupt config backed up to ${backupPath}`);
        logger.warn('Creating fresh config with defaults.');
      }
      this.store = new Conf<UserConfig>({
        configName: 'config',
        cwd: configDir,
        schema: jsonSchemaProperties as any,
        defaults: USER_CONFIG_DEFAULTS,
        clearInvalidConfig: false,
      });
    }
  }

  /** Whether this is the first time the config file has been created */
  get isFirstRun(): boolean {
    return this._isFirstRun;
  }

  /** Get a top-level config section */
  get<K extends keyof UserConfig>(key: K): UserConfig[K] {
    return this.store.get(key);
  }

  /** Get a nested value via dot-path (e.g., 'server.port') */
  getDot(key: string): unknown {
    return this.store.get(key as any);
  }

  /** Set a top-level config section */
  set<K extends keyof UserConfig>(key: K, value: UserConfig[K]): void {
    this.store.set(key, value);
  }

  /** Set a nested value via dot-path. Returns warning if key is sensitive. */
  setDot(key: string, value: unknown): { warning?: string } {
    const result: { warning?: string } = {};
    if (SENSITIVE_CONFIG_KEYS.includes(key as any)) {
      result.warning = `'${key}' contains sensitive data. Consider using environment variables instead.`;
    }
    this.store.set(key as any, value);
    return result;
  }

  /** Get the full config object */
  getAll(): UserConfig {
    return this.store.store;
  }

  /** Reset a specific key or all keys to defaults */
  reset(key?: string): void {
    if (key) {
      this.store.reset(key as any);
    } else {
      this.store.clear();
      this.store.set(USER_CONFIG_DEFAULTS);
    }
  }

  /** Validate the current config against the Zod schema */
  validate(): { valid: boolean; errors?: string[] } {
    try {
      UserConfigSchema.parse(this.store.store);
      return { valid: true };
    } catch (error) {
      if (error instanceof z.ZodError) {
        return {
          valid: false,
          errors: error.issues.map(
            (i) => `${i.path.join('.')}: ${i.message}`,
          ),
        };
      }
      throw error;
    }
  }

  /** Absolute path to the config file */
  get path(): string {
    return this.store.path;
  }
}

export let configManager: ConfigManager;

/** Initialize the config manager. Called once at startup. */
export function initConfigManager(dorkHome?: string): ConfigManager {
  configManager = new ConfigManager(dorkHome);
  return configManager;
}
