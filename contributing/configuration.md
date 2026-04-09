# Configuration

DorkOS uses a persistent config file at `~/.dork/config.json` for user-configurable settings. The config system is built on the `conf` library with Zod schema validation, providing atomic writes, type safety, and automatic corruption recovery.

## Quick Start

Run the interactive setup wizard on first install:

```bash
dorkos init
```

Or accept all defaults non-interactively:

```bash
dorkos init --yes
```

Set individual values:

```bash
dorkos config set server.port 8080
dorkos config set ui.theme dark
```

View current settings:

```bash
dorkos config
```

## Config File Location

The config file lives at `~/.dork/config.json` by default. The `~/.dork/` directory is created automatically on first CLI startup.

Override the config directory by setting the `DORK_HOME` environment variable:

```bash
export DORK_HOME=/custom/path
dorkos config path
# /custom/path/config.json
```

## Runtime Data File Locations

DorkOS writes several runtime data files under `~/.dork/` in addition to `config.json`. The root directory is overridden by `DORK_HOME`.

| Path                          | Purpose                                                        |
| ----------------------------- | -------------------------------------------------------------- |
| `~/.dork/config.json`         | Persistent user config (this document)                         |
| `~/.dork/dork.db`             | SQLite database (Tasks, Mesh, Relay state; WAL mode)           |
| `~/.dork/schedules.json`      | JSON snapshot of Tasks schedules                               |
| `~/.dork/logs/dorkos.log`     | NDJSON server log with daily rotation                          |
| `~/.dork/relay/adapters.json` | Relay adapter config — hot-reloaded by AdapterManager          |
| `~/.dork/relay/index.db`      | SQLite index for Relay message delivery and trace data         |
| `~/.dork/relay/bindings.json` | Adapter-to-agent binding definitions — hot-reloaded at runtime |
| `~/.dork/relay/sessions.json` | Binding session map persisted across server restarts           |
| `~/.dork/relay/`              | Relay Maildir message store (subdirectories per subject)       |

### Relay config (`~/.dork/relay/adapters.json`)

The Relay subsystem reads adapter configuration from `~/.dork/relay/adapters.json`. This file is watched with chokidar and hot-reloaded whenever it changes — no server restart is required. Each entry follows the adapter manifest format: a `type` field matching a registered adapter, plus a `config` object whose shape is defined by the adapter's `ConfigField` schema. Sensitive config fields (marked `sensitive: true` in the manifest) are masked to `***` in API responses.

### Relay bindings (`~/.dork/relay/bindings.json`)

Adapter-to-agent bindings are persisted to `~/.dork/relay/bindings.json`. The file is also hot-reloaded via chokidar. Bindings map inbound adapter messages to specific agent CWDs using a most-specific-first resolution strategy. The companion file `~/.dork/relay/sessions.json` stores the active session map so that per-chat and per-user session strategies survive server restarts.

## Settings Reference

