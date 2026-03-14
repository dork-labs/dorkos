<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/dork-labs/dorkos/main/apps/site/public/images/dork-logo-white.svg">
  <img alt="DorkOS" src="https://raw.githubusercontent.com/dork-labs/dorkos/main/apps/site/public/images/dork-logo.svg" height="52">
</picture>

&nbsp;

[![npm version](https://img.shields.io/npm/v/dorkos)](https://www.npmjs.com/package/dorkos)
[![CI](https://github.com/dork-labs/dorkos/actions/workflows/cli-smoke-test.yml/badge.svg)](https://github.com/dork-labs/dorkos/actions/workflows/cli-smoke-test.yml)
[![license](https://img.shields.io/npm/l/dorkos)](https://github.com/dork-labs/dorkos/blob/main/LICENSE)

The operating system for autonomous AI agents. Scheduling, messaging, agent discovery, and a browser-based command center. One person can ship like a team.

## Install

```bash
npm install -g dorkos
```

## Quick Start

```bash
export ANTHROPIC_API_KEY=your-key-here
dorkos
```

Your browser opens. You're looking at every Claude Code session across all your projects: sessions you started from the CLI, from VS Code, from anywhere. One place. Every session. Already there.

## What DorkOS Does

It's 7am. CI has been red since 2:47am. A dependency update cascaded across three repos. Your agent could have caught this overnight, fixed it, and sent you a Telegram message. Instead, the terminal was closed. The agent wasn't running.

DorkOS gives your agents what they're missing: scheduling, communication, and coordination. The intelligence comes from the agents. Everything else comes from DorkOS.

### Pulse - Scheduling

Cron-based agent execution, independent of your IDE or terminal. Your agents ship code, triage issues, and run audits on schedule. You wake up to completed pull requests.

- Overrun protection prevents duplicate runs
- Isolated sessions per run with full history
- Configurable concurrency limits
- Approval gates for agent-created schedules

### Relay - Communication

Built-in messaging between your agents and the channels you already use. Telegram, webhooks, browser. Agents reach you where you are. Agents can also message each other across project boundaries.

- Telegram and webhook adapters built in
- Add new channels with a plugin, no custom bots required
- Messages persist when terminals close
- Your research agent can notify your coding agent. No copy-paste required.

### Mesh - Agent Discovery

Scans your projects and finds agent-capable directories. You approve which agents join the network. They coordinate through channels you define.

- Finds Claude Code, Cursor, and Codex projects automatically
- Each agent gets an identity: name, color, icon, purpose
- Agents know about each other: what they can do and how to reach them
- From solo agents to a coordinated team

### Console - Browser UI

Your agents have names, colors, and status. Glance at your browser tabs and know which ones are working, which are done, and which need your attention.

Start a session from the browser. Check on it from your phone. Resume it from inside Obsidian. Every session, regardless of which client started it, visible in one place.

- Rich markdown rendering with full session history
- Approve or deny tool calls from any device
- Real-time sync across multiple clients
- Available in any browser or embedded in Obsidian

## CLI Reference

```bash
dorkos                        # Start the server
dorkos --port 8080            # Custom port
dorkos --dir ~/projects       # Custom working directory
dorkos --tunnel               # Enable remote access via ngrok
dorkos config                 # Show all settings
dorkos config set <key> <val> # Update a setting
dorkos init                   # Interactive setup wizard
dorkos init --yes             # Accept all defaults
dorkos cleanup                # Remove all DorkOS data
```

### Flags

| Flag | Description |
|---|---|
| `-p, --port <port>` | Port to listen on (default: 4242) |
| `-d, --dir <path>` | Working directory |
| `-b, --boundary <path>` | Directory boundary (default: home directory) |
| `-t, --tunnel` | Enable ngrok tunnel for remote access |
| `-l, --log-level <level>` | Log level (`fatal`, `error`, `warn`, `info`, `debug`, `trace`) |

### Config Subcommands

| Command | Description |
|---|---|
| `dorkos config` | Show all effective settings |
| `dorkos config get <key>` | Get a single value |
| `dorkos config set <key> <value>` | Set a single value |
| `dorkos config list` | Full JSON output |
| `dorkos config reset [key]` | Reset to defaults |
| `dorkos config edit` | Open in `$EDITOR` |
| `dorkos config path` | Print config file location |
| `dorkos config validate` | Check validity |

## Environment Variables

### Required

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic API key |

### Optional

| Variable | Default | Description |
|---|---|---|
| `DORKOS_PORT` | `4242` | Server port |
| `DORKOS_HOST` | `localhost` | Server host (use `0.0.0.0` for Docker) |
| `DORKOS_DEFAULT_CWD` | Current directory | Default working directory for sessions |
| `DORKOS_BOUNDARY` | Home directory | Directory boundary root |
| `LOG_LEVEL` | `info` | Log verbosity |

### Remote Access

| Variable | Description |
|---|---|
| `TUNNEL_ENABLED` | Set to `true` to enable ngrok tunnel |
| `NGROK_AUTHTOKEN` | Your ngrok authentication token |
| `TUNNEL_DOMAIN` | Custom tunnel domain (optional) |
| `TUNNEL_AUTH` | Basic auth in `user:pass` format (optional) |

## Docker

```bash
docker build -f Dockerfile.run --build-arg INSTALL_MODE=npm -t dorkos .
docker run --rm -p 4242:4242 \
  -e ANTHROPIC_API_KEY=your-key-here \
  -e DORKOS_HOST=0.0.0.0 \
  dorkos
```

## Updating

DorkOS checks for new versions on startup and displays an update notice when one is available. Check your current version:

```bash
dorkos --version
```

Update to the latest release:

```bash
npm install -g dorkos@latest
# or
pnpm add -g dorkos@latest
```

For Homebrew, Docker, and other update methods, see the [full upgrade guide](https://dorkos.ai/docs/getting-started/installation#updating).

## API Documentation

Interactive API docs at `/api/docs` (Scalar UI) and raw OpenAPI spec at `/api/openapi.json`.

## Open Source

MIT-licensed. Open source. Runs on your machine. Your agents, your data, your rules.

Choose your permission mode, from approve-every-tool-call to fully autonomous. Every session is recorded locally. When your agent runs overnight, you'll see exactly what it did in the morning.

- [Documentation](https://dorkos.ai/docs)
- [Changelog](https://dorkos.ai/docs/changelog)
- [GitHub](https://github.com/dork-labs/dorkos)
- [Issues](https://github.com/dork-labs/dorkos/issues)

## License

[MIT](https://github.com/dork-labs/dorkos/blob/main/LICENSE)
