# Task Breakdown: DorkOS Configuration File System
Generated: 2026-02-16
Source: specs/dorkos-config-file-system/02-specification.md
Last Decompose: 2026-02-16

## Overview

Add a persistent user configuration file at `~/.dork/config.json` that integrates with the CLI, server, and client. Managed via CLI commands (`dorkos config get/set/list/reset/edit/path/validate`), an interactive setup wizard (`dorkos init`), and a server PATCH endpoint. Precedence: CLI flags > env vars > config.json > defaults.

## Phase 1: Core Config System

### Task 1.1: Create UserConfigSchema in shared package

**Description**: Create the Zod schema, types, defaults, and sensitive keys list for user configuration.
**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: None (foundation)

**Files to create/modify**:
- Create `packages/shared/src/config-schema.ts`
- Modify `packages/shared/package.json` (add export entry)

**Implementation**:

Create `packages/shared/src/config-schema.ts`:

```typescript
import { z } from 'zod';

/** Sensitive fields that trigger a warning when set via CLI or API */
export const SENSITIVE_CONFIG_KEYS = ['tunnel.authtoken', 'tunnel.auth'] as const;

export const UserConfigSchema = z.object({
  version: z.literal(1),
  server: z.object({
    port: z.number().int().min(1024).max(65535).default(4242),
    cwd: z.string().nullable().default(null),
  }).default({}),
  tunnel: z.object({
    enabled: z.boolean().default(false),
    domain: z.string().nullable().default(null),
    authtoken: z.string().nullable().default(null),
    auth: z.string().nullable().default(null),
  }).default({}),
  ui: z.object({
    theme: z.enum(['light', 'dark', 'system']).default('system'),
  }).default({}),
});

export type UserConfig = z.infer<typeof UserConfigSchema>;

/** Defaults extracted from schema for conf constructor */
export const USER_CONFIG_DEFAULTS: UserConfig = UserConfigSchema.parse({ version: 1 });
```

Add export entry to `packages/shared/package.json` in the `"exports"` map:

```json
"./config-schema": {
  "types": "./src/config-schema.ts",
  "default": "./dist/config-schema.js"
}
```

**Acceptance Criteria**:
- [ ] `UserConfigSchema` parses minimal input (`{ version: 1 }`) with all defaults filled
- [ ] `UserConfigSchema` rejects invalid port (< 1024, > 65535, non-integer)
- [ ] `UserConfigSchema` rejects invalid theme value
- [ ] `UserConfigSchema` accepts null for nullable fields (cwd, domain, authtoken, auth)
- [ ] `z.toJSONSchema()` produces valid JSON Schema from `UserConfigSchema`
- [ ] `SENSITIVE_CONFIG_KEYS` contains `'tunnel.authtoken'` and `'tunnel.auth'`
- [ ] `USER_CONFIG_DEFAULTS` matches schema defaults (port=4242, theme='system', etc.)
- [ ] `packages/shared/package.json` exports `./config-schema` entry
- [ ] TypeScript compiles without errors

### Task 1.2: Write config schema tests

**Description**: Create comprehensive tests for the UserConfigSchema, types, and defaults.
**Size**: Small
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: Task 1.3 (after 1.1 is done)

**Files to create**:
- Create `packages/shared/src/__tests__/config-schema.test.ts`

**Implementation**:

```typescript
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  UserConfigSchema,
  USER_CONFIG_DEFAULTS,
  SENSITIVE_CONFIG_KEYS,
} from '../config-schema';
import type { UserConfig } from '../config-schema';

describe('UserConfigSchema', () => {
  it('parses minimal input with defaults filled', () => {
    const result = UserConfigSchema.parse({ version: 1 });
    expect(result).toEqual({
      version: 1,
      server: { port: 4242, cwd: null },
      tunnel: { enabled: false, domain: null, authtoken: null, auth: null },
      ui: { theme: 'system' },
    });
  });

  it('rejects invalid port below 1024', () => {
    expect(() =>
      UserConfigSchema.parse({ version: 1, server: { port: 80 } })
    ).toThrow();
  });

  it('rejects invalid port above 65535', () => {
    expect(() =>
      UserConfigSchema.parse({ version: 1, server: { port: 70000 } })
    ).toThrow();
  });

  it('rejects non-integer port', () => {
    expect(() =>
      UserConfigSchema.parse({ version: 1, server: { port: 4242.5 } })
    ).toThrow();
  });

  it('rejects invalid theme value', () => {
    expect(() =>
      UserConfigSchema.parse({ version: 1, ui: { theme: 'blue' } })
    ).toThrow();
  });

  it('accepts null for nullable fields', () => {
    const result = UserConfigSchema.parse({
      version: 1,
      server: { cwd: null },
      tunnel: { domain: null, authtoken: null, auth: null },
    });
    expect(result.server.cwd).toBeNull();
    expect(result.tunnel.domain).toBeNull();
    expect(result.tunnel.authtoken).toBeNull();
    expect(result.tunnel.auth).toBeNull();
  });

  it('produces valid JSON Schema via z.toJSONSchema()', () => {
    const jsonSchema = z.toJSONSchema(UserConfigSchema, { target: 'draft-2020-12' });
    expect(jsonSchema).toBeDefined();
    expect(jsonSchema.type).toBe('object');
    expect(jsonSchema.properties).toBeDefined();
  });
});

describe('SENSITIVE_CONFIG_KEYS', () => {
  it('contains expected sensitive keys', () => {
    expect(SENSITIVE_CONFIG_KEYS).toContain('tunnel.authtoken');
    expect(SENSITIVE_CONFIG_KEYS).toContain('tunnel.auth');
  });
});

describe('USER_CONFIG_DEFAULTS', () => {
  it('matches schema defaults', () => {
    expect(USER_CONFIG_DEFAULTS).toEqual({
      version: 1,
      server: { port: 4242, cwd: null },
      tunnel: { enabled: false, domain: null, authtoken: null, auth: null },
      ui: { theme: 'system' },
    });
  });

  it('satisfies UserConfig type', () => {
    const config: UserConfig = USER_CONFIG_DEFAULTS;
    expect(config.version).toBe(1);
  });
});
```