| Key                           | Type                                                                     | Default            | Description                                                                        |
| ----------------------------- | ------------------------------------------------------------------------ | ------------------ | ---------------------------------------------------------------------------------- |
| `server.port`                 | integer (1024--65535)                                                    | `4242`             | Port the Express server listens on                                                 |
| `server.cwd`                  | string \| null                                                           | `null`             | Default working directory for sessions                                             |
| `server.boundary`             | string \| null                                                           | `null`             | Directory boundary root (`null` = home directory)                                  |
| `server.open`                 | boolean                                                                  | `true`             | Open browser automatically on startup                                              |
| `tunnel.enabled`              | boolean                                                                  | `false`            | Enable ngrok tunnel on startup                                                     |
| `tunnel.domain`               | string \| null                                                           | `null`             | Custom ngrok domain                                                                |
| `tunnel.authtoken`            | string \| null                                                           | `null`             | ngrok auth token (sensitive)                                                       |
| `tunnel.auth`                 | string \| null                                                           | `null`             | HTTP basic auth for tunnel, `user:pass` format (sensitive)                         |
| `logging.level`               | `"fatal"` \| `"error"` \| `"warn"` \| `"info"` \| `"debug"` \| `"trace"` | `"info"`           | Log verbosity level                                                                |
| `logging.maxLogSizeKb`        | integer (100--10240)                                                     | `500`              | Maximum log file size in KB before rotation                                        |
| `logging.maxLogFiles`         | integer (1--30)                                                          | `14`               | Number of rotated log files to retain                                              |
| `ui.theme`                    | `"light"` \| `"dark"` \| `"system"`                                      | `"system"`         | UI color theme                                                                     |
| `ui.dismissedUpgradeVersions` | string[]                                                                 | `[]`               | Version strings the user has dismissed upgrade notifications for                   |
| `relay.enabled`               | boolean                                                                  | `true`             | Enable Relay subsystem (config-level toggle, distinct from `DORKOS_RELAY_ENABLED`) |
| `relay.dataDir`               | string \| null                                                           | `null`             | Override Relay data directory (`null` = default under `DORK_HOME`)                 |
| `scheduler.enabled`           | boolean                                                                  | `true`             | Enable Tasks scheduler subsystem (config-level toggle)                             |
| `scheduler.maxConcurrentRuns` | integer (1--10)                                                          | `1`                | Maximum concurrently executing Pulse runs                                          |
| `scheduler.timezone`          | string \| null                                                           | `null`             | Default timezone for cron expressions (`null` = system timezone)                   |
| `scheduler.retentionCount`    | integer                                                                  | `100`              | Number of completed run records to retain in the database                          |
| `mesh.scanRoots`              | string[]                                                                 | `[]`               | Directories to scan for agent discovery                                            |
| `uploads.maxFileSize`         | integer                                                                  | `10485760` (10 MB) | Maximum file size in bytes per uploaded file                                       |
| `uploads.maxFiles`            | integer (1--50)                                                          | `10`               | Maximum number of files per upload request                                         |
| `uploads.allowedTypes`        | string[]                                                                 | `["*/*"]`          | Allowed MIME types (e.g., `["image/*", "text/plain"]`)                             |
| `agentContext.relayTools`     | boolean                                                                  | `true`             | Include Relay messaging tool documentation in agent context                        |
| `agentContext.meshTools`      | boolean                                                                  | `true`             | Include Mesh discovery tool documentation in agent context                         |
| `agentContext.adapterTools`   | boolean                                                                  | `true`             | Include adapter tool documentation in agent context                                |
| `agentContext.tasksTools`     | boolean                                                                  | `true`             | Include Tasks scheduler tool documentation in agent context                        |

The `agents` section configures agent storage defaults:

| Key                       | Type   | Default          | Description                                      |
| ------------------------- | ------ | ---------------- | ------------------------------------------------ |
| `agents.defaultDirectory` | string | `~/.dork/agents` | Default directory for agent storage              |
| `agents.defaultAgent`     | string | `dorkbot`        | Default agent ID used when no agent is specified |

The `extensions` section controls the extension system:

| Key                  | Type       | Default | Description                                        |
| -------------------- | ---------- | ------- | -------------------------------------------------- |
| `extensions.enabled` | `string[]` | `[]`    | Extension IDs that the user has explicitly enabled |

Extensions are discovered automatically from `<cwd>/.dork/extensions/` and the global `~/.dork/extensions/` directory. The `enabled` array controls which discovered extensions are activated. See `contributing/extension-authoring.md` for the full extension system documentation.

The `onboarding` section tracks first-time setup wizard state (`completedSteps`, `skippedSteps`, `startedAt`, `dismissedAt`). It is managed automatically by the server and should not be edited manually.

The following settings are controlled exclusively by environment variables and have no corresponding config file key:

