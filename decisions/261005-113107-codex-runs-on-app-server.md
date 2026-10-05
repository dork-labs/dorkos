---
id: 261005-113107
title: Codex runs on one supervised app-server process per home, not one exec process per turn
status: accepted
created: 2026-10-05
spec: codex-app-server-transport
superseded-by: null
supersedes: '0309'
amends: 261002-221210
---

# 261005-113107. Codex runs on one supervised app-server process per home, not one exec process per turn

## Status

Accepted (spec `codex-app-server-transport`, DOR-2719; app-server became Codex's default transport in phase 3, 2026-10-05, with `exec` still available through `runtimes.codex.transport`). Supersedes ADR-0309 (Codex SDK threads, one `codex exec` per turn). Amends ADR `261002-221210` in two clauses only: "Codex does not use the relay" and "the token rides only the environment, under a variable named fresh for every turn" are replaced by the credits clause below. Everything else in that ADR stands, including the separate credits home and "a conversation stays on whatever paid for it".

## Context

ADR-0309 ran every Codex turn as a fresh `codex exec` through `@openai/codex-sdk`, which closes stdin after the prompt and exits at turn end. So DorkOS had no approval channel (Codex modes could only pick a sandbox and promise "it cannot stop to ask"), no mid-turn steer, and background terminals and sub-agents died with the turn. Codex's own guidance places the SDK at CI and automation and `codex app-server` (JSON-RPC over stdio, used by the VS Code extension and Codex Desktop) at deep product integration. The spikes (`research/20261005_codex-app-server-spikes.md`) also showed that app-server fixes a thread's config when it loads, ignores new config on a loaded thread without saying so, and that both transports write project trust into the person's `config.toml`.

## Decision

We will run Codex through `codex app-server`, behind a transport seam with `runtimes.codex.transport` (`auto` | `app-server` | `exec`). Exec stays as a fallback; `auto` resolves to exec until app-server passes the shared conformance suite and a live proof (approval card, steer, clean stop, a background command waking the chat), then to app-server. Exec is removed in a later cleanup once app-server has shipped a release with nobody needing the switch.

- **Process model.** One supervised child per (binary, `CODEX_HOME`, environment fingerprint): in practice the person's home and the credits home. Spawned lazily, `initialize` with `experimentalApi: true`, restarted with backoff, stopped at shutdown. A crash fails its in-flight turns cleanly. The idle reaper never stops a process holding a live turn, a pending approval or a background terminal.
- **Secrets never ride argv or the process environment.** Thread config is fixed while a thread is loaded, so nothing per turn goes in it. The `dorkos` tool server and connector route get a **thread key**: minted when DorkOS loads the thread, sent once in `thread/start`/`thread/resume` config, held only in DorkOS memory, and resolved by the internal listener to whichever turn binding is open on that session now (refused when none is). The agent identity token rides `shell_environment_policy.set`; managed MCP headers ride `http_headers`. All of it goes over stdin.
- **Credits** use the existing loopback credits relay: the thread's provider entry points at the relay with a per-process relay key. The token never enters Codex's process.
- **Approvals are real.** Command, file-change, permission, question and MCP elicitation requests from the server become DorkOS approval, question and elicitation events, answered only by the person. Codex modes keep their DorkOS ids and gain honest `asks` values.
- **Steer** uses `turn/steer` with the expected turn id. DorkOS tracks the active turn itself, because `turn/start` on a busy thread silently joins it.
- **Work outlives the turn.** Late events from background terminals and sub-agents are caught at thread level and wake the chat as a runtime turn (`onRuntimeTurn`).
- **DorkOS never writes the person's trust list.** Every thread carries an in-memory `projects.<cwd>.trust_level`: today's effective behaviour in the person's home, always `untrusted` in the credits home.
- **The protocol is pinned** to the vendored binary. A committed schema snapshot of the methods, notifications and fields DorkOS uses, plus a check that regenerates it from the binary, fails on drift.

## Consequences

### Positive

- Codex can stop and ask before a risky action, so its modes stop promising "it cannot ask you first".
- Mid-turn steer, a graceful stop (`turn/interrupt`, an `acked` receipt instead of a killed process), and background commands and sub-agents that finish after the reply and say so in the chat.
- Fewer processes: two long-lived children instead of one per turn; no spawn cost per turn.
- Per-turn secrets leave the process environment, so commands the agent runs can no longer read the DorkOS tool bearer or the credits token from it.
- DorkOS stops editing the person's Codex trust list, which exec does today on every new writable folder.

### Negative

- DorkOS now owns a long-lived child: supervision, crash handling, idle reaping and a shared blast radius (one crash ends every Codex turn in that home).
- The experimental API carries no compatibility promise; a binary bump can change it, and unknown params are dropped silently. The schema check is the only guard, so every bump costs a regenerate and diff.
- An edit to an agent's managed MCP servers reaches a running Codex chat only after its process goes idle and is recycled.
- The thread key widens the internal listener's bearer model from "one bearer per turn" to "a thread key resolved to the open turn", a security-sensitive change that needs its own review.
- Because the thread key is resolved per request, a background command or sub-agent a turn left running that calls the `dorkos` server while a later turn of the same session is open acts with that later turn's binding. Accepted: same session, working directory and agent, and every check a turn bearer gets still runs against that binding; between turns the call is refused.
- Two transports live side by side until the cleanup, and changing `runtimes.codex.transport` takes effect at the next server start.
- A late background completion that wakes the chat starts a model turn the person did not type.
