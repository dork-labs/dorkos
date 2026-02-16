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

## Settings Reference

| Key               | Type                           | Default   | Description                                |
| ----------------- | ------------------------------ | --------- | ------------------------------------------ |
| `server.port`     | integer (1024--65535)          | `4242`    | Port the Express server listens on         |
| `server.cwd`      | string \| null                 | `null`    | Default working directory for sessions     |
| `tunnel.enabled`  | boolean                        | `false`   | Enable ngrok tunnel on startup             |
| `tunnel.domain`   | string \| null                 | `null`    | Custom ngrok domain                        |
| `tunnel.authtoken`| string \| null                 | `null`    | ngrok auth token (sensitive)               |
| `tunnel.auth`     | string \| null                 | `null`    | HTTP basic auth for tunnel, `user:pass` format (sensitive) |
| `ui.theme`        | `"light"` \| `"dark"` \| `"system"` | `"system"` | UI color theme                           |

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

### ui.theme

The UI color theme. Options: `light`, `dark`, or `system` (follows OS preference).

```bash
dorkos config set ui.theme dark
```

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
  tunnel.enabled       false          (default)
  tunnel.domain        —              (default)
  tunnel.authtoken     —              (default)
  tunnel.auth          —              (default)
  ui.theme             system         (default)

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
  "server": {
    "port": 4242,
    "cwd": null
  },
  "tunnel": {
    "enabled": false,
    "domain": null,
    "authtoken": null,
    "auth": null
  },
  "ui": {
    "theme": "system"
  }
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
    "server": { "port": 8080, "cwd": null },
    "tunnel": { "enabled": false, "domain": null, "authtoken": null, "auth": null },
    "ui": { "theme": "dark" }
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