**Acceptance Criteria**:
- [ ] All 10 test cases pass
- [ ] Tests cover schema parsing, validation errors, defaults, sensitive keys, and JSON Schema generation
- [ ] Run with: `npx vitest run packages/shared/src/__tests__/config-schema.test.ts`

### Task 1.3: Install conf dependency and create ConfigManager service

**Description**: Install the `conf` package in `packages/cli` and `apps/server`, then create the ConfigManager service with typed get/set/validate/reset methods, singleton pattern with lazy init, and corrupt config recovery.
**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: Task 1.2 (after 1.1 is done)

**Files to create/modify**:
- Run `npm install conf@^15.1.0 -w packages/cli -w apps/server`
- Create `apps/server/src/services/config-manager.ts`

**Implementation**:

Install dependency:
```bash
npm install conf@^15.1.0 -w packages/cli -w apps/server
```

Create `apps/server/src/services/config-manager.ts`:

```typescript
import Conf from 'conf';
import { z } from 'zod';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { UserConfigSchema, USER_CONFIG_DEFAULTS, SENSITIVE_CONFIG_KEYS } from '@dorkos/shared/config-schema';
import type { UserConfig } from '@dorkos/shared/config-schema';

const jsonSchema = z.toJSONSchema(UserConfigSchema, { target: 'draft-2020-12' });

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
    const configDir = dorkHome ?? process.env.DORK_HOME ?? path.join(os.homedir(), '.dork');

    // Detect first run before conf creates the file
    const configPath = path.join(configDir, 'config.json');
    this._isFirstRun = !fs.existsSync(configPath);

    try {
      this.store = new Conf<UserConfig>({
        configName: 'config',
        cwd: configDir,
        schema: jsonSchema as any,
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
      // Corrupt config: back up and recreate
      if (fs.existsSync(configPath)) {
        const backupPath = configPath + '.bak';
        fs.copyFileSync(configPath, backupPath);
        fs.unlinkSync(configPath);
        console.warn(`Warning: Corrupt config backed up to ${backupPath}`);
        console.warn('   Creating fresh config with defaults.\n');
      }
      this.store = new Conf<UserConfig>({
        configName: 'config',
        cwd: configDir,
        schema: jsonSchema as any,
        defaults: USER_CONFIG_DEFAULTS,
        clearInvalidConfig: false,
      });
    }
  }

  /** Whether this is the first time the config file has been created */
  get isFirstRun(): boolean { return this._isFirstRun; }

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
          errors: error.issues.map(i => `${i.path.join('.')}: ${i.message}`),
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
```

**Acceptance Criteria**:
- [ ] `conf` installed in both `packages/cli` and `apps/server`
- [ ] `initConfigManager()` creates a ConfigManager instance
- [ ] `get()` returns default values for unset keys
- [ ] `set()`/`getDot()` correctly stores and retrieves nested values
- [ ] `setDot()` on sensitive key returns warning string
- [ ] `reset()` restores individual key to default
- [ ] `reset()` with no args restores all defaults
- [ ] `validate()` returns `{ valid: true }` for valid config
- [ ] `validate()` returns errors for invalid config
- [ ] `isFirstRun` is true when config file does not exist
- [ ] `isFirstRun` is false when config file exists
- [ ] Corrupt config: backs up file to `.bak` and recreates defaults
- [ ] `path` returns expected file path
- [ ] TypeScript compiles without errors

### Task 1.4: Write ConfigManager service tests

**Description**: Create comprehensive tests for the ConfigManager service using a temp directory for isolation.
**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.3
**Can run parallel with**: None

**Files to create**:
- Create `apps/server/src/services/__tests__/config-manager.test.ts`

**Implementation**:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initConfigManager } from '../config-manager';

// Use real temp directories for integration tests with conf
function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-config-test-'));
}

function cleanupTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('ConfigManager', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it('initConfigManager() creates a ConfigManager instance', () => {
    const manager = initConfigManager(tmpDir);
    expect(manager).toBeDefined();
    expect(manager.path).toContain('config.json');
  });

  it('isFirstRun is true when config file does not exist', () => {
    const manager = initConfigManager(tmpDir);
    expect(manager.isFirstRun).toBe(true);
  });

  it('isFirstRun is false when config file already exists', () => {
    // First init creates the file
    initConfigManager(tmpDir);
    // Second init detects existing file
    const manager = initConfigManager(tmpDir);
    expect(manager.isFirstRun).toBe(false);
  });

  it('get() returns default values for unset keys', () => {
    const manager = initConfigManager(tmpDir);
    const server = manager.get('server');
    expect(server.port).toBe(4242);
    expect(server.cwd).toBeNull();
  });

  it('getDot() retrieves nested values', () => {
    const manager = initConfigManager(tmpDir);
    expect(manager.getDot('server.port')).toBe(4242);
    expect(manager.getDot('ui.theme')).toBe('system');
  });

  it('setDot() stores and retrieves nested values', () => {
    const manager = initConfigManager(tmpDir);
    manager.setDot('server.port', 5000);
    expect(manager.getDot('server.port')).toBe(5000);
  });

  it('setDot() on sensitive key returns warning string', () => {
    const manager = initConfigManager(tmpDir);
    const result = manager.setDot('tunnel.authtoken', 'my-token');
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain('sensitive data');
  });

  it('setDot() on non-sensitive key returns no warning', () => {
    const manager = initConfigManager(tmpDir);
    const result = manager.setDot('server.port', 5000);
    expect(result.warning).toBeUndefined();
  });

  it('reset() restores individual key to default', () => {
    const manager = initConfigManager(tmpDir);
    manager.setDot('server.port', 9999);
    expect(manager.getDot('server.port')).toBe(9999);
    manager.reset('server.port');
    expect(manager.getDot('server.port')).toBe(4242);
  });

  it('reset() with no args restores all defaults', () => {
    const manager = initConfigManager(tmpDir);
    manager.setDot('server.port', 9999);
    manager.setDot('ui.theme', 'dark');
    manager.reset();
    expect(manager.getDot('server.port')).toBe(4242);
    expect(manager.getDot('ui.theme')).toBe('system');
  });

  it('validate() returns { valid: true } for valid config', () => {
    const manager = initConfigManager(tmpDir);
    const result = manager.validate();
    expect(result.valid).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it('getAll() returns the full config object', () => {
    const manager = initConfigManager(tmpDir);
    const config = manager.getAll();
    expect(config.version).toBe(1);
    expect(config.server).toBeDefined();
    expect(config.tunnel).toBeDefined();
    expect(config.ui).toBeDefined();
  });

  it('path returns expected file path', () => {
    const manager = initConfigManager(tmpDir);
    expect(manager.path).toBe(path.join(tmpDir, 'config.json'));
  });

  it('corrupt config: backs up file and recreates defaults', () => {
    // Write corrupt JSON to the config path
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, '{ invalid json !!!');

    const manager = initConfigManager(tmpDir);

    // Backup should exist
    expect(fs.existsSync(configPath + '.bak')).toBe(true);

    // Fresh config should have defaults
    expect(manager.getDot('server.port')).toBe(4242);
  });
});
```

**Notes on mocking**:
- Uses real temp directories via `os.tmpdir()` for integration tests with `conf`
- Each test gets a fresh temp dir via `beforeEach`/`afterEach`
- Corrupt config test writes invalid JSON to simulate corruption

**Acceptance Criteria**:
- [ ] All 13 test cases pass
- [ ] Tests cover: init, first run detection, get/set, dot-path access, sensitive keys, reset, validate, corrupt config recovery, path
- [ ] Tests use real temp directories (no mocking of `conf`)
- [ ] Run with: `npx vitest run apps/server/src/services/__tests__/config-manager.test.ts`

## Phase 2: CLI Integration

### Task 2.1: Create config CLI command handlers

**Description**: Create the config subcommand handlers module with all 8 commands: default (pretty-print), get, set, list, reset, edit, path, validate.
**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.3
**Can run parallel with**: Task 2.3

**Files to create**:
- Create `packages/cli/src/config-commands.ts`

**Implementation**:

```typescript
import { configManager } from '../../apps/server/src/services/config-manager.js';
import { USER_CONFIG_DEFAULTS, SENSITIVE_CONFIG_KEYS } from '@dorkos/shared/config-schema';
import { execFile } from 'child_process';
import path from 'path';

/**
 * Parse a CLI string value into the appropriate JS type.
 * - "true"/"false" -> boolean
 * - Numeric strings -> number
 * - "null" -> null
 * - Everything else -> string
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
 * Flatten a nested config object into dot-path entries.
 * e.g., { server: { port: 4242 } } -> [['server.port', 4242]]
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
 * Get the default value for a dot-path key from USER_CONFIG_DEFAULTS.
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

/** dorkos config - Pretty-print all effective settings with source indicators */
export function handleConfigDefault(): void {
  const config = configManager.getAll();
  const entries = flattenConfig(config as unknown as Record<string, unknown>);

  console.log(`DorkOS Configuration (${configManager.path})\n`);

  for (const [key, value] of entries) {
    if (key === 'version') continue; // Skip version field in display
    const defaultVal = getDefault(key);
    const source = JSON.stringify(value) === JSON.stringify(defaultVal) ? '(default)' : '(config)';
    const displayValue = value === null ? '\u2014' : String(value);
    console.log(`  ${key.padEnd(20)} ${displayValue.padEnd(14)} ${source}`);
  }

  console.log(`\nConfig file: ${configManager.path}`);
}

