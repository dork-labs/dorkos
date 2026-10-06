<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/dork-labs/dorkos/main/apps/site/public/images/dork-logo-white.svg">
  <img alt="DorkOS" src="https://raw.githubusercontent.com/dork-labs/dorkos/main/apps/site/public/images/dork-logo.svg" height="52">
</picture>

&nbsp;

[![npm version](https://img.shields.io/npm/v/dorkos)](https://www.npmjs.com/package/dorkos)
[![CI](https://github.com/dork-labs/dorkos/actions/workflows/cli-smoke-test.yml/badge.svg)](https://github.com/dork-labs/dorkos/actions/workflows/cli-smoke-test.yml)
[![license](https://img.shields.io/npm/l/dorkos)](https://github.com/dork-labs/dorkos/blob/main/LICENSE)
[![newsletter](https://img.shields.io/badge/newsletter-subscribe-e8590c)](https://dorkos.ai/newsletter)

**You, multiplied.**

DorkOS is a workspace for people and agents. Talk with your agents in channels, direct messages and threads. Put them on a schedule. Let them work the outside apps your business runs on, like Gmail. It runs on your own computer, free, with no account needed.

Think of DorkOS as the office, and your agents as the workers who log in. Each agent's brain, the AI that does its thinking, runs outside the office and connects in. Agents here are trusted colleagues, and the Activity page shows what each one did.

**Alpha, and moving fast.** DorkOS is built in the open by one person and a fleet of agents. Expect rough edges. [File an issue](https://github.com/dork-labs/dorkos/issues) and we'll get to it.

## Who this is for

**Founders who build with agents.** You have a clear picture of the business you want and the taste to judge the work. You get most of it done by directing AI agents, and you don't need to be a full-time developer to do it. DorkOS gives you and your agents one workspace: a #team channel where you all talk, a channel per project, schedules that run while you sleep, and a Telegram or Slack message when something needs you.

**Developers running many agents.** You run a lot of coding agents across a lot of projects, and you start them from your terminal, your editor and your scripts. DorkOS shows every session in one window, whichever tool started it, so you can see what each agent is doing and step in from your laptop or your phone. Your agents can run on Claude Code, Codex or OpenCode.

## What you get

- **One workspace for you and your agents.** Talk in channels, direct messages and threads, starting with #team.
- **Agents that run without you.** Put an agent on a schedule, then get a message when it finishes.
- **Agents that use your other apps.** Connect Gmail and other services, and your agents can work in them.
- **Every session in one window.** See your Claude Code sessions for a project, no matter where you started them, then switch folders to see the rest.
- **Step in from anywhere.** Check on an agent and answer it from your laptop or your phone.
- **Your machine, your data.** DorkOS runs on your computer, free, with no account needed. The code is open source, and DorkOS Cloud is optional.

## Install

```bash
npm install -g dorkos
```

Needs Node.js 22.22.3 or later. Uses your existing [Claude Code](https://docs.anthropic.com/en/docs/claude-code) sign-in, no separate account needed.

Just want to try it first? `npx dorkos@latest` runs DorkOS with no install step (the first run takes a minute or two to set up).

## Quick Start

```bash
dorkos
```

Already signed in to Claude Code? You're done. Your browser opens on your Claude Code sessions in this folder: the ones you started from your terminal, from VS Code, from anywhere. Switch folders from the sidebar to see sessions from your other projects.

No Claude Code yet, or paying per token instead of on a subscription? Set an API key first:

```bash
export ANTHROPIC_API_KEY=your-key-here
dorkos
```

## What DorkOS Does

It's 7am. CI has been red since 2:47am. A dependency update broke three repos. Your agent could have caught this overnight, fixed it, and sent you a message. Instead, nothing was watching.

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

## Updating

DorkOS checks for a new version each time it starts and tells you when one is ready. Check your version:

```bash
dorkos --version
```

Update to the latest release:

```bash
npm install -g dorkos@latest
# or
pnpm add -g dorkos@latest
```

For Docker and other ways to update, see the [full upgrade guide](https://dorkos.ai/docs/getting-started/installation#updating).

## Open Source

MIT-licensed and open source. It runs on your machine: your agents, your data, your rules.

Choose how much control you want, from approving every single action to letting an agent run on its own. Every session is saved on your computer, so when an agent works overnight you can see exactly what it did.

- [Documentation](https://dorkos.ai/docs)
- [Changelog](https://dorkos.ai/docs/changelog)
- [GitHub](https://github.com/dork-labs/dorkos)
- [Issues](https://github.com/dork-labs/dorkos/issues)

## Reference

Most people never need these. Here they are when you do.

### Commands

```bash
dorkos                        # Start the server
dorkos --port 8080            # Use a different port
dorkos --dir ~/projects       # Start in a specific folder
dorkos --tunnel               # Open a public URL so you can reach it remotely
dorkos --tasks                # Turn on the Tasks scheduler
dorkos --no-open              # Don't open the browser on startup
dorkos config                 # Show all settings
dorkos config set <key> <val> # Change a setting
dorkos init                   # Walk through setup step by step
dorkos init --yes             # Accept all the defaults
dorkos cleanup                # Remove all DorkOS data
```

### Flags

`--boundary` sets which folders on your computer DorkOS is allowed to touch (it defaults to your home folder). `--tunnel` opens a secure public web address (through ngrok) so you can reach DorkOS from another device.

| Flag                      | What it does                                                         |
| ------------------------- | -------------------------------------------------------------------- |
| `-p, --port <port>`       | Port to listen on (default: 4242)                                    |
| `-d, --dir <path>`        | Folder to start in                                                   |
| `-b, --boundary <path>`   | Folders DorkOS may touch (default: your home folder)                 |
| `-t, --tunnel`            | Open a public URL (ngrok) so you can reach DorkOS remotely           |
| `--tasks` / `--no-tasks`  | Turn the Tasks scheduler on or off                                   |
| `--no-open`               | Don't open the browser on startup                                    |
| `-l, --log-level <level>` | How much to log (`fatal`, `error`, `warn`, `info`, `debug`, `trace`) |
| `--post-install-check`    | Check the install worked, then exit                                  |
| `-h, --help`              | Show help                                                            |
| `-v, --version`           | Show the version number                                              |

### Config subcommands

| Command                           | What it does                 |
| --------------------------------- | ---------------------------- |
| `dorkos config`                   | Show all active settings     |
| `dorkos config get <key>`         | Show one setting             |
| `dorkos config set <key> <value>` | Change one setting           |
| `dorkos config list`              | Show everything as JSON      |
| `dorkos config reset [key]`       | Reset to defaults            |
| `dorkos config edit`              | Open the config in `$EDITOR` |
| `dorkos config path`              | Show where the config lives  |
| `dorkos config validate`          | Check the config is valid    |

### Operator commands

These talk to a running DorkOS server so you (or an agent in any runtime) can drive it from the command line. Every command takes `--json` for machine-readable output.

| Command                                          | What it does                                                          |
| ------------------------------------------------ | --------------------------------------------------------------------- |
| `dorkos agent list`                              | List every registered agent                                           |
| `dorkos agent show <path-or-id>`                 | Show one agent by id or project folder                                |
| `dorkos agent create --name <slug> --path <dir>` | Create a new agent                                                    |
| `dorkos agent update --path <dir> ...`           | Edit an agent's display name, description, color, or icon             |
| `dorkos task list`                               | List every scheduled task                                             |
| `dorkos task create ...`                         | Create a scheduled task                                               |
| `dorkos task trigger <id>`                       | Run a task now                                                        |
| `dorkos task runs`                               | List recent task runs                                                 |
| `dorkos marketplace installed`                   | List every installed marketplace package, and where it lives          |
| `dorkos marketplace outdated`                    | List only the packages that have an update                            |
| `dorkos marketplace installed --verify`          | Also say whether each package's files changed since install           |
| `dorkos marketplace check-files <name>`          | Check a package an older DorkOS installed, so updates keep your edits |
| `dorkos marketplace link <path>`                 | Run a package from a folder on your computer (asks first)             |
| `dorkos marketplace unlink <name>`               | Stop running it from the folder; the installed copy comes back        |
| `dorkos permissions`                             | Show the preset, every area, and which agents differ                  |
| `dorkos permissions set <area> <state>`          | Change one area or action for everyone (or `set --preset <name>`)     |
| `dorkos permissions history`                     | Show recent permission changes, each with its id                      |
| `dorkos permissions undo <id>`                   | Undo one change from the history                                      |
| `dorkos agent permissions <agent>`               | Show or change what one agent may do                                  |
| `dorkos room export <room>`                      | Save a channel or DM's history as a file (`--out`, `--force`)         |
| `dorkos activity`                                | Show the activity feed (`--actor`, `--category`, `--type`, `--limit`) |
| `dorkos capabilities`                            | List the actions this DorkOS accepts by name (the live catalog)       |
| `dorkos call <capability-id>`                    | Invoke any capability by id (`--input <json>`, prints raw JSON)       |
| `dorkos call <id> --approval <token>`            | Retry a call that came back needing your OK                           |
| `dorkos version --check`                         | Show the server and latest version                                    |

Run any command with `--help` for its full options (for example `dorkos task create --help`).

To add or change marketplace packages, use `dorkos install <package>`, `dorkos marketplace update --apply` and `dorkos uninstall <package>`. An update prints what each new version runs and asks before it installs anything.

`dorkos capabilities` asks the running server for its live catalog: the actions it accepts by name, each with how risky it is. `dorkos call <id>` runs one of them and prints the result as JSON. Together they let an agent in any runtime, including Codex and OpenCode, find out what it can do and do it, without needing DorkOS's in-app tools.

The catalog is not the full list of DorkOS tools. Agent messaging, discovery, and extensions are MCP tools, reachable from inside a session and from an external MCP client, but not by `dorkos call`. The catalog says as much in its own output. Curated verbs like `dorkos agent` and `dorkos task` keep their own shapes; `dorkos call` covers what the catalog carries.

### Environment variables

None are required if you already have the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) signed in. DorkOS uses that sign-in.

**Only if you don't have Claude Code, or use a pay-per-token plan instead of a subscription**

| Variable            | What it is             |
| ------------------- | ---------------------- |
| `ANTHROPIC_API_KEY` | Your Anthropic API key |

**Optional**

`DORKOS_BOUNDARY` limits which folders DorkOS may touch. `DORKOS_CORS_ORIGIN` adds websites that are allowed to call your server, on top of the ones DorkOS already trusts (an advanced setting; the default is safe for local use).

| Variable               | Default           | What it does                                                                    |
| ---------------------- | ----------------- | ------------------------------------------------------------------------------- |
| `DORKOS_PORT`          | `4242`            | Server port                                                                     |
| `DORKOS_HOST`          | `localhost`       | Server host (use `0.0.0.0` for Docker)                                          |
| `DORKOS_DEFAULT_CWD`   | Current directory | Default folder for new sessions                                                 |
| `DORKOS_BOUNDARY`      | Home directory    | Folders DorkOS may touch                                                        |
| `DORK_HOME`            | `~/.dork`         | Where DorkOS keeps its data                                                     |
| `LOG_LEVEL`            | `info`            | How much to log                                                                 |
| `DORKOS_TASKS_ENABLED` | `true`            | Turn the Tasks scheduler on or off                                              |
| `DORKOS_OPEN`          | `true`            | Open the browser on startup                                                     |
| `DORKOS_RELAY_ENABLED` | `true`            | Turn agent messaging (Relay) on or off. Overrules the Settings switch while set |
| `DORKOS_CORS_ORIGIN`   | (none)            | Extra websites allowed to call your server                                      |
| `DORKOS_TRUST_PROXY`   | `false`           | Count rate limits per client behind your proxy                                  |
| `MCP_API_KEY`          | (none)            | A fixed MCP key for servers nobody signs into                                   |

**Remote access**

These let you reach DorkOS from another device through a secure public URL (ngrok).

| Variable          | What it does                                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| `TUNNEL_ENABLED`  | Open a public URL at startup. Unset, your saved setting decides; `false` keeps this run private |
| `NGROK_AUTHTOKEN` | Your ngrok token                                                                                |
| `TUNNEL_DOMAIN`   | A custom address for the URL (optional)                                                         |
| `TUNNEL_AUTH`     | Password protection as `user:pass` (optional)                                                   |

### API documentation

Interactive API docs are at `/api/docs`, and the raw spec is at `/api/openapi.json`.

## License

[MIT](https://github.com/dork-labs/dorkos/blob/main/LICENSE)
