---
slug: dorkos-config-file-system
---

# Specification: DorkOS Configuration File System

**Status:** Draft
**Author:** Claude Code
**Date:** 2026-02-16
**Ideation:** [01-ideation.md](./01-ideation.md)

---

## 1. Overview

Add a persistent user configuration file at `~/.dork/config.json` that integrates with the CLI, server, and client. Users can configure DorkOS settings (port, theme, tunnel, working directory) that persist across sessions. Configuration is managed via CLI commands (`dorkos config get/set/list/reset/edit/path/validate`), an interactive setup wizard (`dorkos init`), and a server PATCH endpoint for remote updates.

## 2. Background / Problem Statement

DorkOS currently has no persistent user configuration. All settings are either:
- Hardcoded defaults in `packages/shared/src/constants.ts`
- Environment variables read from `.env` or shell
- CLI flags passed on every invocation (`--port`, `--tunnel`, `--dir`)

This means users must re-specify settings every time they start DorkOS, or maintain a `.env` file (a developer-facing mechanism). The `~/.dork/` directory is already created on CLI startup but sits empty. Users who install DorkOS via `npm install -g dorkos` have no way to persist preferences.

## 3. Goals

- Persistent user configuration at `~/.dork/config.json` with silent first-run creation
- Clear precedence: CLI flags > env vars > config.json > defaults
- Full CLI management: `dorkos config get/set/list/reset/edit/path/validate`
- Interactive setup wizard: `dorkos init` (with `--yes` for CI)
- Server PATCH endpoint for remote config updates via tunnel
- Schema validation with graceful degradation (warn, don't crash)
- Schema versioning with migration support for future changes
- Comprehensive documentation

## 4. Non-Goals

- Per-project config files (`.dorkos.json` in project directories)
- Config encryption or secrets management
- Config sync across machines
- XDG-compliant directory paths (future v2.0 consideration)
- Full settings UI editor in the client (future enhancement)
- Migrating `.env` values into config.json (they remain independent systems)

## 5. Technical Dependencies

| Dependency | Version | Purpose | Package |
|------------|---------|---------|---------|
| `conf` | `^15.1.0` | Atomic JSON config I/O, migrations, dot-path access | `packages/cli`, `apps/server` |
| `@inquirer/prompts` | `^8.2.0` | Interactive CLI prompts for `dorkos init` | `packages/cli` |
| `zod` | `^4.3.6` (existing) | Schema definition, validation, JSON Schema generation via `z.toJSONSchema()` | `packages/shared` |

**Note:** `zod-to-json-schema` is NOT needed. Zod v4 has native `z.toJSONSchema()` support, eliminating this dependency.

**ESM compatibility:** `conf` v15 is pure ESM. DorkOS CLI already uses `"type": "module"` and esbuild with `format: 'esm'`. `conf` must be added to esbuild's `external` array (not bundled).

## 6. Detailed Design

### 6.1 Config Schema

New file: `packages/shared/src/config-schema.ts`

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

Export from `packages/shared` via new entry in `package.json` exports map:
```json
"./config-schema": {
  "types": "./src/config-schema.ts",
  "default": "./dist/config-schema.js"
}
```

### 6.2 ConfigManager Service

New file: `apps/server/src/services/config-manager.ts`

**Responsibilities:**
1. Initialize `conf` with `cwd: process.env.DORK_HOME`, overriding platform defaults
2. Convert Zod schema to JSON Schema via `z.toJSONSchema()` for `conf`'s Ajv validator
3. Handle first-run: if no config exists, `conf` creates it with defaults
4. Provide typed `get()`, `set()`, `getAll()`, `reset()`, `validate()` methods
5. Handle corrupt config: back up to `config.json.bak`, recreate with defaults
6. Warn on sensitive field access

```typescript
import Conf from 'conf';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { UserConfigSchema, USER_CONFIG_DEFAULTS, SENSITIVE_CONFIG_KEYS } from '@dorkos/shared/config-schema';
import type { UserConfig } from '@dorkos/shared/config-schema';

const jsonSchema = z.toJSONSchema(UserConfigSchema, { target: 'draft-2020-12' });

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
        console.warn(`⚠️  Corrupt config backed up to ${backupPath}`);
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

  get isFirstRun(): boolean { return this._isFirstRun; }

  get<K extends keyof UserConfig>(key: K): UserConfig[K] {
    return this.store.get(key);
  }

  /** Get a nested value via dot-path (e.g., 'server.port') */
  getDot(key: string): unknown {
    return this.store.get(key as any);
  }

  set<K extends keyof UserConfig>(key: K, value: UserConfig[K]): void {
    this.store.set(key, value);
  }

  /** Set a nested value via dot-path */
  setDot(key: string, value: unknown): { warning?: string } {
    const result: { warning?: string } = {};
    if (SENSITIVE_CONFIG_KEYS.includes(key as any)) {
      result.warning = `'${key}' contains sensitive data. Consider using environment variables instead.`;
    }
    this.store.set(key as any, value);
    return result;
  }

  getAll(): UserConfig {
    return this.store.store;
  }

  reset(key?: string): void {
    if (key) {
      this.store.reset(key as any);
    } else {
      this.store.clear();
      this.store.set(USER_CONFIG_DEFAULTS);
    }
  }

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

**Why a singleton with lazy init:** The config manager needs `DORK_HOME` which is set by the CLI before importing the server. The `initConfigManager()` function is called in the CLI entry point or server startup, and the `configManager` export is used everywhere else.

### 6.3 CLI Integration

Modified file: `packages/cli/src/cli.ts`

**Changes:**
1. After creating `~/.dork/` and before starting the server, initialize `configManager`
2. Read config values and merge with CLI flags (flags take precedence)
3. Route `dorkos config <subcommand>` and `dorkos init` to handlers
4. Print first-run message if config was just created

```
CLI startup flow (updated):
1. Parse CLI flags (--port, --tunnel, --dir, --help, --version)
2. Create ~/.dork/ directory
3. Set DORK_HOME env var
4. Check for 'config' or 'init' subcommands → handle and exit
5. Initialize configManager
6. Merge: CLI flags > env vars > config values > defaults
7. Set process.env from merged config
8. Print first-run message if applicable
9. Import and start server
```

### 6.4 Config CLI Commands

New file: `packages/cli/src/config-commands.ts`

| Command | Behavior |
|---------|----------|
| `dorkos config` | Pretty-print all effective settings with source indicators |
| `dorkos config get <key>` | Print single value by dot-path (e.g., `server.port`) |
| `dorkos config set <key> <value>` | Set value, auto-parse type (number, boolean, string). Warn on sensitive keys. |
| `dorkos config list` | Print raw JSON (machine-readable, for scripting) |
| `dorkos config reset [key]` | Reset all or specific key to defaults |
| `dorkos config edit` | Open config file in `$EDITOR` (fallback: `nano` on Unix, `notepad` on Windows) |
| `dorkos config path` | Print absolute path to config file |
| `dorkos config validate` | Run Zod validation, print results, exit 0/1 |

**Value parsing for `config set`:**
- `"true"` / `"false"` → boolean
- Numeric strings → number
- `"null"` → null
- Everything else → string

**Pretty-print format for `dorkos config`:**
```
DorkOS Configuration (~/.dork/config.json)

  server.port      4242          (default)
  server.cwd       /Users/me     (config)
  tunnel.enabled   false         (default)
  tunnel.domain    —             (default)
  ui.theme         dark          (config)

Config file: ~/.dork/config.json
```

### 6.5 Interactive Setup Wizard

New file: `packages/cli/src/init-wizard.ts`

**`dorkos init`** — Interactive setup using `@inquirer/prompts`:

```
🤓 DorkOS Setup

? Default port: (4242)
? UI theme: › system
  light
  dark
  system
? Enable tunnel by default? (y/N)
? Default working directory: (/Users/me)

✓ Config saved to ~/.dork/config.json
```

**`dorkos init --yes`** — Accept all defaults silently (CI-friendly):
```
✓ Config initialized with defaults at ~/.dork/config.json
```

**Behavior:**
- If config already exists, prompt: "Config already exists. Overwrite? (y/N)"
- `--yes` flag skips all prompts, uses defaults
- Writes full config to file (not just version marker)

### 6.6 PATCH /api/config Endpoint

Modified file: `apps/server/src/routes/config.ts`

Add `PATCH /api/config` alongside existing `GET /api/config`:

**Request:** Partial `UserConfig` body (deep merge with current config)
```json
PATCH /api/config
Content-Type: application/json

{
  "ui": { "theme": "dark" },
  "server": { "port": 5000 }
}
```

**Response (200):**
```json
{
  "success": true,
  "config": { /* full merged UserConfig */ },
  "warnings": ["'tunnel.authtoken' contains sensitive data..."]
}
```

**Response (400):**
```json
{
  "error": "Validation failed",
  "details": ["server.port: Number must be >= 1024"]
}
```

**Validation flow:**
1. Parse request body
2. Deep merge with current config
3. Validate merged result with `UserConfigSchema`
4. If valid, persist and return full config
5. If invalid, return 400 with Zod error details
6. Check for sensitive keys in the patch, include warnings if present

### 6.7 Precedence Resolution

The merge order at CLI startup:

```
Built-in defaults (USER_CONFIG_DEFAULTS)
  ↓ overridden by
~/.dork/config.json (configManager.getAll())
  ↓ overridden by
Environment variables (.env or shell: DORKOS_PORT, TUNNEL_ENABLED, etc.)
  ↓ overridden by
CLI flags (--port, --tunnel, --dir)
  = Final effective config
```

**Implementation:** In `cli.ts`, after loading config, only set `process.env.*` values if they aren't already set by CLI flags or env vars:

```typescript
// Only apply config values as fallbacks (don't override env/flags)
if (!process.env.DORKOS_PORT && !cliPort) {
  const configPort = configManager.getDot('server.port');
  if (configPort) process.env.DORKOS_PORT = String(configPort);
}
```

### 6.8 Server Startup Changes

Modified file: `apps/server/src/index.ts`

- Import and call `initConfigManager()` at the top of `startServer()`
- The existing `process.env` reads continue to work (CLI sets them from merged config)
- No changes needed to how routes/services read config — they still use `process.env`
- The `configManager` is used only by the PATCH endpoint for persistence

### 6.9 esbuild Changes

Modified file: `packages/cli/scripts/build.ts`

Add `conf` and `@inquirer/prompts` to esbuild's `external` array so they're resolved from `node_modules` at runtime (not bundled):

```typescript
external: [
  // ... existing externals
  'conf',
  '@inquirer/prompts',
]
```

Both packages are listed in `packages/cli/package.json` dependencies so they ship with `npm install -g dorkos`.

## 7. User Experience

### First-time user (npm install)
```bash
$ npm install -g dorkos
$ dorkos
✓ Created config at ~/.dork/config.json
Starting DorkOS on port 4242...
```

### Optional interactive setup
```bash
$ dorkos init
🤓 DorkOS Setup
? Default port: 8080
? UI theme: dark
? Enable tunnel by default? No
? Default working directory: /Users/me/projects
✓ Config saved to ~/.dork/config.json

$ dorkos
Starting DorkOS on port 8080...
```

### Day-to-day config changes
```bash
$ dorkos config set server.port 5000
✓ Set server.port = 5000

$ dorkos config set tunnel.authtoken my-token
⚠️  'tunnel.authtoken' contains sensitive data.
    Consider using the NGROK_AUTHTOKEN environment variable instead.
✓ Set tunnel.authtoken = my-token

$ dorkos config get server.port
5000

$ dorkos config
DorkOS Configuration (~/.dork/config.json)

  server.port      5000          (config)
  server.cwd       /Users/me     (config)
  tunnel.enabled   false         (default)
  ui.theme         dark          (config)

$ dorkos config validate
✓ Config is valid

$ dorkos config reset server.port
✓ Reset server.port to default (4242)
```

### Remote config update (via tunnel)
A user connected via tunnel can update settings through the PATCH endpoint, which the client Settings UI can call.

## 8. Testing Strategy

### 8.1 Config Schema Tests

File: `packages/shared/src/__tests__/config-schema.test.ts`

```
- UserConfigSchema parses minimal input (just version) with defaults filled
- UserConfigSchema rejects invalid port (< 1024, > 65535, non-integer)
- UserConfigSchema rejects invalid theme value
- UserConfigSchema accepts null for nullable fields
- z.toJSONSchema() produces valid JSON Schema from UserConfigSchema
- SENSITIVE_CONFIG_KEYS contains expected keys
- USER_CONFIG_DEFAULTS matches schema defaults
```

### 8.2 ConfigManager Service Tests

File: `apps/server/src/services/__tests__/config-manager.test.ts`

Mock `conf` (or use a temp directory) to test:

```
- initConfigManager() creates a ConfigManager instance
- get() returns default values for unset keys
- set()/getDot() correctly stores and retrieves nested values
- setDot() on sensitive key returns warning string
- reset() restores individual key to default
- reset() with no args restores all defaults
- validate() returns { valid: true } for valid config
- validate() returns errors for invalid config
- isFirstRun is true when config file doesn't exist
- isFirstRun is false when config file exists
- Corrupt config: backs up file and recreates defaults (use temp dir)
- path returns expected file path
```

### 8.3 PATCH /api/config Endpoint Tests

File: `apps/server/src/routes/__tests__/config.test.ts` (extend existing)

```
- PATCH /api/config with valid partial update returns 200 and merged config
- PATCH /api/config with invalid value returns 400 with Zod errors
- PATCH /api/config with sensitive key includes warning in response
- PATCH /api/config with empty body returns 200 (no-op, returns current config)
- GET /api/config continues to return ServerConfig shape (backward compat)
```

### 8.4 CLI Config Command Tests

File: `packages/cli/src/__tests__/config-commands.test.ts`

Test the command handler functions (not the full CLI process):

```
- parseConfigValue() converts "true"/"false" to boolean
- parseConfigValue() converts numeric strings to numbers
- parseConfigValue() converts "null" to null
- parseConfigValue() passes strings through unchanged
- handleConfigGet() prints value for valid key
- handleConfigSet() persists value and prints confirmation
- handleConfigSet() prints warning for sensitive keys
- handleConfigValidate() exits 0 for valid config
- handleConfigValidate() exits 1 for invalid config
- handleConfigReset() resets single key
- handleConfigReset() resets all keys when no arg
```

### 8.5 Init Wizard Tests

File: `packages/cli/src/__tests__/init-wizard.test.ts`

Mock `@inquirer/prompts` to test:

```
- --yes flag skips prompts and writes defaults
- Wizard prompts for port, theme, tunnel, cwd in order
- Wizard writes user choices to config
- Existing config prompts for overwrite confirmation
```

### Mocking Strategies

- **conf:** Use a temp directory via `os.tmpdir()` + random suffix for integration tests. For unit tests, mock the `Conf` constructor.
- **@inquirer/prompts:** Mock individual prompt functions (`input`, `select`, `confirm`) to return predetermined values.
- **fs:** Mock for corrupt config tests (existing pattern in transcript-reader tests).
- **process.env:** Save and restore in `beforeEach`/`afterEach`.

## 9. Performance Considerations

- **Config loading adds ~5ms** to CLI startup (one `JSON.parse` + Zod validation). Negligible.
- **conf uses atomic writes** (`write-file-atomic`): writes to temp file then renames. Safe against crashes but adds ~2ms per write.
- **No config watching in server:** The server reads config at startup and via PATCH endpoint. No file watchers needed (avoids overhead).
- **JSON Schema validation on every `set()`:** conf validates via Ajv on each write. For the low write frequency of config changes, this is not a concern.

## 10. Security Considerations

- **Sensitive fields warning:** Setting `tunnel.authtoken` or `tunnel.auth` via CLI or PATCH triggers a warning suggesting env vars instead. The operation proceeds (not blocked).
- **File permissions:** conf creates files with default OS permissions. Users on shared systems should ensure `~/.dork/` is mode 700. We don't enforce this programmatically to avoid cross-platform issues.
- **PATCH endpoint:** No authentication required (same as all DorkOS API endpoints currently). If tunnel is enabled with `TUNNEL_AUTH`, the basic auth protects the entire API including PATCH.
- **No secrets in logs:** Config values are not logged at startup. The `dorkos config` command shows values only when explicitly requested.

## 11. Documentation

### New: `guides/configuration.md`

Comprehensive configuration guide covering:
- Config file location and structure
- All available settings with types and defaults
- Precedence order (CLI flags > env vars > config > defaults)
- CLI config commands with examples
- `dorkos init` wizard usage
- Schema versioning and migration
- Security best practices (tokens in env vars)

### Updates

| Document | Changes |
|----------|---------|
| `CLAUDE.md` | Add config system section: location, schema, precedence, CLI commands. Add `dorkos init` and `dorkos config` to Commands section. |
| `guides/architecture.md` | Add ConfigManager to services list. Update startup flow diagram with config loading step. |
| `guides/api-reference.md` | Document PATCH /api/config endpoint with request/response schemas. |
| `packages/cli/README.md` | Add configuration section with commands and examples. |
| CLI `--help` output | Add `Config file: ~/.dork/config.json` line and list `config`, `init` subcommands. |

## 12. Implementation Phases

### Phase 1: Core Config System
- `packages/shared/src/config-schema.ts` — Zod schema, types, defaults
- `packages/shared/package.json` — New export entry
- `apps/server/src/services/config-manager.ts` — ConfigManager service
- `apps/server/src/services/__tests__/config-manager.test.ts` — Service tests
- `packages/shared/src/__tests__/config-schema.test.ts` — Schema tests
- Install `conf` in `packages/cli` and `apps/server`

### Phase 2: CLI Integration
- `packages/cli/src/config-commands.ts` — Config subcommand handlers
- `packages/cli/src/cli.ts` — Route subcommands, config loading, precedence merge
- `packages/cli/src/__tests__/config-commands.test.ts` — Command tests
- `packages/cli/scripts/build.ts` — Add `conf` to esbuild externals

### Phase 3: Interactive Wizard
- `packages/cli/src/init-wizard.ts` — Setup wizard
- `packages/cli/src/__tests__/init-wizard.test.ts` — Wizard tests
- Install `@inquirer/prompts` in `packages/cli`
- Add to esbuild externals

### Phase 4: Server Endpoint
- `apps/server/src/routes/config.ts` — Add PATCH handler
- `apps/server/src/routes/__tests__/config.test.ts` — Endpoint tests
- `packages/shared/src/schemas.ts` — Add PATCH request/response schemas for OpenAPI

### Phase 5: Documentation
- `guides/configuration.md` — New comprehensive guide
- `CLAUDE.md` — Config system section
- `guides/architecture.md` — ConfigManager service docs
- `guides/api-reference.md` — PATCH endpoint docs
- CLI `--help` output updates

## 13. Open Questions

None — all clarifications resolved in ideation phase (see [01-ideation.md](./01-ideation.md) Section 6).

## 14. File Change Summary

### New Files
| File | Purpose |
|------|---------|
| `packages/shared/src/config-schema.ts` | Zod schema, types, defaults, sensitive keys list |
| `apps/server/src/services/config-manager.ts` | ConfigManager service (conf + Zod) |
| `packages/cli/src/config-commands.ts` | CLI config subcommand handlers |
| `packages/cli/src/init-wizard.ts` | Interactive `dorkos init` wizard |
| `guides/configuration.md` | Configuration guide |
| `packages/shared/src/__tests__/config-schema.test.ts` | Schema tests |
| `apps/server/src/services/__tests__/config-manager.test.ts` | Service tests |
| `packages/cli/src/__tests__/config-commands.test.ts` | CLI command tests |
| `packages/cli/src/__tests__/init-wizard.test.ts` | Wizard tests |

### Modified Files
| File | Changes |
|------|---------|
| `packages/cli/src/cli.ts` | Config loading, subcommand routing, precedence merge |
| `packages/cli/package.json` | Add `conf`, `@inquirer/prompts` dependencies |
| `packages/cli/scripts/build.ts` | Add externals for conf, @inquirer/prompts |
| `apps/server/src/routes/config.ts` | Add PATCH handler |
| `apps/server/src/index.ts` | Call `initConfigManager()` at startup |
| `apps/server/package.json` | Add `conf` dependency |
| `packages/shared/package.json` | Add `./config-schema` export |
| `packages/shared/src/schemas.ts` | Add PATCH request/response schemas |
| `CLAUDE.md` | Config system documentation |
| `guides/architecture.md` | ConfigManager service docs |
| `guides/api-reference.md` | PATCH endpoint docs |

## 15. References

- [conf npm package](https://www.npmjs.com/package/conf) — v15.1.0, atomic writes, migrations
- [Zod v4 JSON Schema](https://zod.dev/json-schema) — Native `z.toJSONSchema()` API
- [@inquirer/prompts](https://www.npmjs.com/package/@inquirer/prompts) — v8.2.x, TypeScript-first prompts
- [CLI Guidelines](https://clig.dev/) — Config command patterns
- [Ideation document](./01-ideation.md) — Full research and decision log
- [Research: conf library](../../research/dorkos-config-file-system.md) — Detailed library analysis