/** dorkos config get <key> - Print single value */
export function handleConfigGet(key: string): void {
  const value = configManager.getDot(key);
  if (value === undefined) {
    console.error(`Unknown config key: ${key}`);
    process.exit(1);
  }
  console.log(value === null ? 'null' : String(value));
}

/** dorkos config set <key> <value> - Set value with type parsing */
export function handleConfigSet(key: string, rawValue: string): void {
  const value = parseConfigValue(rawValue);
  const result = configManager.setDot(key, value);

  if (result.warning) {
    console.warn(`Warning: ${result.warning}`);
  }

  console.log(`Set ${key} = ${value === null ? 'null' : String(value)}`);
}

/** dorkos config list - Print raw JSON (machine-readable) */
export function handleConfigList(): void {
  console.log(JSON.stringify(configManager.getAll(), null, 2));
}

/** dorkos config reset [key] - Reset to defaults */
export function handleConfigReset(key?: string): void {
  if (key) {
    configManager.reset(key);
    const defaultVal = getDefault(key);
    console.log(`Reset ${key} to default (${defaultVal === null ? 'null' : String(defaultVal)})`);
  } else {
    configManager.reset();
    console.log('Reset all settings to defaults');
  }
}

/** dorkos config edit - Open config in $EDITOR */
export function handleConfigEdit(): void {
  const editor = process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'nano');
  try {
    const { execFileSync } = require('child_process');
    execFileSync(editor, [configManager.path], { stdio: 'inherit' });
  } catch {
    console.error(`Failed to open editor: ${editor}`);
    console.error(`Set $EDITOR or ensure ${editor} is installed.`);
    process.exit(1);
  }
}

/** dorkos config path - Print absolute config file path */
export function handleConfigPath(): void {
  console.log(configManager.path);
}