| Environment Variable      | Default                            | Description                                                                                                                                                                                                                                                         |
| ------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DORKOS_RELAY_ENABLED`    | `true`                             | Enable the Relay message bus subsystem at the process level                                                                                                                                                                                                         |
| `DORKOS_CORS_ORIGIN`      | localhost on DORKOS_PORT/VITE_PORT | CORS allowed origin(s). Set to `*` for wildcard or a comma-separated list to override.                                                                                                                                                                              |
| `DORKOS_VERSION_OVERRIDE` | (none)                             | Override the reported server version for testing upgrade UX. When set, dev mode detection is bypassed and this value is used as the current version. Example: `DORKOS_VERSION_OVERRIDE=0.1.0` simulates running an old version so the upgrade notification appears. |

The config file also contains a `version` field (currently `1`) that the schema carries for historical reasons. The authoritative migration tracker is a separate internal key that `conf` manages automatically — see **Schema Migrations** below.

## Schema Migrations

DorkOS's user config (`~/.dork/config.json`) is owned by the [`conf`](https://github.com/sindresorhus/conf) library (v15.1.0) via the `ConfigManager` wrapper at `apps/server/src/services/core/config-manager.ts`. Zod is the authoritative schema; `z.toJSONSchema(UserConfigSchema)` bridges to conf's Ajv validation so we never hand-maintain JSON Schema.

Any change to `UserConfigSchema` (add / rename / remove / retype a field) that affects an existing user's stored data **requires a migration**. This section documents when and how.

### Why migrations matter

When a user upgrades DorkOS, their `config.json` was written by the previous version. The schema Zod now validates may differ from the shape on disk:

- **Added field with a default** — conf's defaults-merge handles this automatically on next instantiation. No migration needed.
- **Renamed field** — the old key lingers under its old name and the new key is absent. Without a migration the user loses their setting.
- **Removed field** — the old key sticks around as dead data and can trip up future type checks.
- **Type change** — a stored `number` being re-parsed as `string` will fail Zod validation and trigger the corrupt-config recovery path, losing the user's data.
- **Default value change** — sometimes OK, sometimes not. If the user never set the value explicitly, do they want the new default or their old inferred one? Usually they want the new default — but be deliberate.

Migrations run once per user, per version boundary, the first time a new DorkOS version instantiates `ConfigManager`. They are the only safe way to evolve stored data across releases.

### How `conf` handles migrations

`conf` tracks migration state **inside the config file itself**, in an internal key at `__internal__.migrations.version`. The flow is:

1. `ConfigManager` constructs `new Conf<UserConfig>({ projectVersion, migrations, ... })`.
2. `conf` reads the stored `__internal__.migrations.version` and compares it against `projectVersion`.
3. Every migration whose key satisfies `> storedVersion && <= projectVersion` (semver-ordered) runs in sequence. Each migration receives the `conf` store and may call `store.has()`, `store.get()`, `store.set()`, `store.delete()`.
4. After all applicable migrations run, `conf` updates `__internal__.migrations.version` to `projectVersion`.
5. Each migration runs at most once per user — subsequent launches see the updated internal version and skip.

`projectVersion` is the **app version**, not a schema version. Migration keys are the app versions at or after which each migration should run. A migration keyed `'0.35.0'` runs on the first launch of DorkOS 0.35.0 (or any later version, if the user skipped 0.35.0 entirely).

> `projectVersion` is not hardcoded — `ConfigManager` imports `SERVER_VERSION` from `apps/server/src/lib/version.ts` and hands it to Conf. That resolver honors `DORKOS_VERSION_OVERRIDE`, the esbuild-injected `__CLI_VERSION__`, and the `package.json` dev fallback, in that order. Migration keys line up with real release boundaries automatically — do not reintroduce a hardcoded `projectVersion` string.

### Append-only rule

**Never edit a shipped migration.** Once a migration has run on real users, its body is frozen — editing it would leave users in divergent states (those who ran the old body vs. those who ran the new one). To fix a bad migration:

1. Leave the broken migration in place (or amend its body only to be a no-op if it never shipped).
2. Append a **new** migration at the next version that reverses the damage and applies the correct change.

### Step-by-step: adding a new config field

For the guided flow, use the `.claude/skills/adding-config-fields/` skill — Claude will walk through these steps interactively. For reference, they are:

1. **Add the field to the Zod schema** in `packages/shared/src/config-schema.ts` with a `.default(...)` (make it optional only if the absence of the field is semantically meaningful).
2. **Verify `USER_CONFIG_DEFAULTS` still parses** — that constant is computed from `UserConfigSchema.parse({ version: 1 })` at import time; a required field without a default crashes on first import.
3. **Bump `projectVersion`** in `ConfigManager` constructor to the target release version.
4. **Append a migration** to the `migrations` block, keyed to the same version. Guard every `store.set/delete` with `store.has()` so the migration is idempotent.
5. **Document the field** in the Settings Reference table above. The `check-docs-changed.sh` hook will remind you at session-stop if you forget, but doing it inline is cleaner.
6. **Mirror the doc to `docs/getting-started/configuration.mdx`** if the field is user-visible.
7. **Add a test** in `apps/server/src/services/core/__tests__/config-manager.test.ts` that exercises the migration against a realistic stale-config blob.
8. **Wire a CLI flag** in `packages/cli/src/cli.ts` if the field needs one, following the precedence rule (CLI flag > env var > config > default).

### Reference example

The current migrations block at `apps/server/src/services/core/config-manager.ts:96-102`:

```typescript
migrations: {
  '1.0.0': (store) => {
    if (!store.has('version')) {
      store.set('version', 1);
    }
  },
},
```

A hypothetical migration for a future `0.35.0` release that renames `server.cwd` to `server.workingDirectory` would look like:

```typescript
migrations: {
  '1.0.0': (store) => {
    if (!store.has('version')) {
      store.set('version', 1);
    }
  },
  '0.35.0': (store) => {
    // Rename server.cwd → server.workingDirectory.
    // Idempotent: guarded by store.has() so re-running is safe.
    if (store.has('server.cwd') && !store.has('server.workingDirectory')) {
      store.set('server.workingDirectory', store.get('server.cwd'));
      store.delete('server.cwd');
    }
  },
},
```

No manual `projectVersion` bump is needed — it resolves from `SERVER_VERSION` via `lib/version.ts`, which reflects the real app version at runtime. The new field would be updated in `UserConfigSchema` and this doc's Settings Reference table in the same PR.

### Interaction with `/system:release`

The `/system:release` command includes a **config schema migration drift** check in Phase 2. When it detects that `packages/shared/src/config-schema.ts` or `apps/server/src/services/core/config-manager.ts` changed since the last tag without a matching migration entry at the target version, it offers three paths:

- **Scaffold the migration inline** — the command drafts a migration, presents it for your review, then edits `config-manager.ts` to append the entry and bump `projectVersion`. The modified file is staged into the release commit automatically.
- **Pause so you can write it manually** — exits the release cleanly; you edit `config-manager.ts`, commit, then re-run `/system:release`.
- **Mark as "no migration needed"** — for type-only changes, TSDoc updates, or added-field-with-default cases where conf's defaults-merge handles it automatically. You take responsibility; the release continues.

See `.claude/commands/system/release.md` Phase 2 for the full flow.

### Anti-patterns

- **Editing a shipped migration body.** Creates inconsistent state across users. Append a new migration instead.
- **Hardcoding `projectVersion` in the Conf constructor.** It's sourced from `SERVER_VERSION` — never pass a string literal. If the version resolver itself breaks, fix `lib/version.ts`, not `config-manager.ts`.
- **Non-idempotent migrations.** Always guard with `store.has()` / `store.get() === oldValue` so re-running the same migration (e.g., after a corrupt-recovery that reset the internal version tracker) is safe.
- **Adding a required field without a default.** `USER_CONFIG_DEFAULTS = UserConfigSchema.parse({ version: 1 })` runs at import time — a missing required field crashes the server on startup for every new install.
- **Changing `UserConfigSchema` without updating this doc or `docs/getting-started/configuration.mdx`.** Users read docs to discover what they can configure; leaving them stale is worse than not having them.

### Future work

`~/.dork/marketplaces.json` is currently owned by a hand-rolled `MarketplaceSourceManager` (in `apps/server/src/services/marketplace/marketplace-source-manager.ts`) rather than `conf`. A pending refactor will unify it onto the same pattern. When it lands, the `adding-config-fields` skill and the `/system:release` drift check both extend to cover it — no parallel system.

### server.port

The TCP port for the Express server. Must be an integer between 1024 and 65535.

```bash
dorkos config set server.port 8080
```

Equivalent CLI flag: `--port` / `-p`
Equivalent env var: `DORKOS_PORT`

### server.cwd

The default working directory for Claude Code sessions. When `null`, the server uses the current working directory at startup.

```bash
dorkos config set server.cwd /home/user/projects/myapp
```

To clear back to "use current directory":

```bash
dorkos config set server.cwd null
```

Equivalent CLI flag: `--dir` / `-d`
Equivalent env var: `DORKOS_DEFAULT_CWD`

### server.boundary

The directory boundary restricts all filesystem operations to a specific root directory. When `null` (default), the boundary is the user's home directory (`~/`). All API endpoints that accept `cwd`, `path`, or `dir` parameters validate against this boundary and return 403 if the path is outside it.

At startup, the server logs a warning if:

- The boundary is set above the home directory
- `server.cwd` is outside the configured boundary (falls back to boundary root)

```bash
dorkos config set server.boundary /home/user/projects
```

Equivalent CLI flag: `--boundary` / `-b`
Equivalent env var: `DORKOS_BOUNDARY`

### server.open

Whether to automatically open DorkOS in the default browser on startup. Defaults to `true`. Only applies in interactive terminals (non-TTY environments always skip opening).

```bash
dorkos config set server.open false
```

Equivalent CLI flag: `--no-open` (to suppress) — there is no `--open` flag since the default is already `true`
Equivalent env var: `DORKOS_OPEN`

**Open browser resolution:**

```
--no-open                # CLI flag (wins if provided, sets open=false)
DORKOS_OPEN=false        # Env var (wins if no CLI flag)
server.open: false       # config.json (wins if no env var)
true                     # Built-in default (fallback)
```

### tunnel.enabled

Whether to start an ngrok tunnel automatically when the server starts. Requires `NGROK_AUTHTOKEN` to be set (via env var or `tunnel.authtoken`).

```bash
dorkos config set tunnel.enabled true
```

Equivalent CLI flag: `--tunnel` / `-t`
Equivalent env var: `TUNNEL_ENABLED`

### tunnel.domain

A custom ngrok domain (e.g., `myapp.ngrok.io`). When `null`, ngrok assigns a random subdomain.

```bash
dorkos config set tunnel.domain myapp.ngrok.io
```

Equivalent env var: `TUNNEL_DOMAIN`

### tunnel.authtoken

The ngrok authentication token. This is a **sensitive field** -- setting it via config will produce a warning. Prefer using the `NGROK_AUTHTOKEN` environment variable instead.

```bash
# Preferred: use environment variable
export NGROK_AUTHTOKEN=your-token-here

