# dorkos

[![npm version](https://img.shields.io/npm/v/dorkos)](https://www.npmjs.com/package/dorkos)
[![license](https://img.shields.io/npm/l/dorkos)](https://github.com/dork-labs/dorkos/blob/main/LICENSE)

Web-based interface and REST/SSE API for Claude Code, built with the Claude Agent SDK.

## What is DorkOS?

DorkOS provides a browser-based chat UI for interacting with Claude Code sessions. It includes tool approval flows, slash command discovery, cross-client session sync, and a full REST/SSE API — all powered by the Claude Agent SDK.

## Installation

```bash
npm install -g dorkos
```

## Usage

```bash
dorkos
```

The server starts on port 4242 and opens your browser automatically. You'll see the DorkOS chat interface where you can start Claude Code sessions, approve tool calls, and use slash commands.

## Updating

```bash
npm install -g dorkos@latest
```

DorkOS checks for updates automatically on startup and displays a notification when a new version is available. You can also check your current version with:

```bash
dorkos --version
```

## CLI Flags

| Flag | Description |
|---|---|
| `-p, --port <port>` | Port to listen on (default: 4242) |
| `-d, --dir <path>` | Working directory (default: current directory) |
| `-b, --boundary <path>` | Directory boundary (default: home directory) |
| `-t, --tunnel` | Enable ngrok tunnel |
| `-l, --log-level <level>` | Log level (`fatal`, `error`, `warn`, `info`, `debug`, `trace`) |
| `-h, --help` | Show help message |
| `-v, --version` | Show version number |

## Subcommands

| Command | Description |
|---|---|
| `dorkos config` | Show all effective settings |
| `dorkos config get <key>` | Get a single config value |
| `dorkos config set <key> <value>` | Set a single config value |
| `dorkos config list` | Full JSON output |
| `dorkos config reset [key]` | Reset to defaults |
| `dorkos config edit` | Open config in `$EDITOR` |
| `dorkos config path` | Print config file location |
| `dorkos config validate` | Check config validity |
| `dorkos init` | Interactive setup wizard |
| `dorkos init --yes` | Accept all defaults |

## Configuration

### Required

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic API key |

### Optional

| Variable | Default | Description |
|---|---|---|
| `DORKOS_PORT` | `4242` | Server port |
| `DORKOS_DEFAULT_CWD` | Current directory | Default working directory for sessions |
| `DORKOS_BOUNDARY` | Home directory | Directory boundary root (restricts filesystem access) |
| `LOG_LEVEL` | `info` | Log verbosity (`fatal`, `error`, `warn`, `info`, `debug`, `trace`) |

### Tunnel Configuration

DorkOS supports ngrok tunnels for remote access:

| Variable | Description |
|---|---|
| `TUNNEL_ENABLED` | Set to `true` to enable ngrok tunnel |
| `NGROK_AUTHTOKEN` | Your ngrok authentication token |
| `TUNNEL_DOMAIN` | Custom tunnel domain (optional) |
| `TUNNEL_AUTH` | Basic auth in `user:pass` format (optional) |

## Config Directory

DorkOS creates a `~/.dork/` directory on startup for configuration storage. Log files are written to `~/.dork/logs/dorkos.log` as NDJSON.

## API Documentation

When running, DorkOS serves interactive API documentation at `/api/docs` (powered by Scalar UI) and the raw OpenAPI spec at `/api/openapi.json`.

## Links

- [Documentation](https://dorkos.ai/docs)
- [Changelog](https://dorkos.ai/docs/changelog)
- [GitHub](https://github.com/dork-labs/dorkos)
- [Issues](https://github.com/dork-labs/dorkos/issues)

## License

[MIT](https://github.com/dork-labs/dorkos/blob/main/LICENSE)
