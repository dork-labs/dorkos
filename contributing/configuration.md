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
| `~/.dork/pulse.db`            | SQLite database for Pulse scheduler state (WAL mode)           |
| `~/.dork/schedules.json`      | JSON snapshot of Pulse schedules (alongside pulse.db)          |
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
| `tunnel.enabled`              | boolean                                                                  | `false`            | Enable ngrok tunnel on startup                                                     |
| `tunnel.domain`               | string \| null                                                           | `null`             | Custom ngrok domain                                                                |
| `tunnel.authtoken`            | string \| null                                                           | `null`             | ngrok auth token (sensitive)                                                       |
| `tunnel.auth`                 | string \| null                                                           | `null`             | HTTP basic auth for tunnel, `user:pass` format (sensitive)                         |
| `logging.level`               | `"fatal"` \| `"error"` \| `"warn"` \| `"info"` \| `"debug"` \| `"trace"` | `"info"`           | Log verbosity level                                                                |
| `logging.maxLogSizeKb`        | integer (100--10240)                                                     | `500`              | Maximum log file size in KB before rotation                                        |
| `logging.maxLogFiles`         | integer (1--30)                                                          | `14`               | Number of rotated log files to retain                                              |
| `ui.theme`                    | `"light"` \| `"dark"` \| `"system"`                                      | `"system"`         | UI color theme                                                                     |
| `relay.enabled`               | boolean                                                                  | `true`             | Enable Relay subsystem (config-level toggle, distinct from `DORKOS_RELAY_ENABLED`) |
| `relay.dataDir`               | string \| null                                                           | `null`             | Override Relay data directory (`null` = default under `DORK_HOME`)                 |
| `scheduler.enabled`           | boolean                                                                  | `true`             | Enable Pulse scheduler subsystem (config-level toggle)                             |
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
| `agentContext.pulseTools`     | boolean                                                                  | `true`             | Include Pulse scheduler tool documentation in agent context                        |

The `onboarding` section tracks first-time setup wizard state (`completedSteps`, `skippedSteps`, `startedAt`, `dismissedAt`). It is managed automatically by the server and should not be edited manually.

The following settings are controlled exclusively by environment variables and have no corresponding config file key:

| Environment Variable      | Default                            | Description                                                                                                                                                                                                                                                         |
| ------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DORKOS_RELAY_ENABLED`    | `true`                             | Enable the Relay message bus subsystem at the process level                                                                                                                                                                                                         |
| `DORKOS_CORS_ORIGIN`      | localhost on DORKOS_PORT/VITE_PORT | CORS allowed origin(s). Set to `*` for wildcard or a comma-separated list to override.                                                                                                                                                                              |
| `DORKOS_VERSION_OVERRIDE` | (none)                             | Override the reported server version for testing upgrade UX. When set, dev mode detection is bypassed and this value is used as the current version. Example: `DORKOS_VERSION_OVERRIDE=0.1.0` simulates running an old version so the upgrade notification appears. |

The config file also contains a `version` field (always `1`) used for schema migrations.

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
| `agentContext.pulseTools`   | `boolean` | `true`  | Include Pulse scheduler tool documentation |

These can be configured globally in Settings > Tools tab, or per-agent via the agent manifest's `enabledToolGroups` field (which overrides global defaults).

```bash
dorkos config set agentContext.relayTools false
dorkos config set agentContext.pulseTools false
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
  tunnel.enabled       false          (default)
  tunnel.domain        —              (default)
  tunnel.authtoken     —              (default)
  tunnel.auth          —              (default)
  ui.theme             system         (default)
  agentContext.relayTools   true       (default)
  agentContext.meshTools    true       (default)
  agentContext.adapterTools true       (default)
  agentContext.pulseTools   true       (default)

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
  "agentContext": { "relayTools": true, "meshTools": true, "adapterTools": true, "pulseTools": true }
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
      "pulseTools": true
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