# Alternative: store in config (triggers warning)
dorkos config set tunnel.authtoken your-token-here
```

Equivalent env var: `NGROK_AUTHTOKEN`

### tunnel.auth

HTTP basic authentication credentials for the tunnel in `user:pass` format. This is a **sensitive field** -- prefer the `TUNNEL_AUTH` environment variable.

```bash
# Preferred: use environment variable
export TUNNEL_AUTH=admin:secretpassword

# Alternative: store in config (triggers warning)
dorkos config set tunnel.auth admin:secretpassword
```

Equivalent env var: `TUNNEL_AUTH`

### logging.level

The log verbosity level for the server. Controls both console output and NDJSON file logging to `{DORK_HOME}/logs/dorkos.log`.

```bash
dorkos config set logging.level debug
```

Equivalent CLI flag: `--log-level` / `-l`
Equivalent env var: `DORKOS_LOG_LEVEL`

Log files are written as NDJSON (newline-delimited JSON) with daily rotation. When a log file is from a previous day, it's renamed to `dorkos.YYYY-MM-DD.log`. Within the same day, files exceeding the size threshold are rotated to `dorkos.YYYY-MM-DD.N.log`. Default: 500KB max size, 14 rotated files retained.

### logging.maxLogSizeKb

Maximum log file size in kilobytes before size-based rotation triggers. Range: 100–10240. Default: `500`.

```bash
dorkos config set logging.maxLogSizeKb 1024
```

### logging.maxLogFiles

Maximum number of rotated log files to retain. Range: 1–30. Default: `14`.

```bash
dorkos config set logging.maxLogFiles 7
```

### ui.theme

The UI color theme. Options: `light`, `dark`, or `system` (follows OS preference).

```bash
dorkos config set ui.theme dark
```

### mesh.scanRoots

Directories to scan for agent discovery. The Mesh subsystem is always enabled and initializes automatically on server startup. If initialization fails (e.g., SQLite errors), the server continues with graceful degradation.

When `scanRoots` is empty (default), the reconciler scans from the server's default working directory. Add explicit paths to control which directories are scanned for `.dork/agent.json` manifests.

```bash
dorkos config set mesh.scanRoots '["/home/user/projects", "/home/user/agents"]'
```

### uploads

Controls file upload limits for the `POST /api/uploads` endpoint. The upload handler reads these values dynamically on each request from the config manager.

| Key                    | Type       | Default            | Description                       |
| ---------------------- | ---------- | ------------------ | --------------------------------- |
| `uploads.maxFileSize`  | `number`   | `10485760` (10 MB) | Maximum file size in bytes        |
| `uploads.maxFiles`     | `number`   | `10`               | Maximum files per request (1--50) |
| `uploads.allowedTypes` | `string[]` | `["*/*"]`          | Allowed MIME types                |

```bash
dorkos config set uploads.maxFileSize 52428800    # 50 MB
dorkos config set uploads.maxFiles 20
```

### agentContext

Controls which tool domain blocks are injected into agent system prompts. Each toggle determines whether the corresponding tool documentation is included in the context, helping agents understand available tools.

| Key                         | Type      | Default | Description                                |
| --------------------------- | --------- | ------- | ------------------------------------------ |
| `agentContext.relayTools`   | `boolean` | `true`  | Include Relay messaging tool documentation |
| `agentContext.meshTools`    | `boolean` | `true`  | Include Mesh discovery tool documentation  |
| `agentContext.adapterTools` | `boolean` | `true`  | Include adapter tool documentation         |
| `agentContext.tasksTools`   | `boolean` | `true`  | Include Tasks scheduler tool documentation |

These can be configured globally in Settings > Tools tab, or per-agent via the agent manifest's `enabledToolGroups` field (which overrides global defaults).

```bash
dorkos config set agentContext.relayTools false
dorkos config set agentContext.tasksTools false
```

### DORKOS_RELAY_ENABLED

Process-level feature flag that enables the Relay message bus subsystem. When `true`, the server mounts the `/api/relay` routes, starts the `RelayCore`, and activates Relay-backed session messaging (POST `/api/sessions/:id/messages` publishes to `relay.agent.{sessionId}` instead of calling the runtime directly).

```bash
export DORKOS_RELAY_ENABLED=true
dorkos
```

This env var controls process-level Relay initialization and must be set before the server starts. The config file has a separate `relay.enabled` field (default `true`) that controls the config-layer toggle independently.

### DORKOS_CORS_ORIGIN

Configures the `Access-Control-Allow-Origin` header on the Express server. When unset, defaults to localhost on `DORKOS_PORT` and `VITE_PORT` (code default 4241, dev convention 6241). Set to `*` for wildcard, or a comma-separated list of origins to allow multiple production origins.

```bash
export DORKOS_CORS_ORIGIN=https://myapp.example.com
dorkos
```

There is no config file key for this setting. It must be set as an environment variable.

## Precedence

Settings are resolved in this order (highest priority first):

```
CLI flags  >  Environment variables  >  config.json  >  Built-in defaults
```

### How Precedence Works

Each setting follows the same resolution chain. The first non-empty value wins.

**Port resolution:**

```
--port 9000              # CLI flag (wins if provided)
DORKOS_PORT=8080         # Env var (wins if no CLI flag)
server.port: 5000        # config.json (wins if no env var)
4242                     # Built-in default (fallback)
```

**Working directory resolution:**

```
--dir ~/myproject        # CLI flag (wins if provided)
DORKOS_DEFAULT_CWD=...   # Env var (wins if no CLI flag)
server.cwd: /path        # config.json (wins if no env var)
process.cwd()            # Current directory (fallback)
```

**Tunnel enabled resolution:**

```
--tunnel                 # CLI flag (wins if provided)
TUNNEL_ENABLED=true      # Env var (wins if no CLI flag)
tunnel.enabled: true     # config.json (wins if no env var)
false                    # Built-in default (fallback)
```

**Log level resolution:**

```
--log-level debug           # CLI flag (wins if provided)
DORKOS_LOG_LEVEL=4          # Env var (wins if no CLI flag; numeric 0-5)
logging.level: debug        # config.json (wins if no env var)
info                        # Built-in default (fallback)
```

**Boundary resolution:**

```
--boundary /path        # CLI flag (wins if provided)
DORKOS_BOUNDARY=...     # Env var (wins if no CLI flag)
server.boundary: /path  # config.json (wins if no env var)
os.homedir()            # Home directory (fallback)
```

**Tunnel credentials** (authtoken, auth, domain) use a simpler chain: the environment variable takes priority over config.json. There are no CLI flags for these.

### Examples

Start on port 9000 regardless of config:

```bash
dorkos --port 9000
```

Set a default port in config, then override for one session:

```bash
dorkos config set server.port 5000   # Persisted default
dorkos --port 9000                   # One-time override
```

Environment variable overrides config but not CLI flag:

```bash
dorkos config set server.port 5000   # config.json
DORKOS_PORT=8080 dorkos              # Uses 8080 (env > config)
DORKOS_PORT=8080 dorkos --port 9000  # Uses 9000 (flag > env)
```

## CLI Commands

### `dorkos config`

Show all effective settings in a formatted table. Each value shows whether it comes from the config file or is a built-in default.

```bash
$ dorkos config
DorkOS Configuration (~/.dork/config.json)

  server.port          4242           (default)
  server.cwd           —              (default)
  server.boundary      —              (default)
  server.open          true           (default)
  tunnel.enabled       false          (default)
  tunnel.domain        —              (default)
  tunnel.authtoken     —              (default)
  tunnel.auth          —              (default)
  ui.theme             system         (default)
  agentContext.relayTools   true       (default)
  agentContext.meshTools    true       (default)
  agentContext.adapterTools true       (default)
  agentContext.tasksTools   true       (default)

