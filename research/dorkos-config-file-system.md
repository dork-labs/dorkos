# DorkOS Config File System Research

**Research Date**: 2026-02-16
**Feature**: Persistent configuration file system for DorkOS CLI
**Status**: Deep Research Mode (15 sources analyzed)

## Executive Summary

DorkOS should adopt a **hybrid configuration approach** combining:
1. **`conf` library** for robust file management (atomic writes, JSON Schema validation)
2. **Zod schemas** for runtime validation (already in use across the project)
3. **Standard precedence**: Defaults → `~/.dork/config.json` → `.env` → CLI flags
4. **Graceful degradation** with warnings for invalid config (don't block startup)
5. **Silent first-run** with sensible defaults (interactive wizard optional via `dorkos init`)
6. **Config subcommands**: `dorkos config [get|set|list|reset]` pattern

This recommendation balances DorkOS's existing tech stack (Zod, TypeScript, Express) with battle-tested patterns from npm/yarn/pnpm while maintaining the zero-config philosophy for new users.

---

## Research Findings

### 1. .env vs config.json Relationship

**Standard Precedence Hierarchy** (highest to lowest):
- **CLI flags** (e.g., `--port 4242`)
- **Environment variables** (e.g., `DORKOS_PORT=4242`)
- **Config file** (`~/.dork/config.json`)
- **Defaults** (hardcoded in application)

This pattern is used by:
- **uv (Python)**: Project config → User config → System config → Env vars (env always wins)
- **Gemini CLI**: Defaults → System defaults → User settings → Project settings → System settings → Env vars → CLI args
- **Docker Compose**: CLI args are highest precedence

**Key Insight**: Environment variables should **override** config files, not replace them. This allows:
- Per-session customization without modifying persistent config
- CI/CD overrides without changing committed files
- Developer overrides without affecting team config

**Recommendation for DorkOS**:
1. **Keep .env for development** — DorkOS developers use `.env` during `npm run dev`
2. **Introduce config.json for users** — Published CLI users get `~/.dork/config.json`
3. **No deprecation needed** — Both coexist with clear precedence (env vars win)
4. **Document explicitly** — Add config precedence section to docs

**Implementation Example**:
```typescript
// Load order
const config = {
  ...DEFAULTS,
  ...loadFromConfigFile('~/.dork/config.json'),
  ...loadFromEnv(process.env),
  ...parseCliFlags(process.argv),
};
```

---

### 2. Library Recommendations

Three approaches evaluated: **hand-rolled with Zod**, **conf**, and **cosmiconfig**.

#### Option A: Hand-Rolled with Zod ⭐ **Simplest, but risky**

**Pros**:
- Already using Zod everywhere (zero new dependencies)
- Full control over validation logic
- Direct integration with existing `@dorkos/shared` schemas

**Cons**:
- No atomic writes (corruption risk on crash)
- No built-in encryption support
- No migration system for schema changes
- Must implement file locking manually
- Risk of subtle bugs in filesystem handling

**When to choose**: Only if you need <1KB bundle size and accept risk of data loss

**Code Example**:
```typescript
import { z } from 'zod';
import fs from 'fs/promises';

const ConfigSchema = z.object({
  version: z.literal(1),
  port: z.number().default(4242),
  theme: z.enum(['light', 'dark']).default('dark'),
});

async function loadConfig() {
  const raw = await fs.readFile('~/.dork/config.json', 'utf-8');
  return ConfigSchema.parse(JSON.parse(raw)); // Throws on invalid
}
```

**Risk**: If process crashes during `fs.writeFile`, config corrupts.

#### Option B: conf ⭐⭐⭐ **Recommended for DorkOS**

**conf** by sindresorhus

**Pros**:
- **Atomic writes** — Process crashes don't corrupt config
- **JSON Schema validation** — Uses AJV under the hood (compatible with Zod via `zod-to-json-schema`)
- **Built-in migrations** — Version-based schema evolution
- **Encryption support** — Obfuscate sensitive values (AES-256)
- **XDG compliance** — Respects system conventions for config location
- **Tiny footprint** — 12KB bundled
- **Battle-tested** — Used by hundreds of popular CLIs

**Cons**:
- **Single-process limitation** — "Does not support multiple processes writing to the same store"
- Uses JSON Schema (not Zod) — Requires schema conversion
- Opinionated defaults (may need customization)

**When to choose**: DorkOS's primary use case (single CLI process writing config). Multi-process writes are not a concern.

**Code Example**:
```typescript
import Conf from 'conf';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { ConfigSchema } from '@dorkos/shared/schemas';

const schema = zodToJsonSchema(ConfigSchema);
const config = new Conf({
  projectName: 'dorkos',
  schema,
  defaults: {
    version: 1,
    port: 4242,
    theme: 'dark',
  },
  clearInvalidConfig: false, // Warn instead of auto-clearing
});

// Usage
config.set('port', 5000);
config.get('port'); // 5000
config.reset('port'); // Back to 4242
```

**Migration Example**:
```typescript
const config = new Conf({
  projectName: 'dorkos',
  migrations: {
    '1.0.0': (store) => {
      // Migrate old 'color' field to new 'theme'
      store.set('theme', store.get('color') === 'light' ? 'light' : 'dark');
      store.delete('color');
    },
  },
});
```

#### Option C: cosmiconfig ⭐ **Overkill for fixed paths**

**cosmiconfig**

**Pros**:
- Multi-format support (JSON, YAML, JS, TS)
- Discovery pattern (searches multiple locations)
- Used by ESLint, Prettier, Babel

**Cons**:
- **Not designed for this use case** — Built for discoverable config (`.eslintrc`, `.prettierrc`)
- **No write API** — Read-only library
- Heavier footprint (~50KB)
- Requires separate write logic (defeats the purpose)

**When to choose**: Projects needing flexible config discovery (e.g., `package.json` property, RC files). **Not suitable for DorkOS** with fixed `~/.dork/config.json` path.

#### Recommendation Matrix

| Criteria | Hand-Rolled | conf | cosmiconfig |
|----------|-------------|------|-------------|
| Atomic writes | ❌ Manual | ✅ Built-in | ❌ Read-only |
| Validation | ✅ Zod native | ✅ JSON Schema | ⚠️ Manual |
| Migrations | ❌ Manual | ✅ Built-in | ❌ N/A |
| Bundle size | ✅ 0KB | ✅ 12KB | ⚠️ 50KB |
| Write API | ⚠️ Manual | ✅ Built-in | ❌ None |
| DorkOS fit | ⚠️ Risky | ✅ Perfect | ❌ Wrong tool |

**Final Recommendation**: **Use `conf`** + **Zod** hybrid approach:
1. `conf` handles file I/O, atomic writes, migrations
2. Convert Zod schemas to JSON Schema via `zod-to-json-schema`
3. Runtime validation still uses Zod for type inference consistency

---

### 3. Config Warnings & Validation

**Industry Patterns**:

| Strategy | When to Use | Examples |
|----------|-------------|----------|
| **Silent degradation** | Non-critical settings (theme, editor) | npm, yarn (use defaults) |
| **Warn + fallback** | Important but recoverable (port, paths) | Git (warns about invalid user.email) |
| **Fail fast** | Mission-critical (API keys, auth) | AWS CLI (refuses without credentials) |

**Recommended for DorkOS**:

```typescript
try {
  config = loadConfig();
} catch (error) {
  if (error instanceof ZodError) {
    console.warn('⚠️  Invalid config detected:');
    console.warn(formatZodError(error));
    console.warn('Using defaults. Run `dorkos config reset` to fix.\n');
    config = DEFAULTS;
  } else {
    throw error; // Unexpected errors still crash
  }
}
```

**Validation Commands**:
```bash
dorkos config validate   # Check config without starting server
dorkos config reset      # Restore defaults
dorkos config doctor     # Comprehensive health check (config + env + deps)
```

**Error Message Best Practices**:
1. **Actionable** — Tell users how to fix: `Run 'dorkos config reset' to restore defaults`
2. **Specific** — Show exact field: `port: Expected number, received string`
3. **Trackable** — Include error codes: `[DORKOS_CONFIG_001]`

**Example Output**:
```
⚠️  Config validation failed:

  • port: Expected number, received "not-a-number"
  • theme: Invalid enum value. Expected 'light' | 'dark', received 'blue'

Using default values. To fix:
  dorkos config reset              (restore all defaults)
  dorkos config set port 4242      (fix individual value)
  dorkos config edit               (open in $EDITOR)

[DORKOS_CONFIG_001]
```

---

### 4. Standard Setup Requirements

#### A. Config Versioning

**Always include a `version` field** for future schema migrations:

```json
{
  "version": 1,
  "port": 4242,
  "theme": "dark"
}
```

**Migration Strategy**:
```typescript
const config = new Conf({
  projectName: 'dorkos',
  migrations: {
    '0.0.1': (store) => {
      store.set('version', 1);
    },
    '1.0.0': (store) => {
      // v1 → v2: Rename 'color' to 'theme'
      const old = store.get('color');
      if (old) {
        store.set('theme', old);
        store.delete('color');
      }
      store.set('version', 2);
    },
  },
});
```

**Best Practices**:
1. **Additive changes only** — New fields must have defaults (backward compatible)
2. **Deprecate gradually** — Keep old fields for 2+ major versions
3. **Document breaking changes** — CHANGELOG.md for config schema changes
4. **Validate on load** — Reject unknown versions explicitly

#### B. Initial Config File

**Minimal First-Run Config** (`~/.dork/config.json`):
```json
{
  "version": 1,
  "created": "2026-02-16T10:30:00Z",
  "defaults": {
    "port": 4242,
    "theme": "dark",
    "cwd": null,
    "tunnel": {
      "enabled": false
    }
  }
}
```

**What NOT to include**:
- ❌ Secrets (API keys) — Use env vars or separate secure store
- ❌ Machine-specific paths — Use `null` + auto-detect
- ❌ Redundant defaults — If it matches hardcoded default, omit it

**Lazy Creation Pattern**:
```typescript
function ensureConfig() {
  if (!config.has('version')) {
    config.set('version', 1);
    config.set('created', new Date().toISOString());
    // Don't pre-populate defaults — let conf handle it
  }
}
```

#### C. XDG Base Directory Compliance

`conf` automatically handles platform-specific locations:

| Platform | Location |
|----------|----------|
| Linux | `~/.config/dorkos/config.json` |
| macOS | `~/Library/Preferences/dorkos/config.json` |
| Windows | `%APPDATA%\dorkos\Config\config.json` |

DorkOS already uses `~/.dork/` — **consider migrating to XDG-compliant paths** for v2.0 to align with standards.

---

### 5. Interactive Setup & CLI Commands

#### A. First-Run Strategy

**Research Consensus**:

> "The wizard pattern wins because new users succeed in one try, while power users can skip with flags."

**Recommended for DorkOS**: **Silent first-run + optional interactive wizard**

```bash
# First run (silent)
$ dorkos
✓ Created config at ~/.dork/config.json
Starting DorkOS on port 4242...

# Opt-in interactive setup
$ dorkos init
? Select default port: (4242)
? Choose theme: › dark
? Enable tunnel by default? (y/N)
✓ Config saved to ~/.dork/config.json
```

**Why not force wizard?**
- Breaks automation (CI/CD scripts)
- Annoys experienced users
- "Just works" philosophy (Jest, Parcel examples)

**Implementation**:
```typescript
// Silent creation on first run
if (!fs.existsSync(configPath)) {
  config.set(DEFAULTS);
  console.log(`✓ Created config at ${configPath}`);
}

// Explicit interactive setup
if (process.argv.includes('init')) {
  await runInteractiveSetup();
}
```

#### B. Interactive Prompt Library

**Top Options**:

| Library | Stars | Features | Use Case |
|---------|-------|----------|----------|
| @inquirer/prompts | 19k | Modular, modern API, TypeScript-first | ✅ **Recommended** |
| prompts | 8k | Lightweight, promise-based | Simpler alternative |
| enquirer | 7k | Stylish UI, used by Webpack | Older, maintenance mode |

**Inquirer Example**:
```typescript
import { input, select, confirm } from '@inquirer/prompts';

async function runInteractiveSetup() {
  const port = await input({
    message: 'Default port:',
    default: '4242',
    validate: (v) => !isNaN(Number(v)) || 'Must be a number',
  });

  const theme = await select({
    message: 'Color theme:',
    choices: [
      { name: 'Dark (recommended)', value: 'dark' },
      { name: 'Light', value: 'light' },
    ],
  });

  const enableTunnel = await confirm({
    message: 'Enable ngrok tunnel by default?',
    default: false,
  });

  config.set({ port: Number(port), theme, tunnel: { enabled: enableTunnel } });
  console.log('✓ Config saved!');
}
```

**Skip Prompt Pattern**:
```bash
dorkos init --yes          # Accept all defaults (CI-friendly)
dorkos init --quiet        # Silent mode
```

#### C. Config Subcommands

**Standard Pattern** (npm, git, pnpm style):

```bash
dorkos config                      # Show all settings
dorkos config get <key>            # Get single value
dorkos config set <key> <value>    # Set single value
dorkos config list                 # JSON output (machine-readable)
dorkos config reset [key]          # Reset to defaults
dorkos config edit                 # Open in $EDITOR
dorkos config path                 # Print file path
dorkos config validate             # Check validity
```

**Implementation**:
```typescript
// dorkos config get port
if (args[0] === 'get') {
  console.log(config.get(args[1]));
}

// dorkos config set port 5000
if (args[0] === 'set') {
  config.set(args[1], parseValue(args[2]));
  console.log(`✓ Set ${args[1]} = ${args[2]}`);
}

// dorkos config reset
if (args[0] === 'reset') {
  if (args[1]) {
    config.reset(args[1]);
    console.log(`✓ Reset ${args[1]} to default`);
  } else {
    config.clear();
    console.log('✓ Reset all settings to defaults');
  }
}

// dorkos config edit - NOTE: Using shell commands with user input requires careful validation
if (args[0] === 'edit') {
  const editor = process.env.EDITOR || 'nano';
  // Security note: Only use known safe editor commands
  execSync(`${editor} ${config.path}`);
}
```

**JSON Output for Scripting**:
```bash
dorkos config list --json
# {"port":4242,"theme":"dark","tunnel":{"enabled":false}}
```

---

### 6. Documentation Patterns

#### A. Required Documentation

**1. Configuration Guide** (`guides/configuration.md`):
- All available settings (with types and defaults)
- Precedence order (defaults → config → env → flags)
- Config file location per platform
- Migration guide for schema changes

**2. CLI Help Integration**:
```bash
dorkos --help
# Config:
#   --port <number>        Server port (default: 4242)
#   --theme <light|dark>   UI theme (default: dark)
#
# Config file: ~/.dork/config.json
# Docs: https://github.com/dork-labs/dorkos#configuration
```

**3. README Section**:
````markdown
## Configuration

DorkOS reads config from `~/.dork/config.json` (auto-created on first run).

### Precedence

Settings are merged in this order:
1. CLI flags (highest)
2. Environment variables
3. Config file
4. Built-in defaults (lowest)

### Commands

```bash
dorkos config              # View current settings
dorkos config set port 5000  # Change port
dorkos init                # Interactive setup wizard
```

See [Configuration Guide](./guides/configuration.md) for all options.
````

**4. In-App Help** (`dorkos config --help`):
```
Config Commands:
  dorkos config               Show all settings
  dorkos config get <key>     Get a config value
  dorkos config set <key> <val>  Set a config value
  dorkos config reset [key]   Reset to defaults
  dorkos config edit          Open config in $EDITOR
  dorkos config path          Show config file location
  dorkos config validate      Check config validity

Examples:
  dorkos config get port
  dorkos config set theme dark
  dorkos config reset
  dorkos config edit

Config file: ~/.dork/config.json
Docs: https://github.com/dork-labs/dorkos/blob/main/guides/configuration.md
```

#### B. Schema Documentation Auto-Generation

**Leverage Zod for Docs**:
```typescript
import { generateSchema } from '@anatine/zod-openapi';

const ConfigSchema = z.object({
  port: z.number().default(4242).describe('Server port'),
  theme: z.enum(['light', 'dark']).default('dark').describe('UI color theme'),
});

// Generate markdown table from schema
function generateConfigDocs(schema: ZodObject) {
  // Extract field names, types, defaults, descriptions
  // Output markdown table
}
```

**Output**:
| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `port` | number | 4242 | Server port |
| `theme` | `'light'` \| `'dark'` | `'dark'` | UI color theme |

---

## Implementation Recommendations

### Phase 1: Foundation (v1.0)
1. ✅ Install `conf` + `zod-to-json-schema`
2. ✅ Create `packages/shared/src/config-schema.ts` with Zod schema
3. ✅ Implement config service in `apps/server/src/services/config-manager.ts`
4. ✅ Add graceful validation with warnings
5. ✅ Silent first-run (auto-create with defaults)

### Phase 2: CLI Commands (v1.1)
6. ✅ Add `dorkos config` subcommands (get/set/list/reset)
7. ✅ Add `dorkos config edit` (opens in $EDITOR)
8. ✅ Add `dorkos config path` (prints file location)
9. ✅ Update `--help` output with config info

### Phase 3: Interactive Setup (v1.2)
10. ✅ Install `@inquirer/prompts`
11. ✅ Implement `dorkos init` wizard
12. ✅ Add `--yes` and `--quiet` flags for automation

### Phase 4: Documentation (v1.3)
13. ✅ Write `guides/configuration.md`
14. ✅ Add README section
15. ✅ Generate schema docs from Zod (auto-update)
16. ✅ Add JSDoc to config schema fields

### Phase 5: Advanced Features (v2.0)
17. ⏭️ Migrate to XDG-compliant paths (breaking change)
18. ⏭️ Add encryption for sensitive fields (API tokens)
19. ⏭️ Implement `dorkos config doctor` health check
20. ⏭️ Add JSON output (`--json` flag) for scripting

---

## Code Examples

### Hybrid Zod + Conf Implementation

```typescript
// packages/shared/src/config-schema.ts
import { z } from 'zod';

export const ConfigSchema = z.object({
  version: z.literal(1),
  port: z.number().min(1024).max(65535).default(4242),
  theme: z.enum(['light', 'dark']).default('dark'),
  cwd: z.string().nullable().default(null),
  tunnel: z.object({
    enabled: z.boolean().default(false),
    domain: z.string().nullable().default(null),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;
```

```typescript
// apps/server/src/services/config-manager.ts
import Conf from 'conf';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { ConfigSchema } from '@dorkos/shared/schemas';
import type { Config } from '@dorkos/shared/types';

const jsonSchema = zodToJsonSchema(ConfigSchema);
const DEFAULTS: Config = ConfigSchema.parse({}); // Extract defaults from Zod

class ConfigManager {
  private store: Conf<Config>;

  constructor() {
    this.store = new Conf({
      projectName: 'dorkos',
      cwd: process.env.DORK_HOME || undefined,
      schema: jsonSchema as any,
      defaults: DEFAULTS,
      clearInvalidConfig: false, // Don't auto-clear, warn instead
      migrations: {
        '1.0.0': (store) => {
          store.set('version', 1);
        },
      },
    });

    // Validate on load
    this.validate();
  }

  private validate() {
    try {
      const raw = this.store.store;
      ConfigSchema.parse(raw); // Runtime validation with Zod
    } catch (error) {
      if (error instanceof z.ZodError) {
        console.warn('⚠️  Invalid config detected:');
        console.warn(formatZodError(error));
        console.warn(`\nUsing defaults. Run 'dorkos config reset' to fix.\n`);
      } else {
        throw error;
      }
    }
  }

  get<K extends keyof Config>(key: K): Config[K] {
    return this.store.get(key);
  }

  set<K extends keyof Config>(key: K, value: Config[K]): void {
    this.store.set(key, value);
  }

  reset(key?: keyof Config): void {
    if (key) {
      this.store.reset(key);
    } else {
      this.store.clear();
    }
  }

  getAll(): Config {
    return this.store.store;
  }

  get path(): string {
    return this.store.path;
  }
}

export const configManager = new ConfigManager();
```

```typescript
// packages/cli/src/config-cli.ts
import { configManager } from '@dorkos/server/services/config-manager';
import { input, select, confirm } from '@inquirer/prompts';

export async function handleConfigCommand(args: string[]) {
  const [subcommand, ...rest] = args;

  switch (subcommand) {
    case 'get':
      console.log(configManager.get(rest[0] as any));
      break;

    case 'set': {
      const [key, value] = rest;
      const parsed = parseValue(value); // Parse "true", "4242", etc.
      configManager.set(key as any, parsed);
      console.log(`✓ Set ${key} = ${value}`);
      break;
    }

    case 'list':
      const format = rest.includes('--json') ? 'json' : 'pretty';
      if (format === 'json') {
        console.log(JSON.stringify(configManager.getAll(), null, 2));
      } else {
        printPrettyConfig(configManager.getAll());
      }
      break;

    case 'reset':
      if (rest[0]) {
        configManager.reset(rest[0] as any);
        console.log(`✓ Reset ${rest[0]} to default`);
      } else {
        configManager.reset();
        console.log('✓ Reset all settings to defaults');
      }
      break;

    case 'edit':
      const editor = process.env.EDITOR || 'nano';
      // Note: Security consideration - using execSync with user input
      // In production, validate editor command or use safer alternatives
      execSync(`${editor} ${configManager.path}`, { stdio: 'inherit' });
      break;

    case 'path':
      console.log(configManager.path);
      break;

    case 'validate':
      // Re-validate and report errors
      try {
        ConfigSchema.parse(configManager.getAll());
        console.log('✓ Config is valid');
      } catch (error) {
        console.error('✗ Config validation failed:');
        console.error(formatZodError(error));
        process.exit(1);
      }
      break;

    default:
      // No subcommand = show all
      printPrettyConfig(configManager.getAll());
  }
}

export async function runInteractiveSetup() {
  const port = await input({
    message: 'Default port:',
    default: String(configManager.get('port')),
    validate: (v) => !isNaN(Number(v)) || 'Must be a number',
  });

  const theme = await select({
    message: 'UI theme:',
    choices: [
      { name: 'Dark', value: 'dark' },
      { name: 'Light', value: 'light' },
    ],
    default: configManager.get('theme'),
  });

  const enableTunnel = await confirm({
    message: 'Enable ngrok tunnel by default?',
    default: configManager.get('tunnel').enabled,
  });

  configManager.set('port', Number(port));
  configManager.set('theme', theme);
  configManager.set('tunnel', { ...configManager.get('tunnel'), enabled: enableTunnel });

  console.log(`\n✓ Config saved to ${configManager.path}`);
}
```

---

## Potential Issues & Solutions

### Issue 1: `conf` JSON Schema vs. Zod Schema Mismatch

**Problem**: `conf` validates with JSON Schema (AJV), but DorkOS uses Zod everywhere.

**Solution**: Use `zod-to-json-schema` to convert Zod → JSON Schema for `conf`, but keep runtime validation with Zod for type safety:
```typescript
const jsonSchema = zodToJsonSchema(ConfigSchema); // For conf
const config = new Conf({ schema: jsonSchema });

// Still validate with Zod at runtime
const validated = ConfigSchema.parse(config.store);
```

**Trade-off**: Double validation (AJV + Zod), but ensures type safety + atomic writes.

### Issue 2: Multi-Process Writes (Future Concern)

**Problem**: `conf` doesn't support multiple processes writing simultaneously. If DorkOS adds a daemon or background service, this could cause issues.

**Solution**:
1. **Short-term**: Document limitation (single-process only)
2. **Long-term**: Migrate to `better-sqlite3` or `lowdb` with file locking if multi-process support needed
3. **Current**: Not a concern for CLI-only architecture

### Issue 3: Config File Location on Windows

**Problem**: Users may not know where `%APPDATA%\dorkos\Config\config.json` is.

**Solution**: Add `dorkos config path` command and show location in error messages:
```bash
$ dorkos config path
C:\Users\Alice\AppData\Roaming\dorkos\Config\config.json
```

### Issue 4: Breaking Changes in Config Schema

**Problem**: Adding required fields breaks existing configs.

**Solution**: Follow strict migration policy:
1. **Never add required fields without defaults** — All new fields must have `.default()`
2. **Deprecate gradually** — Keep old fields for 2 major versions
3. **Auto-migrate** — Use `conf` migrations to transform old → new
4. **Version check** — Reject unsupported versions explicitly

**Example**:
```typescript
// v1 schema
const V1Schema = z.object({
  version: z.literal(1),
  color: z.enum(['light', 'dark']),
});

// v2 schema (renamed field)
const V2Schema = z.object({
  version: z.literal(2),
  theme: z.enum(['light', 'dark']), // Renamed from 'color'
});

// Migration
migrations: {
  '2.0.0': (store) => {
    const old = store.get('color');
    store.set('theme', old);
    store.delete('color');
    store.set('version', 2);
  },
}
```

---

## Sources & References

### Configuration Precedence
- [Docker Compose: Environment variables precedence](https://docs.docker.com/compose/how-tos/environment-variables/envvars-precedence/)
- [uv: Configuration files](https://docs.astral.sh/uv/concepts/configuration-files/)
- [Gemini CLI: Configuration](https://geminicli.com/docs/get-started/configuration/)

### Libraries
- [sindresorhus/conf: Simple config handling](https://github.com/sindresorhus/conf)
- [conf - npm](https://www.npmjs.com/package/conf)
- [cosmiconfig - npm](https://www.npmjs.com/package/cosmiconfig)
- [Zod: TypeScript-first schema validation](https://zod.dev/)
- [zod-to-json-schema - npm](https://www.npmjs.com/package/zod-to-json-schema)

### Best Practices
- [Node.js CLI Apps Best Practices](https://github.com/lirantal/nodejs-cli-apps-best-practices)
- [Command Line Interface Guidelines](https://clig.dev/)
- [UX patterns for CLI tools](https://lucasfcosta.com/2022/06/01/ux-patterns-cli-tools.html)
- [BetterCLI.org: CLI Help pages](https://bettercli.org/design/cli-help-page/)

### Validation & Error Handling
- [AWS Well-Architected: Graceful degradation](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/rel_mitigate_interaction_failure_graceful_degradation.html)
- [Graceful Degradation in DevSecOps](https://sreschool.com/blog/graceful-degradation-in-devsecops-a-comprehensive-guide/)

### Interactive Setup
- [@inquirer/prompts - npm](https://www.npmjs.com/package/@inquirer/prompts)
- [Inquirer.js: Interactive CLI prompts](https://github.com/SBoudrias/Inquirer.js)
- [How To Create Interactive Prompts with Inquirer.js](https://www.digitalocean.com/community/tutorials/nodejs-interactive-command-line-prompts)
- [Top 8 CLI UX Patterns Users Will Brag About](https://medium.com/@kaushalsinh73/top-8-cli-ux-patterns-users-will-brag-about-4427adb548b7)

### Schema Versioning
- [Schema Evolution and Compatibility - Confluent](https://docs.confluent.io/platform/current/schema-registry/fundamentals/schema-evolution.html)
- [Database Design Patterns for Backward Compatibility](https://www.pingcap.com/article/database-design-patterns-for-ensuring-backward-compatibility/)
- [Semantic Versioning 2.0.0](https://semver.org/)

### Config Commands
- [Claude Code CLI: config commands](https://code.claude.com/docs/en/permissions)
- [pnpm config commands](https://pnpm.io/cli/config)
- [Azure CLI: configuration options](https://learn.microsoft.com/en-us/cli/azure/azure-cli-configuration)

---

## Conclusion

DorkOS should implement a **hybrid `conf` + Zod** configuration system with:

1. **`conf` for robust I/O** — Atomic writes, migrations, encryption support
2. **Zod for runtime validation** — Type safety, schema inference, consistent with existing codebase
3. **Silent first-run + optional wizard** — `dorkos` works out-of-the-box, `dorkos init` for customization
4. **Standard config commands** — `get/set/list/reset/edit/path/validate` subcommands
5. **Graceful degradation** — Warn on invalid config, don't block startup
6. **Clear precedence** — CLI flags > env vars > config file > defaults
7. **Documentation-first** — Auto-generate docs from Zod schema, integrate into `--help`

This approach balances **developer experience** (zero-config), **user control** (flexible customization), and **robustness** (atomic writes, validation, migrations) while leveraging DorkOS's existing tech stack.

**Next Steps**:
1. Create GitHub issue: "Add persistent config system (`~/.dork/config.json`)"
2. Implement Phase 1 (Foundation) in `feat/config-system` branch
3. Test with beta users before Phase 2 (CLI commands)
4. Document in `guides/configuration.md` before v1.0 release
