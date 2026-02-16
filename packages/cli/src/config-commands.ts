import { USER_CONFIG_DEFAULTS, SENSITIVE_CONFIG_KEYS } from '@dorkos/shared/config-schema';
import type { UserConfig } from '@dorkos/shared/config-schema';
import { execFileSync } from 'child_process';

/**
 * Minimal interface for config operations needed by CLI commands.
 *
 * Decouples CLI logic from ConfigManager implementation for testability.
 */
export interface ConfigStore {
  getAll(): UserConfig;
  getDot(key: string): unknown;
  setDot(key: string, value: unknown): { warning?: string };
  reset(key?: string): void;
  validate(): { valid: boolean; errors?: string[] };
  readonly path: string;
}

/**
 * Parse a CLI string value into the appropriate JavaScript type.
 *
 * @param value - Raw string from command line
 * @returns Parsed value (boolean, number, null, or string)
 */
export function parseConfigValue(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  const num = Number(value);
  if (!isNaN(num) && value.trim() !== '') return num;
  return value;
}

/**
 * Flatten nested config object into dot-path entries.
 *
 * @param obj - Config object to flatten
 * @param prefix - Current path prefix (used in recursion)
 * @returns Array of [key, value] tuples with dot-separated paths
 */
function flattenConfig(obj: Record<string, unknown>, prefix = ''): [string, unknown][] {
  const entries: [string, unknown][] = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      entries.push(...flattenConfig(value as Record<string, unknown>, fullKey));
    } else {
      entries.push([fullKey, value]);
    }
  }
  return entries;
}

/**
 * Get default value for a config key from schema defaults.
 *
 * @param key - Dot-separated config path (e.g., 'server.port')
 * @returns Default value or undefined if key doesn't exist
 */
function getDefault(key: string): unknown {
  const parts = key.split('.');
  let current: unknown = USER_CONFIG_DEFAULTS;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Show all effective settings (pretty-printed table).
 *
 * Displays each config value with source indicator (default or config file).
 */
export function handleConfigDefault(store: ConfigStore): void {
  const config = store.getAll();
  const entries = flattenConfig(config as unknown as Record<string, unknown>);
  console.log(`DorkOS Configuration (${store.path})\n`);
  for (const [key, value] of entries) {
    if (key === 'version') continue;
    const defaultVal = getDefault(key);
    const source = JSON.stringify(value) === JSON.stringify(defaultVal) ? '(default)' : '(config)';
    const displayValue = value === null ? '\u2014' : String(value);
    console.log(`  ${key.padEnd(20)} ${displayValue.padEnd(14)} ${source}`);
  }
  console.log(`\nConfig file: ${store.path}`);
}

/**
 * Get a single config value by dot-path.
 *
 * @param store - Config storage instance
 * @param key - Dot-separated config path (e.g., 'tunnel.enabled')
 */
export function handleConfigGet(store: ConfigStore, key: string): void {
  const value = store.getDot(key);
  if (value === undefined) {
    console.error(`Unknown config key: ${key}`);
    process.exit(1);
  }
  console.log(value === null ? 'null' : String(value));
}

/**
 * Set a single config value.
 *
 * @param store - Config storage instance
 * @param key - Dot-separated config path
 * @param rawValue - Raw string value from CLI (will be parsed)
 */
export function handleConfigSet(store: ConfigStore, key: string, rawValue: string): void {
  const value = parseConfigValue(rawValue);
  const result = store.setDot(key, value);
  if (result.warning) {
    console.warn(`\u26a0  ${result.warning}`);
  }
  console.log(`Set ${key} = ${value === null ? 'null' : String(value)}`);
}

/**
 * Output full config as JSON.
 *
 * Useful for scripting and debugging.
 */
export function handleConfigList(store: ConfigStore): void {
  console.log(JSON.stringify(store.getAll(), null, 2));
}

/**
 * Reset config to defaults (all or specific key).
 *
 * @param store - Config storage instance
 * @param key - Optional specific key to reset; omit to reset all
 */
export function handleConfigReset(store: ConfigStore, key?: string): void {
  if (key) {
    store.reset(key);
    const defaultVal = getDefault(key);
    console.log(`Reset ${key} to default (${defaultVal === null ? 'null' : String(defaultVal)})`);
  } else {
    store.reset();
    console.log('Reset all settings to defaults');
  }
}

/**
 * Open config file in $EDITOR.
 *
 * Falls back to platform defaults (notepad on Windows, nano elsewhere).
 */
export function handleConfigEdit(store: ConfigStore): void {
  const editor = process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'nano');
  try {
    execFileSync(editor, [store.path], { stdio: 'inherit' });
  } catch {
    console.error(`Failed to open editor: ${editor}`);
    console.error(`Set $EDITOR or ensure ${editor} is installed.`);
    process.exit(1);
  }
}

/**
 * Print config file path.
 *
 * Useful for locating the config file in scripts.
 */
export function handleConfigPath(store: ConfigStore): void {
  console.log(store.path);
}

/**
 * Validate config against schema.
 *
 * Exits with code 0 if valid, 1 if invalid.
 */
export function handleConfigValidate(store: ConfigStore): void {
  const result = store.validate();
  if (result.valid) {
    console.log('Config is valid');
    process.exit(0);
  } else {
    console.error('Config validation failed:');
    for (const err of result.errors ?? []) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }
}

/**
 * Route config subcommands to appropriate handlers.
 *
 * @param store - Config storage instance
 * @param args - Positional arguments after 'config' command
 */
export function handleConfigCommand(store: ConfigStore, args: string[]): void {
  const subcommand = args[0];
  switch (subcommand) {
    case undefined:
      handleConfigDefault(store);
      break;
    case 'get':
      if (!args[1]) {
        console.error('Usage: dorkos config get <key>');
        process.exit(1);
      }
      handleConfigGet(store, args[1]);
      break;
    case 'set':
      if (!args[1] || !args[2]) {
        console.error('Usage: dorkos config set <key> <value>');
        process.exit(1);
      }
      handleConfigSet(store, args[1], args[2]);
      break;
    case 'list':
      handleConfigList(store);
      break;
    case 'reset':
      handleConfigReset(store, args[1]);
      break;
    case 'edit':
      handleConfigEdit(store);
      break;
    case 'path':
      handleConfigPath(store);
      break;
    case 'validate':
      handleConfigValidate(store);
      break;
    default:
      console.error(`Unknown config subcommand: ${subcommand}`);
      console.error('Available: get, set, list, reset, edit, path, validate');
      process.exit(1);
  }
}