Config file: /Users/you/.dork/config.json
```

### `dorkos config get <key>`

Get a single config value by dot-path.

```bash
$ dorkos config get server.port
4242

$ dorkos config get ui.theme
system
```

Exits with code 1 if the key does not exist.

### `dorkos config set <key> <value>`

Set a single config value. Values are automatically parsed: `true`/`false` become booleans, numeric strings become numbers, `null` becomes null.

```bash
dorkos config set server.port 8080
dorkos config set tunnel.enabled true
dorkos config set server.cwd null
```

Setting a sensitive key (`tunnel.authtoken`, `tunnel.auth`) prints a warning recommending environment variables instead.

### `dorkos config list`

Output the full config as formatted JSON. Useful for scripting and debugging.

```bash
$ dorkos config list
{
  "version": 1,
  "server": { "port": 4242, "cwd": null, "boundary": null },
  "tunnel": { "enabled": false, "domain": null, "authtoken": null, "auth": null },
  "ui": { "theme": "system" },
  "logging": { "level": "info", "maxLogSizeKb": 500, "maxLogFiles": 14 },
  "relay": { "enabled": true, "dataDir": null },
  "scheduler": { "enabled": true, "maxConcurrentRuns": 1, "timezone": null, "retentionCount": 100 },
  "mesh": { "scanRoots": [] },
  "uploads": { "maxFileSize": 10485760, "maxFiles": 10, "allowedTypes": ["*/*"] },
  "agentContext": { "relayTools": true, "meshTools": true, "adapterTools": true, "tasksTools": true }
}
```

### `dorkos config reset [key]`

Reset a specific key to its default value, or reset all settings when no key is provided.

```bash
# Reset a single key
dorkos config reset server.port
# Reset server.port to default (4242)

