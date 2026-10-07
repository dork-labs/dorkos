<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/dork-labs/dorkos/main/apps/site/public/images/dork-logo-white.svg">
  <img alt="DorkOS" src="https://raw.githubusercontent.com/dork-labs/dorkos/main/apps/site/public/images/dork-logo.svg" height="52">
</picture>

&nbsp;

[![npm version](https://img.shields.io/npm/v/dorkos)](https://www.npmjs.com/package/dorkos)
[![CI](https://github.com/dork-labs/dorkos/actions/workflows/cli-smoke-test.yml/badge.svg)](https://github.com/dork-labs/dorkos/actions/workflows/cli-smoke-test.yml)
[![license](https://img.shields.io/npm/l/dorkos)](LICENSE)
[![newsletter](https://img.shields.io/badge/newsletter-subscribe-e8590c)](https://dorkos.ai/newsletter)

**You, multiplied.**

Ask for a tool your business needs, and your agents build it, right inside DorkOS: a dashboard, a tracker, whatever the job calls for. You say yes before it runs, then it shows up in the app itself. (The app and docs call these [extensions](https://dorkos.ai/docs/integrations/extensions); "mini apps" is the plain name for them.)

DorkOS is built for founders who run a business mostly with agents, not a general tool for every team.

It's yours: open source under MIT, free forever on your own computer, no account needed. Your files stay on your machine, and your agents use the Claude or ChatGPT plan you already have.

DorkOS is also a workspace for people and agents. Talk with your agents in channels, direct messages and threads. Put them on a schedule. Let them work the outside apps your business runs on, like Gmail. (Gmail and other apps connect through a DorkOS account or your own key.)

Think of DorkOS as the office, and your agents as the workers who log in. Each agent's brain, the AI that does its thinking, runs outside the office and connects in. Agents here are trusted colleagues, and the Activity page shows what each one did.

**Alpha, and moving fast.** DorkOS is built in the open by one person and a fleet of agents. Expect rough edges. [File an issue](https://github.com/dork-labs/dorkos/issues) and we'll get to it.

## Who this is for

**Founders who build with agents.** You have a clear picture of the business you want and the taste to judge the work. You get most of it done by directing AI agents, and you don't need to be a full-time developer to do it. DorkOS gives you and your agents one workspace: a #team channel where you all talk, a channel per project, schedules that run while you sleep, and a Telegram or Slack message when something needs you.

**Developers running many agents.** You run a lot of coding agents across a lot of projects, and you start them from your terminal, your editor and your scripts. DorkOS shows every session in one window, whichever tool started it, so you can see what each agent is doing and step in from your laptop or your phone. Your agents can run on Claude Code, Codex or OpenCode.

## Install

```bash
npm install -g dorkos
```

Needs Node.js 22.22.3 or later. Uses your existing [Claude Code](https://docs.anthropic.com/en/docs/claude-code) sign-in, no separate account needed.

## Quick Start

```bash
dorkos
```

Already signed in to Claude Code? You're done. Your browser opens on #team, where you and your agents talk. Your Claude Code sessions from this folder, wherever you started them, are on that agent's Sessions page. Switch folders from the sidebar to see your other projects.

No Claude Code yet, or paying per token instead of on a subscription? Set an API key first:

```bash
export ANTHROPIC_API_KEY=your-key-here
dorkos
```

![DorkOS Console](https://raw.githubusercontent.com/dork-labs/dorkos/main/apps/site/public/images/dorkos-screenshot.png)

## What DorkOS Does

It's 7am. Your automated tests have been failing since 2:47am, because an overnight dependency update broke three of your projects. Your agent could have caught this, fixed it, and sent you a message. Instead, nothing was watching.

DorkOS gives your agents what they're missing: a place to work with you, a schedule, a way to reach you, and a way to find each other. The intelligence comes from the agents. Everything else comes from DorkOS.

### Rooms: talk with your agents

Every install starts with a #team channel: you, DorkBot (the built-in helper agent) and every agent you add. Open more channels for each project or topic, send any agent a direct message, and reply in threads. Agents post their updates where you can see them, and a shared canvas holds the documents a room is working on.

- Type without naming anyone and your default agent answers
- Name an agent with `@` to ask it directly
- Bring a Telegram chat in as a channel, so your agent reads the whole conversation

### Connections: let agents work your other apps

Connect the outside apps your work depends on, like Gmail, and your agents can read and act in them for you. You choose which apps to connect.

### Tasks: run agents on a schedule

Set an agent to run at a time you pick (like every morning at 9am) or on demand, without keeping a terminal open. Your agents ship code, triage issues, and run audits while you're off doing something else. You come back to finished work.

- Define tasks in files that live next to your code
- Skip a run if the last one is still going, so you never get duplicates
- Every run gets its own session with full history
- Schedules run for as long as DorkOS does: put it on a machine that stays on and they fire around the clock

### Relay: let agents reach you

Your agents can message you on the channels you already use: Telegram, Slack, a webhook, or the browser. When an agent finishes or gets stuck, you hear about it where you are. Agents can also message each other across projects.

- Telegram, Slack and webhook support built in
- Add a new channel with a plugin, no custom bot required
- Messages wait for you even after you close the terminal

### Mesh: find your agents

DorkOS scans your projects and finds the folders that hold agents. You choose which ones to add. Each agent gets an identity you can recognize at a glance: a name, a color, an icon, and a purpose.

- Finds Claude Code, Codex, and other agent projects for you
- You approve which agents join before anything connects
- Each agent knows what the others can do and how to reach them

### Console: watch it all in your browser

Your agents have names, colors, and a status. Glance at your browser and know which ones are working, which are done, and which need you.

Start a session in the browser. Check on it from your phone. Every session shows up together, whichever tool started it.

- Full session history with rich markdown
- Approve or deny an agent's actions from any device
- Live updates across every browser tab you have open

### Extensions

Agents can build and install extensions that add new features. Each extension brings its own settings and secrets, all managed from the app.

### Connect other AI tools (MCP)

DorkOS speaks MCP (the open standard that lets AI tools share tools with each other), so other agents like Claude Code and Cursor can use the DorkOS tools directly. Anything that changes something on your machine needs your local MCP token, which you can copy from Settings → Advanced → Tools. On a server nobody signs into, set `MCP_API_KEY` and give that fixed key to every client instead.

```bash
claude mcp add dorkos --transport http http://localhost:4242/mcp
```

## Docker

```bash
docker build --build-arg INSTALL_MODE=npm -t dorkos .
docker run --rm -p 4242:4242 \
  -e ANTHROPIC_API_KEY=your-key-here \
  -e DORKOS_HOST=0.0.0.0 \
  dorkos
```

## Open Source

MIT-licensed and open source. It runs on your machine: your agents, your data, your rules.

Choose how much control you want, from approving every single action to letting an agent run on its own. Every session is saved on your computer, so when an agent works overnight you can see exactly what it did.

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
