# dorkos

Web-based interface and REST/SSE API for [Claude Code](https://docs.anthropic.com/en/docs/claude-code), built with the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk).

Provides a chat UI for interacting with Claude Code sessions, with tool approval flows, slash command discovery, and real-time session sync across multiple clients.

## Prerequisites

- **Node.js** >= 18
- **Claude Code CLI** installed and available in your PATH:
  ```bash
  npm install -g @anthropic-ai/claude-code
  ```

## Install

```bash
npm install -g dorkos
```

## Usage

```bash
# Start DorkOS (opens on http://localhost:6942)
dorkos

# Custom port
dorkos --port 8080

# Set working directory
dorkos --dir ~/projects/myapp

# Enable ngrok tunnel for remote access
NGROK_AUTHTOKEN=your_token dorkos --tunnel
```

## Options

| Flag | Short | Description | Default |
|------|-------|-------------|---------|
| `--port <port>` | `-p` | Port to listen on | `6942` |
| `--tunnel` | `-t` | Enable ngrok tunnel | `false` |
| `--dir <path>` | `-d` | Working directory | Current directory |
| `--help` | `-h` | Show help message | |
| `--version` | `-v` | Show version number | |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `NGROK_AUTHTOKEN` | ngrok auth token (required for `--tunnel`) |
| `TUNNEL_AUTH` | HTTP basic auth for tunnel (`user:pass`) |
| `TUNNEL_DOMAIN` | Custom ngrok domain |

## Features

- Chat UI for Claude Code with rich markdown rendering
- Tool approval/deny flow for safe AI interactions
- Slash command discovery from `.claude/commands/`
- SSE streaming for real-time responses
- Session sync across multiple clients (including CLI)
- REST API with OpenAPI docs at `/api/docs`

## API

Once running, DorkOS exposes:

- **`GET /api/sessions`** - List all sessions
- **`POST /api/sessions`** - Create a new session
- **`GET /api/sessions/:id/messages`** - Get message history
- **`POST /api/sessions/:id/messages`** - Send a message (SSE stream)
- **`GET /api/sessions/:id/stream`** - Subscribe to session changes (SSE)
- **`GET /api/docs`** - Interactive API documentation (Scalar)
- **`GET /api/openapi.json`** - OpenAPI specification

## License

MIT