# Reset everything
dorkos config reset
# Reset all settings to defaults
```

### `dorkos config edit`

Open the config file in your `$EDITOR`. Falls back to `notepad` on Windows or `nano` on other platforms.

```bash
dorkos config edit
```

### `dorkos config path`

Print the absolute path to the config file. Useful in scripts.

```bash
$ dorkos config path
/Users/you/.dork/config.json
```

### `dorkos config validate`

Validate the config file against the Zod schema. Exits with code 0 if valid, code 1 if invalid.

```bash
$ dorkos config validate
Config is valid

$ dorkos config validate
Config validation failed:
  - server.port: Number must be greater than or equal to 1024
```

### `dorkos install`

Install a marketplace package into the current project.

```bash
dorkos install <package-name>
dorkos install <package-name> --marketplace <source>    # Pin to a specific source
dorkos install <package-name> --yes                     # Skip confirmation prompt
dorkos install <package-name> --force                   # Overwrite conflicting files
```

Install dispatches the appropriate per-kind flow (plugin, agent, skill-pack, or adapter) based on the package manifest's `type` field. On failure, the atomic transaction engine restores the previous state. See `contributing/marketplace-installs.md` for the full pipeline.

### `dorkos uninstall`

Remove an installed marketplace package.

```bash
dorkos uninstall <package-name>
dorkos uninstall <package-name> --purge    # Also remove package data directories
```

### `dorkos update`

Check for and optionally apply updates to installed packages. Advisory by default — reports available updates without applying them.

```bash
dorkos update                     # Check all installed packages for updates
dorkos update <package-name>      # Check a specific package
dorkos update <package-name> --apply   # Fetch and apply the update
```

### `dorkos marketplace`

Manage marketplace sources (the `marketplace.json` registries that list available packages).

```bash
dorkos marketplace list [<source>]        # List packages from all or a specific source
dorkos marketplace add <url-or-path>      # Register a new marketplace source
dorkos marketplace remove <source-name>   # Remove a registered source
dorkos marketplace refresh [<source>]     # Force-refetch marketplace.json for all or one source
```

### `dorkos cache`

Manage the marketplace package cache (content-addressable clone cache at `~/.dork/cache/`).

```bash
dorkos cache prune [--keep <N>]   # Remove old cached packages, keeping the N most recent per package
dorkos cache clear                # Wipe the entire cache
```

### `dorkos package`

Scaffold and validate DorkOS marketplace packages.

```bash
dorkos package init <name> --type <plugin|agent|skill-pack|adapter>
                                  # Scaffold a new package in ./<name>/
