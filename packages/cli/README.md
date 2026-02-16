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

### Tunnel Configuration

DorkOS supports ngrok tunnels for remote access:

| Variable | Description |
|---|---|
| `TUNNEL_ENABLED` | Set to `true` to enable ngrok tunnel |
| `NGROK_AUTHTOKEN` | Your ngrok authentication token |
| `TUNNEL_DOMAIN` | Custom tunnel domain (optional) |
| `TUNNEL_AUTH` | Basic auth in `user:pass` format (optional) |

## Config Directory

DorkOS creates a `~/.dork/` directory on startup for configuration storage.

## API Documentation

When running, DorkOS serves interactive API documentation at `/api/docs` (powered by Scalar UI) and the raw OpenAPI spec at `/api/openapi.json`.

## Links

- [Documentation](https://github.com/dork-labs/dorkos/tree/main/docs)
- [GitHub](https://github.com/dork-labs/dorkos)
- [Issues](https://github.com/dork-labs/dorkos/issues)

## License

[MIT](https://github.com/dork-labs/dorkos/blob/main/LICENSE)
