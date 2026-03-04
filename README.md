# DorkOS

[![npm version](https://img.shields.io/npm/v/dorkos)](https://www.npmjs.com/package/dorkos)
[![CI](https://github.com/dork-labs/dorkos/actions/workflows/cli-smoke-test.yml/badge.svg)](https://github.com/dork-labs/dorkos/actions/workflows/cli-smoke-test.yml)
[![license](https://img.shields.io/npm/l/dorkos)](LICENSE)

The operating system for autonomous AI agents. Scheduling, messaging, agent discovery, and a browser-based command center — so one person can ship like a team.

## Install

```bash
npm install -g dorkos
```

## Quick Start

```bash
export ANTHROPIC_API_KEY=your-key-here
dorkos
```

Your browser opens. You're looking at every Claude Code session across all your projects — sessions you started from the CLI, from VS Code, from anywhere. One place. Every session. Already there.

![DorkOS — Web interface for Claude Code](https://raw.githubusercontent.com/dork-labs/dorkos/main/meta/hero.png)

## What DorkOS Does

DorkOS gives your AI agents what they're missing: scheduling, communication, coordination, and a unified interface. The intelligence comes from the agents. Everything else comes from DorkOS.

### Pulse — Scheduling

Cron-based agent execution, independent of your IDE or terminal. Your agents ship code, triage issues, and run audits on schedule. You wake up to completed pull requests.

- Overrun protection prevents duplicate runs
- Isolated sessions per run with full history
- Configurable concurrency limits
- Approval gates for agent-created schedules

### Relay — Communication

Built-in messaging between your agents and the channels you already use. Telegram, webhooks, browser — agents send notifications to where you are. Agents can also message each other across project boundaries.

- Telegram and webhook adapters built in
- Plugin system for adding new channels
- Messages persist even when terminals close

### Mesh — Agent Discovery

Scans your projects and finds agent-capable directories automatically. You approve which agents join the network. They coordinate through governed channels. Always active — no feature flag required.

- Pluggable discovery strategies (Claude Code, Cursor, Codex)
- `.dork/agent.json` identity manifests
- Network topology with namespace isolation
- Access control rules enforced by Relay

### Console — Browser UI

Agents are the primary organizational unit. Switch between agents with `Cmd+K` / `Ctrl+K`, see each agent's sessions, and access features and commands from a unified command palette. Chat in rich markdown, approve or deny tool calls, and sync across devices in real time.

## Architecture

DorkOS is a Turborepo monorepo with a hexagonal architecture. A `Transport` interface decouples the React client from its backend, with adapters for HTTP/SSE (standalone web) and in-process (Obsidian plugin).

| Package | Description |
|---|---|
| `apps/client` | React 19 SPA (Vite 6, Tailwind 4, shadcn/ui) |
| `apps/server` | Express API with Claude Agent SDK integration |
| `apps/site` | Marketing site and docs (Next.js 16, Fumadocs) |
| `packages/cli` | Publishable npm CLI (esbuild bundle) |
| `packages/shared` | Zod schemas, types, transport interface |
| `packages/db` | Drizzle ORM schemas (SQLite) |
| `packages/relay` | Inter-agent message bus |
| `packages/mesh` | Agent discovery and registry |

## Documentation

- [dorkos.ai/docs](https://dorkos.ai/docs) — User-facing guides and API reference
- [Architecture Overview](contributing/architecture.md) — Hexagonal architecture, Transport interface, module layout
- [API Reference](contributing/api-reference.md) — OpenAPI spec, endpoints, SSE streaming protocol
- [Design System](contributing/design-system.md) — Color palette, typography, spacing, motion specs
- [CLAUDE.md](CLAUDE.md) — Comprehensive technical reference

Interactive API docs at `/api/docs` (Scalar UI) and raw OpenAPI spec at `/api/openapi.json`.

## Development

```bash
git clone https://github.com/dork-labs/dorkos.git
cd dorkos
pnpm install
cp .env.example .env  # Add your ANTHROPIC_API_KEY
pnpm dev
```

This starts the Express server on port 4242 and the Vite dev server on port 4241.

### Docker

```bash
docker build -f Dockerfile.run --build-arg INSTALL_MODE=npm -t dorkos .
docker run --rm -p 4242:4242 \
  -e ANTHROPIC_API_KEY=your-key-here \
  -e DORKOS_HOST=0.0.0.0 \
  dorkos
```

## Contributing

We welcome contributions. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full contributor guide.

## Open Source

MIT-licensed. Runs on your machine. Your agents, your data, your rules.

- [Documentation](https://dorkos.ai/docs)
- [Changelog](https://dorkos.ai/docs/changelog)
- [Issues](https://github.com/dork-labs/dorkos/issues)

## License

[MIT](LICENSE)