dorkos package validate <path>    # Validate a package directory against the manifest schema
```

See `contributing/marketplace-packages.md` for the package format and manifest reference.

### `dorkos cleanup`

Interactively remove all DorkOS data. Prompts for confirmation at each phase.

**Safety checks:**

- Verifies the DorkOS server is not running (checks `/api/health` on configured port)
- Prompts before each deletion phase

**What it removes:**

1. **Global data** (`~/.dork/`): `config.json`, `dork.db` (+ WAL/SHM), `logs/`, `relay/`
2. **Per-project data**: Each project's `.dork/` directory (discovered from the database before deletion)

Does **not** touch `~/.claude/` (Claude Code's own data).

```bash
$ dorkos cleanup
Checking if DorkOS server is running...
Server is not running.

This will remove all DorkOS data:
  - ~/.dork/ (config, database, logs, relay state)
  - .dork/ directories in discovered projects

? Remove global DorkOS data (~/.dork/)? Yes
Removed ~/.dork/

? Remove per-project .dork/ directories? Yes
Removed /home/user/myapp/.dork/
Removed /home/user/api/.dork/

Cleanup complete.
```

### `dorkos init`

Run the interactive setup wizard. Prompts for port, theme, tunnel, and working directory. If a config file already exists, asks for confirmation before overwriting.

```bash
$ dorkos init
DorkOS Setup

