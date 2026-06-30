# Development Workflow

> **Sync note:** A condensed, user-facing version of the dev setup is published on the docs site at `docs/contributing/development-setup.mdx`. When you change the workflow here, update that page too so the two do not drift.

The default way we actively work on DorkOS is to run **two instances side by side**: a hot-reloading **preview** of the app you're editing, and a stable **cockpit** — the built CLI — that you drive as a coding agent to do the editing. This is dogfooding: using DorkOS to build DorkOS.

```bash
pnpm dev:dogfood   # starts both; cockpit auto-opens your browser
```

That single command runs `pnpm dev` (preview) and `pnpm cli:dev` (cockpit) concurrently via [`concurrently`](https://www.npmjs.com/package/concurrently), prefixing their output `preview` / `cockpit` and tearing both down together on `Ctrl-C` (`--kill-others`).

## The Two Instances

|                | **Preview** (`pnpm dev`)                        | **Cockpit** (`pnpm cli:dev`)                                              |
| -------------- | ----------------------------------------------- | ------------------------------------------------------------------------- |
| Role           | The app you're building — your edits, live      | The DorkOS agent you drive to write the code                              |
| Command        | `dotenv -- turbo dev --filter=!@dorkos/desktop` | `pnpm --filter=./packages/cli build && node packages/cli/dist/bin/cli.js` |
| Client URL     | http://localhost:6241                           | — (served by the CLI)                                                     |
| Server URL     | http://localhost:6242                           | http://localhost:4242                                                     |
| Data directory | `apps/server/.temp/.dork` (throwaway sandbox)   | `~/.dork` (your **real** production data)                                 |
| `NODE_ENV`     | dev                                             | forced `production`                                                       |
| Loads `.env`?  | yes (via `dotenv-cli`)                          | **no**                                                                    |
| File watching  | yes — turbo watchers, instant reload            | **no** — rebuild to pick up changes                                       |
| Browser        | open `:6241` yourself                           | auto-opens on startup (default `server.open`, TTY only)                   |

The two never collide: different ports, different data directories. That separation is the entire point of the [port convention](environment-variables.md) — dev uses `6xxx`, production uses `4xxx`, specifically so both can run at once.

### Why the cockpit uses `~/.dork` and port `4242`

`pnpm cli:dev` runs the real packaged CLI entrypoint (`packages/cli/src/cli.ts`), which forces `NODE_ENV=production` and resolves its data directory to `~/.dork`. It also does **not** pass through `dotenv-cli`, so your `.env` overrides (`DORKOS_PORT=6242`) don't apply — it falls back to the code default, `4242`. This is deliberate: the cockpit exercises the genuine production CLI, end to end, against your real config and sessions. See [`apps/server/src/lib/dork-home.ts`](../apps/server/src/lib/dork-home.ts) and the [`dork-home` rule](../.claude/rules/dork-home.md).

## The Mental Model

- **`:4242` is your cockpit.** You drive this DorkOS to write code. It's stable and runs against your real `~/.dork` (real agents, config, sessions). It changes only when you stop and re-run `pnpm cli:dev`.
- **`:6241` is your live preview.** Your edits hot-reload here. This is where you _see_ the change you just made land.

You work in the cockpit; you watch the preview.

## Two Sharp Edges

1. **The cockpit runs against real `~/.dork`.** It is not a sandbox — the agent you drive sees and writes your actual production agents, config (`~/.dork/config.json`), and database (`~/.dork/dork.db`). That's what makes it true dogfooding, but be aware it's live data. To isolate a run, override the directory: `DORK_HOME=/tmp/dork-cockpit pnpm cli:dev`.
2. **The cockpit is watch-free.** Edits do **not** hot-reload into `:4242`. Changes you want to _preview_ appear on `:6241` automatically; you only rebuild the cockpit (`Ctrl-C`, re-run) when you want the agent's _own_ runtime to run your new CLI/server code.

## Running Them Separately

`pnpm dev:dogfood` is convenience. The pieces stand alone:

```bash
pnpm dev        # preview only — :6241 / :6242, dev sandbox
pnpm cli:dev    # cockpit only — :4242, real ~/.dork, auto-opens browser
```

Run them in two terminal tabs if you want independent lifecycles, or when you only need one.

## Related

- [environment-variables.md](environment-variables.md) — the `4xxx`/`6xxx` port convention and every env var
- [`.claude/rules/dork-home.md`](../.claude/rules/dork-home.md) — data-directory resolution rules
- [architecture.md](architecture.md) — the Transport interface the CLI and dev server share
