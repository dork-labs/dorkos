<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/dork-labs/dorkos/main/apps/site/public/images/dork-logo-white.svg">
  <img alt="DorkOS" src="https://raw.githubusercontent.com/dork-labs/dorkos/main/apps/site/public/images/dork-logo.svg" height="52">
</picture>

&nbsp;

[![npm version](https://img.shields.io/npm/v/dorkos)](https://www.npmjs.com/package/dorkos)
[![CI](https://github.com/dork-labs/dorkos/actions/workflows/cli-smoke-test.yml/badge.svg)](https://github.com/dork-labs/dorkos/actions/workflows/cli-smoke-test.yml)
[![license](https://img.shields.io/npm/l/dorkos)](LICENSE)

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

![DorkOS Console](https://raw.githubusercontent.com/dork-labs/dorkos/main/apps/site/public/images/dorkos-screenshot.png)

## What DorkOS Does

It's 7am. CI has been red since 2:47am. A dependency update cascaded across three repos. Your agent could have caught this overnight, fixed it, and sent you a Telegram message. Instead, the terminal was closed. The agent wasn't running.

DorkOS gives your agents what they're missing: scheduling, communication, and coordination. The intelligence comes from the agents. Everything else comes from DorkOS.

### Tasks - Scheduling

Cron-based and on-demand agent execution, independent of your IDE or terminal. Your agents ship code, triage issues, and run audits on schedule. You wake up to completed pull requests.

- File-based task definitions alongside your code
- Isolated sessions per run with full history
- Configurable concurrency limits
- Overrun protection prevents duplicate runs

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
- `Cmd+K` / `Ctrl+K` command palette with agent switching and fuzzy search
- Real-time sync across multiple clients
- Available in any browser or embedded in Obsidian

## Architecture

DorkOS is a Turborepo monorepo with a hexagonal architecture. A `Transport` interface decouples the React client from its backend, with adapters for HTTP/SSE (standalone web) and in-process (Obsidian plugin).

| Package           | Description                                    |
| ----------------- | ---------------------------------------------- |
| `apps/client`     | React 19 SPA (Vite 6, Tailwind 4, shadcn/ui)   |
| `apps/server`     | Express API with Claude Agent SDK integration  |
| `apps/site`       | Marketing site and docs (Next.js 16, Fumadocs) |
| `packages/cli`    | Publishable npm CLI (esbuild bundle)           |
| `packages/shared` | Zod schemas, types, transport interface        |
| `packages/db`     | Drizzle ORM schemas (SQLite)                   |
| `packages/relay`  | Inter-agent message bus                        |
| `packages/mesh`   | Agent discovery and registry                   |

## Documentation

- [dorkos.ai/docs](https://dorkos.ai/docs): User-facing guides and API reference
- [Architecture Overview](contributing/architecture.md): Hexagonal architecture, Transport interface, module layout
- [API Reference](contributing/api-reference.md): OpenAPI spec, endpoints, SSE streaming protocol
- [Design System](contributing/design-system.md): Color palette, typography, spacing, motion specs
- [AGENTS.md](AGENTS.md): Comprehensive technical reference

Interactive API docs at `/api/docs` (Scalar UI) and raw OpenAPI spec at `/api/openapi.json`.

## Development

```bash
git clone https://github.com/dork-labs/dorkos.git
cd dorkos
pnpm install
cp .env.example .env  # Add your ANTHROPIC_API_KEY
pnpm dev
```

This starts the Express server on port 6242 and the Vite dev server on port 6241.

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

MIT-licensed. Open source. Runs on your machine. Your agents, your data, your rules.

Choose your permission mode, from approve-every-tool-call to fully autonomous. Every session is recorded locally. When your agent runs overnight, you'll see exactly what it did in the morning.

- [Documentation](https://dorkos.ai/docs)
- [Changelog](https://dorkos.ai/docs/changelog)
- [Issues](https://github.com/dork-labs/dorkos/issues)

## License

[MIT](LICENSE)