? Default port: 4242
? UI theme: System (follow OS)
? Enable tunnel by default? No
? Default working directory (leave empty for current directory):

Config saved to /Users/you/.dork/config.json
```

Skip all prompts and initialize with defaults:

```bash
dorkos init --yes
```

## REST API

### PATCH /api/config

Update config settings via the REST API. Accepts partial updates -- only the keys you include are changed.

**Request:**

```http
PATCH /api/config
Content-Type: application/json

{
  "server": { "port": 8080 },
  "ui": { "theme": "dark" }
}
```

**Success response (200):**

```json
{
  "success": true,
  "config": {
    "version": 1,
    "server": { "port": 8080, "cwd": null, "boundary": null },
    "tunnel": { "enabled": false, "domain": null, "authtoken": null, "auth": null },
    "ui": { "theme": "dark" },
    "logging": { "level": "info", "maxLogSizeKb": 500, "maxLogFiles": 14 },
    "relay": { "enabled": true, "dataDir": null },
    "scheduler": {
      "enabled": true,
      "maxConcurrentRuns": 1,
      "timezone": null,
      "retentionCount": 100
    },
    "mesh": { "scanRoots": [] },
    "uploads": { "maxFileSize": 10485760, "maxFiles": 10, "allowedTypes": ["*/*"] },
    "agentContext": {
      "relayTools": true,
      "meshTools": true,
      "adapterTools": true,
      "tasksTools": true
    }
  }
}
```

**Validation error (400):**

```json
{
  "error": "Validation failed",
  "details": ["server.port: Number must be greater than or equal to 1024"]
}
```

The endpoint deep-merges the patch into the current config, validates the merged result against the full schema, and only writes if validation passes. If any sensitive keys are included in the patch, the response includes a `warnings` array:

```json
{
  "success": true,
  "config": { ... },
  "warnings": ["'tunnel.authtoken' contains sensitive data. Consider using environment variables instead."]
}
```

## Error Recovery

If the config file becomes corrupt (invalid JSON, schema violations), the ConfigManager handles it automatically on startup:

1. The corrupt file is backed up to `~/.dork/config.json.bak`
2. A fresh config is created with all default values
3. A warning is printed to the console

```
Warning: Corrupt config backed up to /Users/you/.dork/config.json.bak
   Creating fresh config with defaults.
```

You can manually validate your config at any time:

```bash
dorkos config validate
```

Or reset to a known-good state:

```bash
dorkos config reset
```

## Security

Two config keys are marked as sensitive: `tunnel.authtoken` and `tunnel.auth`. These contain credentials that should not be stored in plain-text config files on shared machines.

**Recommendations:**

- Use environment variables (`NGROK_AUTHTOKEN`, `TUNNEL_AUTH`) instead of storing credentials in `config.json`
- The CLI and REST API both warn when sensitive keys are written
- The config file has standard user file permissions but is not encrypted
- Never commit `~/.dork/config.json` to version control

If you must store tunnel credentials in the config (e.g., single-user machine), be aware that they are saved as plain text in `~/.dork/config.json`.

## Docker

DorkOS provides Docker images for testing and deployment. All Docker images set `DORKOS_HOST=0.0.0.0` so that the Express server binds to all interfaces (required for Docker port forwarding).

### Running in Docker

Build and run a DorkOS container from local code:

```bash
pnpm docker:build    # Build the image
pnpm docker:run      # Run the container (maps DORKOS_PORT)
```

The `Dockerfile.run` image bundles the CLI, server, and client. Pass environment variables at runtime:

```bash
docker run --rm -p 4242:4242 \
  -e ANTHROPIC_API_KEY=your-key \
  -e DORKOS_PORT=4242 \
  dorkos:local
```

### Integration Testing

```bash
pnpm smoke:integration   # Full integration test (local tarball)
pnpm smoke:npm           # Test published npm package
pnpm smoke:docker        # CLI install smoke test only
```

### Publishing

Publish the CLI to npm:

```bash
pnpm publish:cli
```

This runs `pnpm publish --filter=dorkos`, which triggers the `prepublishOnly` script to build the CLI bundle automatically.
