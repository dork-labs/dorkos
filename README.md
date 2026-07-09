<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/dork-labs/dorkos/main/apps/site/public/images/dork-logo-white.svg">
  <img alt="DorkOS" src="https://raw.githubusercontent.com/dork-labs/dorkos/main/apps/site/public/images/dork-logo.svg" height="52">
</picture>

&nbsp;

[![npm version](https://img.shields.io/npm/v/dorkos)](https://www.npmjs.com/package/dorkos)
[![CI](https://github.com/dork-labs/dorkos/actions/workflows/cli-smoke-test.yml/badge.svg)](https://github.com/dork-labs/dorkos/actions/workflows/cli-smoke-test.yml)
[![license](https://img.shields.io/npm/l/dorkos)](LICENSE)
[![newsletter](https://img.shields.io/badge/newsletter-subscribe-e8590c)](https://dorkos.ai/newsletter)

The command center for the AI coding agents you already run. See every session, approve what your agents do, and put them on a schedule. One place, on your own machine.

## Who this is for

You run AI coding agents like Claude Code, and you start them from a lot of places: your terminal, your editor, a script. DorkOS gathers all of those sessions into one dashboard in your browser, so you can see what each agent is doing and step in when it matters.

## Install

```bash
npm install -g dorkos
```

## Quick Start

```bash
export ANTHROPIC_API_KEY=your-key-here
dorkos
```

Your browser opens. You're looking at every Claude Code session across all your projects: sessions you started from your terminal, from VS Code, from anywhere. One place. Every session. Already there.

![DorkOS Console](https://raw.githubusercontent.com/dork-labs/dorkos/main/apps/site/public/images/dorkos-screenshot.png)

## What DorkOS Does

It's 7am. Your automated tests have been failing since 2:47am, because an overnight dependency update broke three of your projects. Your agent could have caught this, fixed it, and sent you a message. Instead, the terminal was closed. The agent wasn't running.

DorkOS gives your agents what they're missing: a schedule, a way to reach you, and a way to find each other. The intelligence comes from the agents. Everything else comes from DorkOS.

### Tasks: run agents on a schedule

Set an agent to run at a time you pick (like every morning at 9am) or on demand, without keeping a terminal open. Your agents ship code, triage issues, and run audits while you sleep. You wake up to finished work.

- Define tasks in files that live next to your code
- Skip a run if the last one is still going, so you never get duplicates
- Every run gets its own session with full history

### Relay: let agents reach you

Your agents can message you on the channels you already use: Telegram, a webhook, or the browser. When an agent finishes or gets stuck, you hear about it where you are. Agents can also message each other across projects.

- Telegram and webhook support built in
- Add a new channel with a plugin, no custom bot required
- Messages wait for you even after you close the terminal

### Mesh: find your agents

DorkOS scans your projects and finds the folders that hold agents. You choose which ones to add. Each agent gets an identity you can recognize at a glance: a name, a color, an icon, and a purpose.

- Finds Claude Code, Codex, and other agent projects for you
- You approve which agents join before anything connects
- Each agent knows what the others can do and how to reach them

### Console: watch it all in your browser

Your agents have names, colors, and a status. Glance at your browser and know which ones are working, which are done, and which need you.

Start a session in the browser. Check on it from your phone. Every session shows up in one place, whichever tool started it.

- Full session history with rich markdown
- Approve or deny an agent's actions from any device
- Live updates across every browser tab you have open

### Extensions

Agents can build and install extensions that add new features. Each extension brings its own settings and secrets, all managed from the dashboard.

### Connect other AI tools (MCP)

DorkOS speaks MCP (the open standard that lets AI tools share tools with each other), so other agents like Claude Code and Cursor can use the DorkOS tools directly. You can lock it behind a key with `MCP_API_KEY`.

```bash
claude mcp add dorkos --transport http http://localhost:4242/mcp
```

## Docker

```bash
docker build -f Dockerfile.run --build-arg INSTALL_MODE=npm -t dorkos .
docker run --rm -p 4242:4242 \
  -e ANTHROPIC_API_KEY=your-key-here \
  -e DORKOS_HOST=0.0.0.0 \
  dorkos
```

## Open Source

MIT-licensed and open source. It runs on your machine: your agents, your data, your rules.

Choose how much control you want, from approving every single action to letting an agent run on its own. Every session is saved on your computer, so when an agent works overnight you can see exactly what it did in the morning.

- [Documentation](https://dorkos.ai/docs)
- [Changelog](https://dorkos.ai/docs/changelog)
- [Issues](https://github.com/dork-labs/dorkos/issues)

## Want to hack on DorkOS?

DorkOS is a Turborepo monorepo: one repository that holds the browser client, the server, the marketing site, and the shared packages. To run it from source:

```bash
git clone https://github.com/dork-labs/dorkos.git
cd dorkos
pnpm install
cp .env.example .env  # Add your ANTHROPIC_API_KEY
pnpm dev
```

This starts the server on port 6242 and the browser client on port 6241.

For how the pieces fit together, start with the [architecture guide](contributing/architecture.md). [CONTRIBUTING.md](CONTRIBUTING.md) has the full contributor workflow, [DOCS.md](DOCS.md) maps where every kind of documentation lives, and [AGENTS.md](AGENTS.md) is the deep technical reference.

## License

[MIT](LICENSE)
</content>
</invoke>