/** dorkos config validate - Validate config and exit with appropriate code */
export function handleConfigValidate(): void {
  const result = configManager.validate();
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
 * Route a `dorkos config [subcommand] [args...]` invocation.
 *
 * @param args - Positional arguments after `config`
 */
export function handleConfigCommand(args: string[]): void {
  const subcommand = args[0];

  switch (subcommand) {
    case undefined:
      handleConfigDefault();
      break;
    case 'get':
      if (!args[1]) {
        console.error('Usage: dorkos config get <key>');
        process.exit(1);
      }
      handleConfigGet(args[1]);
      break;
    case 'set':
      if (!args[1] || !args[2]) {
        console.error('Usage: dorkos config set <key> <value>');
        process.exit(1);
      }
      handleConfigSet(args[1], args[2]);
      break;
    case 'list':
      handleConfigList();
      break;
    case 'reset':
      handleConfigReset(args[1]);
      break;
    case 'edit':
      handleConfigEdit();
      break;
    case 'path':
      handleConfigPath();
      break;
    case 'validate':
      handleConfigValidate();
      break;
    default:
      console.error(`Unknown config subcommand: ${subcommand}`);
      console.error('Available: get, set, list, reset, edit, path, validate');
      process.exit(1);
  }
}
```

**Note on imports**: The import from `../../apps/server/src/services/config-manager.js` will need adjustment based on how esbuild bundles the CLI. The implementer should verify the import path works in the bundled CLI context.

**Acceptance Criteria**:
- [ ] All 8 config subcommands implemented (default, get, set, list, reset, edit, path, validate)
- [ ] `parseConfigValue()` correctly converts types
- [ ] `handleConfigSet()` warns on sensitive keys
- [ ] `handleConfigValidate()` exits 0 for valid, 1 for invalid
- [ ] `handleConfigCommand()` routes all subcommands correctly
- [ ] Unknown subcommands print error and available options

### Task 2.2: Integrate config into CLI entry point

**Description**: Modify `packages/cli/src/cli.ts` to support `config` and `init` subcommands, initialize configManager, implement precedence merge, and print first-run message.
**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.3, Task 2.1
**Can run parallel with**: None

**Files to modify**:
- Modify `packages/cli/src/cli.ts`

**Changes**:

1. Enable `allowPositionals: true` in `parseArgs` to capture subcommands
2. After creating `~/.dork/` and setting `DORK_HOME`, check for `config` or `init` subcommands
3. For `config`: import and call `handleConfigCommand(positionalArgs.slice(1))` then exit
4. For `init`: import and call `runInitWizard(flags)` then exit
5. Initialize `configManager` via `initConfigManager()`
6. Implement precedence merge: only set `process.env.*` from config if not already set by CLI flags or env vars

Key code changes:

```typescript
// Enable positional args for subcommands
const { values, positionals } = parseArgs({
  options: {
    port: { type: 'string', short: 'p' },
    tunnel: { type: 'boolean', short: 't', default: false },
    dir: { type: 'string', short: 'd' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
    yes: { type: 'boolean', short: 'y', default: false },
  },
  allowPositionals: true,
});

// ... after creating DORK_HOME ...

// Handle subcommands before server import
const subcommand = positionals[0];

if (subcommand === 'config') {
  const { initConfigManager } = await import('../server/services/config-manager.js');
  initConfigManager(DORK_HOME);
  const { handleConfigCommand } = await import('./config-commands.js');
  handleConfigCommand(positionals.slice(1));
  process.exit(0);
}

if (subcommand === 'init') {
  const { runInitWizard } = await import('./init-wizard.js');
  await runInitWizard({ yes: values.yes!, dorkHome: DORK_HOME });
  process.exit(0);
}

// Normal startup: init config, apply precedence merge
const { initConfigManager } = await import('../server/services/config-manager.js');
const cfgMgr = initConfigManager(DORK_HOME);

// Precedence: CLI flags > env vars > config > defaults
const cliPort = values.port;
if (cliPort) {
  process.env.DORKOS_PORT = cliPort;
} else if (!process.env.DORKOS_PORT) {
  const configPort = cfgMgr.getDot('server.port');
  if (configPort) process.env.DORKOS_PORT = String(configPort);
  else process.env.DORKOS_PORT = String(DEFAULT_PORT);
}

// ... similar for tunnel, dir, authtoken, domain, auth ...

if (cfgMgr.isFirstRun) {
  console.log(`Created config at ${cfgMgr.path}`);
}
```

Update `--help` output to include subcommands and config file reference.

**Acceptance Criteria**:
- [ ] `dorkos config get server.port` works as standalone subcommand
- [ ] `dorkos init` routes to the init wizard
- [ ] Config values used as fallbacks when no CLI flag or env var set
- [ ] CLI flags override config values
- [ ] Env vars override config values
- [ ] First-run message printed when config created for first time
- [ ] `--help` output updated with subcommands and config file path
- [ ] `allowPositionals: true` enables subcommand parsing

### Task 2.3: Add conf to esbuild externals in CLI build

**Description**: Add `conf` to esbuild's external array in both the server bundle and CLI entry steps.
**Size**: Small
**Priority**: High
**Dependencies**: Task 1.3
**Can run parallel with**: Task 2.1

**Files to modify**:
- Modify `packages/cli/scripts/build.ts`

**Changes**:

In the server bundle step (step 2), add `'conf'` to the `external` array:

```typescript
external: [
  '@anthropic-ai/claude-agent-sdk',
  '@ngrok/ngrok',
  '@scalar/express-api-reference',
  '@asteasolutions/zod-to-openapi',
  'express',
  'cors',
  'dotenv',
  'gray-matter',
  'uuid',
  'zod',
  'conf',  // ADD
],
```

In the CLI entry step (step 3), add `'conf'` to the `external` array:

```typescript
external: ['dotenv', '../server/index.js', 'conf'],
```

**Acceptance Criteria**:
- [ ] `conf` listed in esbuild externals for server bundle (step 2)
- [ ] `conf` listed in esbuild externals for CLI entry (step 3)
- [ ] `npm run build -w packages/cli` succeeds without bundling `conf`

### Task 2.4: Write config CLI command tests

**Description**: Create tests for config command handlers, focusing on `parseConfigValue` and handler behaviors.
**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 2.1
**Can run parallel with**: Task 2.2

**Files to create**:
- Create `packages/cli/src/__tests__/config-commands.test.ts`

**Implementation**:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseConfigValue } from '../config-commands';

describe('parseConfigValue', () => {
  it('converts "true" to boolean true', () => {
    expect(parseConfigValue('true')).toBe(true);
  });

  it('converts "false" to boolean false', () => {
    expect(parseConfigValue('false')).toBe(false);
  });

  it('converts numeric strings to numbers', () => {
    expect(parseConfigValue('4242')).toBe(4242);
    expect(parseConfigValue('0')).toBe(0);
    expect(parseConfigValue('3.14')).toBe(3.14);
  });

  it('converts "null" to null', () => {
    expect(parseConfigValue('null')).toBeNull();
  });

  it('passes plain strings through unchanged', () => {
    expect(parseConfigValue('dark')).toBe('dark');
    expect(parseConfigValue('/Users/me')).toBe('/Users/me');
    expect(parseConfigValue('')).toBe('');
  });
});
```

**Note**: The mock paths for config-manager will need adjustment based on how the CLI imports the config manager. The implementer should adjust the `vi.mock()` path accordingly for handler tests.

**Acceptance Criteria**:
- [ ] `parseConfigValue()` converts "true"/"false" to boolean
- [ ] `parseConfigValue()` converts numeric strings to numbers
- [ ] `parseConfigValue()` converts "null" to null
- [ ] `parseConfigValue()` passes strings through unchanged
- [ ] Run with: `npx vitest run packages/cli/src/__tests__/config-commands.test.ts`

## Phase 3: Interactive Wizard

### Task 3.1: Install @inquirer/prompts and create init wizard

**Description**: Install `@inquirer/prompts`, add to esbuild externals, create interactive setup wizard for `dorkos init`.
**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 1.3, Task 2.3
**Can run parallel with**: None

**Files to create/modify**:
- Run `npm install @inquirer/prompts@^8.2.0 -w packages/cli`
- Modify `packages/cli/scripts/build.ts` (add `@inquirer/prompts` to externals)
- Create `packages/cli/src/init-wizard.ts`

**Install**:
```bash
npm install @inquirer/prompts@^8.2.0 -w packages/cli
```

**Add to esbuild externals** in `packages/cli/scripts/build.ts` (both steps):

Server bundle (step 2): add `'@inquirer/prompts'` to external array
CLI entry (step 3): `external: ['dotenv', '../server/index.js', 'conf', '@inquirer/prompts']`

**Create `packages/cli/src/init-wizard.ts`**:

```typescript
import { input, select, confirm } from '@inquirer/prompts';
import { initConfigManager } from '../../apps/server/src/services/config-manager.js';
import { USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';
import fs from 'fs';
import path from 'path';

interface InitOptions {
  yes: boolean;
  dorkHome: string;
}

/**
 * Run the interactive DorkOS setup wizard (`dorkos init`).
 *
 * Prompts the user for port, theme, tunnel, and working directory.
 * With `--yes`, skips all prompts and writes defaults silently.
 */
export async function runInitWizard(options: InitOptions): Promise<void> {
  const { yes, dorkHome } = options;
  const configPath = path.join(dorkHome, 'config.json');

  // --yes mode: write defaults silently
  if (yes) {
    const manager = initConfigManager(dorkHome);
    manager.reset(); // Ensure defaults are written
    console.log(`Config initialized with defaults at ${configPath}`);
    return;
  }

  // Check if config already exists
  if (fs.existsSync(configPath)) {
    const overwrite = await confirm({
      message: 'Config already exists. Overwrite?',
      default: false,
    });
    if (!overwrite) {
      console.log('Aborted.');
      return;
    }
  }

  console.log('\nDorkOS Setup\n');

  // Prompt for port
  const portStr = await input({
    message: 'Default port:',
    default: String(USER_CONFIG_DEFAULTS.server.port),
    validate: (val) => {
      const num = Number(val);
      if (isNaN(num) || !Number.isInteger(num) || num < 1024 || num > 65535) {
        return 'Port must be an integer between 1024 and 65535';
      }
      return true;
    },
  });

  // Prompt for theme
  const theme = await select({
    message: 'UI theme:',
    choices: [
      { value: 'system', name: 'system' },
      { value: 'light', name: 'light' },
      { value: 'dark', name: 'dark' },
    ],
    default: 'system',
  });

  // Prompt for tunnel
  const tunnelEnabled = await confirm({
    message: 'Enable tunnel by default?',
    default: false,
  });

  // Prompt for working directory
  const cwd = await input({
    message: 'Default working directory:',
    default: process.cwd(),
  });

  // Initialize config and write values
  const manager = initConfigManager(dorkHome);
  manager.reset(); // Start fresh
  manager.setDot('server.port', Number(portStr));
  manager.setDot('ui.theme', theme);
  manager.setDot('tunnel.enabled', tunnelEnabled);
  if (cwd !== process.cwd()) {
    manager.setDot('server.cwd', cwd);
  }

  console.log(`\nConfig saved to ${configPath}`);
}
```

**Acceptance Criteria**:
- [ ] `@inquirer/prompts` installed in `packages/cli`
- [ ] `@inquirer/prompts` added to esbuild externals
- [ ] `dorkos init` prompts for port, theme, tunnel, working directory
- [ ] `dorkos init --yes` skips prompts, writes defaults
- [ ] Existing config prompts for overwrite
- [ ] Port validation rejects values outside 1024-65535

### Task 3.2: Write init wizard tests

**Description**: Create tests for the init wizard by mocking `@inquirer/prompts`.
**Size**: Small
**Priority**: Medium
**Dependencies**: Task 3.1
**Can run parallel with**: None

**Files to create**:
- Create `packages/cli/src/__tests__/init-wizard.test.ts`

**Implementation**:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Mock @inquirer/prompts
vi.mock('@inquirer/prompts', () => ({
  input: vi.fn(),
  select: vi.fn(),
  confirm: vi.fn(),
}));

// Must import after mocks
import { input, select, confirm } from '@inquirer/prompts';
import { runInitWizard } from '../init-wizard';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-init-test-'));
}

function cleanupTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('runInitWizard', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it('--yes flag skips prompts and writes defaults', async () => {
    await runInitWizard({ yes: true, dorkHome: tmpDir });

    expect(input).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();

    const configPath = path.join(tmpDir, 'config.json');
    expect(fs.existsSync(configPath)).toBe(true);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.server.port).toBe(4242);
  });

  it('prompts for port, theme, tunnel, cwd in order', async () => {
    vi.mocked(input).mockResolvedValueOnce('5000');
    vi.mocked(select).mockResolvedValueOnce('dark');
    vi.mocked(confirm).mockResolvedValueOnce(false);
    vi.mocked(input).mockResolvedValueOnce('/Users/me/projects');

    await runInitWizard({ yes: false, dorkHome: tmpDir });

    expect(input).toHaveBeenCalledTimes(2);
    expect(select).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('writes user choices to config', async () => {
    vi.mocked(input).mockResolvedValueOnce('8080');
    vi.mocked(select).mockResolvedValueOnce('light');
    vi.mocked(confirm).mockResolvedValueOnce(true);
    vi.mocked(input).mockResolvedValueOnce('/tmp/projects');

    await runInitWizard({ yes: false, dorkHome: tmpDir });

    const configPath = path.join(tmpDir, 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.server.port).toBe(8080);
    expect(config.ui.theme).toBe('light');
    expect(config.tunnel.enabled).toBe(true);
  });

  it('prompts for overwrite when config exists', async () => {
    fs.writeFileSync(path.join(tmpDir, 'config.json'), '{"version":1}');

    vi.mocked(confirm).mockResolvedValueOnce(false);

    await runInitWizard({ yes: false, dorkHome: tmpDir });

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('Overwrite') })
    );
  });
});
```

**Acceptance Criteria**:
- [ ] `--yes` test: no prompts called, defaults written
- [ ] Prompt order test: port, theme, tunnel, cwd called in correct order
- [ ] User choices written to config file
- [ ] Existing config triggers overwrite prompt
- [ ] Run with: `npx vitest run packages/cli/src/__tests__/init-wizard.test.ts`

## Phase 4: Server Endpoint

### Task 4.1: Add PATCH /api/config endpoint

**Description**: Add a PATCH handler to `apps/server/src/routes/config.ts` and call `initConfigManager()` in server startup.
**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 1.3
**Can run parallel with**: Phase 2, Phase 3

**Files to modify**:
- Modify `apps/server/src/routes/config.ts` (add PATCH handler)
- Modify `apps/server/src/index.ts` (call `initConfigManager()` at startup)

**Implementation for PATCH handler** - add to `apps/server/src/routes/config.ts`:

```typescript
import { configManager } from '../services/config-manager.js';
import { UserConfigSchema, SENSITIVE_CONFIG_KEYS } from '@dorkos/shared/config-schema';
import { z } from 'zod';

// NEW: PATCH /api/config
router.patch('/', (req, res) => {
  try {
    const patch = req.body;

    if (!patch || typeof patch !== 'object') {
      return res.status(400).json({ error: 'Request body must be a JSON object' });
    }

    const current = configManager.getAll();
    const merged = deepMerge(current, patch);

    const parseResult = UserConfigSchema.safeParse(merged);
    if (!parseResult.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: parseResult.error.issues.map(i => `${i.path.join('.')}: ${i.message}`),
      });
    }

    const warnings: string[] = [];
    const patchKeys = flattenKeys(patch);
    for (const key of patchKeys) {
      if (SENSITIVE_CONFIG_KEYS.includes(key as any)) {
        warnings.push(`'${key}' contains sensitive data. Consider using environment variables instead.`);
      }
    }

    for (const [key, value] of Object.entries(parseResult.data)) {
      configManager.set(key as keyof typeof parseResult.data, value as any);
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

function deepMerge(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] !== null && typeof source[key] === 'object' && !Array.isArray(source[key]) &&
      target[key] !== null && typeof target[key] === 'object' && !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

function flattenKeys(obj: Record<string, any>, prefix = ''): string[] {
  const keys: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      keys.push(...flattenKeys(value, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys;
}
```

**Changes to `apps/server/src/index.ts`**: Add `initConfigManager()` call at top of `start()`:

```typescript
import { initConfigManager } from './services/config-manager.js';

async function start() {
  initConfigManager();
  // ... rest of existing code
}
```

**Acceptance Criteria**:
- [ ] PATCH with valid partial returns 200 + merged config
- [ ] PATCH with invalid value returns 400 + Zod errors
- [ ] PATCH with sensitive key includes warning
- [ ] PATCH with empty body returns 200 (no-op)
- [ ] GET backward compatible
- [ ] `initConfigManager()` called in server startup

### Task 4.2: Add PATCH request/response schemas to shared schemas

**Description**: Add Zod schemas for PATCH request/response to `packages/shared/src/schemas.ts` for OpenAPI docs.
**Size**: Small
**Priority**: Low
**Dependencies**: Task 1.1
**Can run parallel with**: Task 4.1

**Files to modify**:
- Modify `packages/shared/src/schemas.ts`

**Add at end of file**:

```typescript
// === Config PATCH Schemas ===

export const ConfigPatchRequestSchema = z
  .object({
    server: z.object({
      port: z.number().int().min(1024).max(65535).optional(),
      cwd: z.string().nullable().optional(),
    }).optional(),
    tunnel: z.object({
      enabled: z.boolean().optional(),
      domain: z.string().nullable().optional(),
      authtoken: z.string().nullable().optional(),
      auth: z.string().nullable().optional(),
    }).optional(),
    ui: z.object({
      theme: z.enum(['light', 'dark', 'system']).optional(),
    }).optional(),
  })
  .openapi('ConfigPatchRequest');

export type ConfigPatchRequest = z.infer<typeof ConfigPatchRequestSchema>;

export const ConfigPatchResponseSchema = z
  .object({
    success: z.boolean(),
    config: z.object({
      version: z.literal(1),
      server: z.object({ port: z.number(), cwd: z.string().nullable() }),
      tunnel: z.object({
        enabled: z.boolean(),
        domain: z.string().nullable(),
        authtoken: z.string().nullable(),
        auth: z.string().nullable(),
      }),
      ui: z.object({ theme: z.enum(['light', 'dark', 'system']) }),
    }),
    warnings: z.array(z.string()).optional(),
  })
  .openapi('ConfigPatchResponse');

export type ConfigPatchResponse = z.infer<typeof ConfigPatchResponseSchema>;
```

**Acceptance Criteria**:
- [ ] `ConfigPatchRequestSchema` validates partial config patches
- [ ] `ConfigPatchResponseSchema` includes success, config, warnings
- [ ] Both have `.openapi()` metadata
- [ ] TypeScript compiles

### Task 4.3: Write PATCH /api/config endpoint tests

**Description**: Create tests for the PATCH endpoint.
**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 4.1
**Can run parallel with**: Task 4.2

**Files to create**:
- Create `apps/server/src/routes/__tests__/config.test.ts`

**Implementation**:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-config-route-test-'));
}

describe('PATCH /api/config', () => {
  let app: express.Express;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = createTempDir();
    process.env.DORK_HOME = tmpDir;

    const { initConfigManager } = await import('../../services/config-manager');
    initConfigManager(tmpDir);

    const configRouter = (await import('../config')).default;
    app = express();
    app.use(express.json());
    app.use('/api/config', configRouter);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it('returns 200 with merged config for valid partial update', async () => {
    const response = await request(app)
      .patch('/api/config')
      .send({ ui: { theme: 'dark' } })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.config.ui.theme).toBe('dark');
    expect(response.body.config.server.port).toBe(4242);
  });

  it('returns 400 with Zod errors for invalid value', async () => {
    const response = await request(app)
      .patch('/api/config')
      .send({ server: { port: 80 } })
      .expect(400);

    expect(response.body.error).toBe('Validation failed');
    expect(response.body.details).toBeDefined();
    expect(response.body.details.length).toBeGreaterThan(0);
  });

  it('includes warning for sensitive key', async () => {
    const response = await request(app)
      .patch('/api/config')
      .send({ tunnel: { authtoken: 'my-token' } })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.warnings).toBeDefined();
    expect(response.body.warnings[0]).toContain('sensitive data');
  });

  it('returns 200 for empty body (no-op)', async () => {
    const response = await request(app)
      .patch('/api/config')
      .send({})
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.config.server.port).toBe(4242);
  });
});
```

**Acceptance Criteria**:
- [ ] Valid partial update returns 200
- [ ] Invalid value returns 400 with details
- [ ] Sensitive key includes warning
- [ ] Empty body returns 200
- [ ] Run with: `npx vitest run apps/server/src/routes/__tests__/config.test.ts`

## Phase 5: Documentation

### Task 5.1: Create configuration guide

**Description**: Create `guides/configuration.md` covering config file location, settings, precedence, CLI commands, wizard, schema versioning, security, and API endpoint.
**Size**: Medium
**Priority**: Low
**Dependencies**: Tasks 1.1, 2.1, 3.1, 4.1
**Can run parallel with**: Task 5.2

**Files to create**:
- Create `guides/configuration.md`

**Content**: Comprehensive guide covering:
- Config file location (`~/.dork/config.json`)
- Available settings table with types and defaults
- Precedence order (CLI flags > env vars > config > defaults)
- CLI commands with examples (config get/set/list/reset/edit/path/validate)
- Interactive setup (`dorkos init`, `dorkos init --yes`)
- Schema versioning and migration
- Security best practices (tokens in env vars)
- PATCH /api/config endpoint reference

**Acceptance Criteria**:
- [ ] Guide covers all config topics
- [ ] All settings documented with types and defaults
- [ ] Examples included for common operations

### Task 5.2: Update CLAUDE.md, architecture.md, and api-reference.md

**Description**: Update existing documentation files to reflect the new config system.
**Size**: Small
**Priority**: Low
**Dependencies**: Tasks 1.1, 2.1, 4.1
**Can run parallel with**: Task 5.1

**Files to modify**:
- Modify `CLAUDE.md` (add config commands, config section, ConfigManager to services list)
- Modify `guides/architecture.md` (add ConfigManager service description)
- Modify `guides/api-reference.md` (add PATCH /api/config endpoint)

**CLAUDE.md**: Add `dorkos config` and `dorkos init` to Commands section. Add Configuration subsection. Add ConfigManager as tenth service.

**architecture.md**: Add ConfigManager to services section with description of responsibilities.

**api-reference.md**: Add PATCH /api/config endpoint with request/response schemas.

**Acceptance Criteria**:
- [ ] CLAUDE.md updated with config commands, config section, ConfigManager
- [ ] architecture.md updated with ConfigManager service
- [ ] api-reference.md updated with PATCH /api/config
- [ ] Documentation accurate and consistent with implementation

## Dependency Graph

```
Phase 1:
  1.1 (schema) --> 1.2 (schema tests)
               --> 1.3 (ConfigManager + install conf)
                     --> 1.4 (ConfigManager tests)
               --> 4.2 (PATCH schemas)

Phase 2 (depends on 1.3):
  2.1 (config commands) --> 2.2 (CLI integration, also needs 2.1)
                        --> 2.4 (command tests)
  2.3 (esbuild externals, depends on 1.3) --> 3.1 (wizard)

Phase 3 (depends on 1.3 + 2.3):
  3.1 (wizard) --> 3.2 (wizard tests)

Phase 4 (depends on 1.3):
  4.1 (PATCH endpoint) --> 4.3 (endpoint tests)
  4.2 (PATCH schemas, depends on 1.1)

Phase 5 (depends on all prior phases):
  5.1 (config guide)
  5.2 (doc updates)
```

## Parallel Execution Opportunities

- **After Task 1.1**: Tasks 1.2, 1.3, and 4.2 can run in parallel
- **After Task 1.3**: Tasks 2.1, 2.3, and 4.1 can run in parallel
- **After Task 2.1**: Tasks 2.2 and 2.4 can run in parallel
- **Phase 5**: Tasks 5.1 and 5.2 can run in parallel
