---
title: 'Architecture direction review, November 24, 2026: Herdr, Buzz, T3 Code and two traces of our own server'
date: 2026-11-24
type: internal-architecture
status: active
tags:
  [
    architecture,
    direction,
    computer-side,
    recovery,
    addressable-agents,
    mini-apps,
    herdr,
    buzz,
    t3-code,
  ]
---

# Architecture direction review, November 24, 2026

**Asked by the operator on 2026-11-24:** review the target architecture against the vision reset, the everything-is-a-space plan and the tracker; review three outside systems (Herdr, Block's Buzz, T3 Code and its "Orchestrator V2"); and answer five questions: should DorkOS split a core from its interface, should it be several services, what should a headless DorkOS on an agent computer be, where do non-core things such as a pull request watcher live, and how do we get "add a machine and see its agents". Target dates were ignored on purpose.

**Decided from it, the same day:** ADRs `261124-150515` (sequence, not dates), `261124-150516` (space side and computer side), `261124-150517` (turns survive restarts), `261124-150518` (every agent can be messaged directly), `261124-150519` (the core test, mini apps and one wake) and `261124-152801` (a playbook sets how agents work together). This report is their evidence. Where it and those records differ, the records win.

## Method

- **Herdr:** the installed `hc` 0.1.22 and Herdr app 0.1.17 (manuals, the published API schema), plus source at `herdrdev/herdr-core` `329cb66` and `herdrdev/herdr-app` `9a9ae13`. Apache-2.0.
- **Buzz:** `block/buzz` `ed29172f` (2026-11-23) and, less deeply, `block/buzz-app` `4276f5e9`. Apache-2.0. Six earlier Buzz reports in this folder cover features; this one covers structure.
- **T3 Code:** `pingdotgg/t3code` `ae45e009` (2026-11-24), the Orchestrator V2 merge `de343914` and the last V1 commit. MIT.
- **Our own server:** two read-only traces of `apps/server/src` at `83c296b6e4`: how the code divides between space data and execution state, and how an outside event reaches an agent. A third trace covered how one agent can be messaged from outside.
- Nothing was built or run. Counts are from scripts over import lines and `wc`, so treat them as close, not exact.

## The one idea

**Split by lifetime and by trust. Never by feature.**

All three systems land on the same rule, each from a different side:

- **Herdr** splits "what must never die" (a tiny holder process that owns the running programs) from everything else. Its core can crash, restart or update and agents keep running.
- **Buzz** is one large server. It runs a separate service only where trust differs (a gateway that holds phone-push keys) or lifetime differs (one-shot jobs, agents on other machines). Its agent runner is a small headless program that needs an identity and a server address.
- **T3 Code** is one server per machine. It did not split out the part that owns agent processes, so every restart ends running turns, and a large recovery system exists to cope. Its Orchestrator V2 fixed lost work another way: follow-up work is saved in the same write as the turn.

DorkOS had already chosen the matching line on 2026-11-22 (ADR `261122-173853`): space data on one side, execution state on the other. The code does not have that line yet. So the direction is not a new architecture. It is making that decision real.

## What our own code says

- The agent computer is the whole server with about a dozen startup branches switched off. It still loads every runtime SDK, `node-pty`, `better-sqlite3` and the full module graph. No image target, script or CLI command starts that role.
- A computer side that runs alone would be about 100,000 lines with OpenCode only, or about 175,000 with every runtime, out of about 750,000 in `apps/server/src`.
- Import lines crossing the cut: about 470 from the computer side to the space side, and about 320 the other way.
  - 151 of the 470 are one thing: the DorkOS tool server sits inside the Claude Code runtime (`services/runtimes/claude-code/mcp-tools`, about 9,000 lines).
  - 156 of the 320 call `services/session` directly. About 100 of those are rooms, tasks, heartbeats, canvas and mini apps starting and watching turns. That is the turn contract, written as function calls.
- Of the contract designed for cloud agent computers, five chat operations are built and tested behind an experiment flag. `agents.sync`, `turn.start`, `tools.list`, `tools.call` and `computer.status` exist only as schemas that no server code uses. The forwarding runtime is not built. A person's own computer calls its runtimes in-process.
- Every runtime process is a plain child of the server (the Claude Code CLI, Codex's app-server, the OpenCode sidecar); Doe runs inside the server. None is ever taken over by a new server. A restart loses the running turn. Queued messages and the event log survive; open asks expire.
- The local sealed computer (`computer-local`) already has the target shape: a host-side runtime client and a tool bridge back to the host. It forwards OpenCode's protocol, not ours, so it can converge.
- The five hardest tangles: the tool server inside the Claude Code runtime; space-side code starting turns directly; trust facts read in-process by the runtimes (about 36 imports of the turn-power code and 33 of the agent-identity code); conversations and execution sharing `services/session` and one SQLite file; one startup sequence with static imports and shared singletons.

## The five questions

### 1. Split a core from the interface, like Herdr?

DorkOS already has the obvious split: a server and a client behind `Transport`. The parts of Herdr worth taking are the less obvious ones.

- **Lifetime.** Give the computer side its own long-lived process on a Mac, so updating the rest of DorkOS stops ending turns. It needs a test per runtime: OpenCode is a sidecar and should be easy; Codex is one long-lived app-server; Claude Code depends on how the SDK lets us own its child process; Doe runs in-process.
- **A wire that negotiates.** Two computers can run different versions, so their hello carries a version and a feature list. Herdr goes further ("the API only grows", held by a test against the last release). The operator ruled that out for the REST API until it is a stable 1.0, in line with ADR `261123-170832`.
- **Not taken:** messages delivered as typed keystrokes with no receipt (herdr-core#334 records sends that started no turn), no check of who is on the pipe, and no resume after a reboot.

### 2. Several services?

No. None of the three does it, and each shows why.

- T3's fix works because the turn and its follow-up work are saved in one database write. Separate services lose that.
- Buzz's one large server hurts where its inside walls are not enforced, not because it is one process. DorkOS has lint walls already.
- Relay is set to shrink into conversations (ADR `261017-211859`, accepted 2026-11-24 with its Maildir store retiring). A Relay service would grow the thing being retired.
- Each extra service makes "ready in under a minute" and a one-command install harder.

The honest gains from splitting are separate scaling, a smaller blast radius and a forced contract. The space side and computer side give the forced contract; a separate process for the computer side gives the blast radius. The rule: a new process only for a different lifetime or a different trust level.

### 3. A headless DorkOS for agent computers

It is the computer side: runtimes, turn dispatch, workspaces, the terminal, the agent's browser, keep-awake, the tool bridge client, a relay dialer and a small store. No rooms, schedules, connections, sign-in pages or client files.

From Buzz's remote-agent rules: identity fails closed, no secrets in configuration, presence is a lease that must be renewed, at most one live instance, a stop is final, and the host ends itself when idle. Buzz has no way to stop a stuck agent from outside; DorkOS should. From Herdr: the same program on both ends, reachable over any byte pipe, and it installs itself. Unlike Herdr, the pipe is for reach only: the computer still checks who is calling and for which space.

### 4. Watchers and other non-core things

The watcher is a mini app. The wake is core.

- Herdr's app has a three-question test for what may enter its core. A pull request watcher fails all three. Buzz 1.0 ships its watcher as a plugin. T3 Code puts it in the core and has no plugin system, which is the opposite of DorkOS's first differentiator.
- What must be core is one durable way to wake an agent.
- Today a mini app can run as its own process, on a timer, with network access, and can start a turn. A connected app can deliver events to one chat per subscription. The gaps, smallest first:
  1. A tool call carries no chat id, so a watcher can wake only the agent's one mini-app chat, not the chat that asked.
  2. An event keeps only its top-level text fields, so a nested payload likely arrives nearly empty.
  3. A mini app cannot receive a connected app's events.
  4. A beat cannot be woken by a subscription its owner approved.
  5. A watcher an agent built needs a person to approve its exact files before it may use a connection.
  6. The Relay webhook publishes to a subject nothing acts on.

### 5. "Add a machine and see its agents"

The plan supports it; the code does not yet. The account directory, one sidebar grouped by computer, linking a Mac and the self-hosted wake channel are all unbuilt and all assume a cloud home. Three things follow for the architecture:

1. A computer becomes a record in a space: its name, when it was last seen, which agents work on it. The `dork:host:` reference kind exists already. Buzz has no such record.
2. A Mac can be the home other computers attach to, with no cloud. That keeps the ownership principle honest and matches Herdr.
3. Two pipes, one feature: SSH for developers (one command that installs the matching build on the far side), DorkOS's tunnel with a sign-in for founders.

T3 Code has each client connect straight to every machine. DorkOS differs on purpose: the space holds an agent's identity and rules, so the space is where computers attach. Worth taking from T3: a per-machine live stream of what is running.

## What Orchestrator V2 teaches the turn machinery

T3's first engine already saved events and receipts in one write. Its bugs came from the work that follows a write (start the agent program, capture a checkpoint) being driven from memory. V2 moved that work into the same write, as an outbox, with a worker that holds leases, and applies changes to one chat at a time. For DorkOS:

1. Save follow-up work with the turn. "Accepted" then means "saved, with what comes next".
2. Keep a small run record that DorkOS owns: status, attempt, the runtime chat it maps to, place in the queue, the run it continues. Transcripts stay with the runtime (ADR-0310).
3. Make recovery a rule with caps: drop work tied to a dead process, continue only where the runtime can resume, at most three tries, never continue a turn that was stopped or is waiting on a person, tell the agent what background work died.
4. Do not copy the rewrite: one change of about 380,000 lines over four months, a one-way database copy that dropped history, and every client upgraded in lockstep.

## Messaging one agent directly

Today the A2A gateway gives each agent its own URL and returns the reply in the same call, but it is off by default, local only, capped at two minutes and absent from the API document. The REST API needs a chat first and refuses a script once an owner account exists. There is no CLI verb, no outside MCP tool, and the address design has no send operation. Each path answers "who is calling" differently. One capability, projected to every way in, removes the drift (ADR `261124-150518`).

## How agents work together

Asked later the same day: can a person set how agents work together (answer fast and do the work in the agent's own chat with helpers; do all work in rooms; give each piece of work its own channel), switch between those ways, and have something enforce the choice. A read-only trace of the server at `10280058fd` found that this does touch the architecture:

- **Little of it is a setting today.** The lead-chat rule is a sentence in code. Response modes, the engaged window, the cascade guard and turn budgets are enforced and can be set per room or per agent, but nothing groups them. The budgets are held in memory and reset on a restart.
- **There are two gates.** One for capabilities, and a second for hand-registered tools such as the one that starts a helper chat. Both can only allow, ask, refuse or hold. Neither can send an action somewhere else, and no package can add a rule to either.
- **Runtimes are not equal here.** Codex, OpenCode and Doe agents get the registry's capabilities and nothing else, so starting a helper chat, the task tools and the agent-registry tools exist only for Claude Code agents, though every runtime is told to use them.
- **A runtime's own helpers bypass DorkOS's gate.** It only watches Claude Code's built-in subagents through the runtime's events.
- **Hooks do not carry.** Claude Code runs a package's hooks, Codex needs a person to trust each one, OpenCode and Doe have none, and none exist on another computer.
- **Work cannot move.** Room turns and direct-chat turns share a dispatcher but not their busy rules; an agent's seat in a room never changes hands; tying a channel to an existing checkout is reserved in code and not built.

So the choice belongs in the space's data, and the rules belong at DorkOS's own gate and turn port, which every runtime on every computer passes through. That is ADR `261124-152801`, which names the setting a playbook.

## Mismatches found between the target and the plan, and their state

| Mismatch                                                                           | State                                                       |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Relay: one record retired Maildir, a proposed one kept it for good                 | Settled: ADR `261017-211859` accepted with Maildir retiring |
| The architecture project was not Started in the tracker                            | Settled                                                     |
| The Nov 21 target groups the server by feature, not by the two kinds of state      | Settled by ADR `261124-150516`; the target doc follows      |
| The Nov 21 target still described deprecation periods and arming                   | Fixed in the target doc                                     |
| The agent computer was built as the whole server                                   | Settled by ADR `261124-150516`                              |
| "An agent's own computer" exists twice (`computer-local`, the agent-computer role) | Settled: both move onto one contract                        |
| The API decision leaned on member checks whose ticket was canceled                 | A design ticket is filed (DOR-5150)                         |
| "See every agent grouped by computer" had no builder and needed a cloud home       | In the build order below                                    |
| Nothing joined outside events to waking an agent                                   | Settled by ADR `261124-150519`                              |

## Build order (no dates)

1. One turn port that rooms, tasks, heartbeats, canvas and mini apps all call, with the run record and the outbox behind it.
2. The DorkOS tool server moves out of the Claude Code runtime.
3. A computer entry that starts alone, held by a lint wall.
4. The test of the computer side as its own process on a Mac. The capped recovery rule ships either way.
5. The wire operations, the computer record and adding a machine. The local sealed computer moves onto the same contract.
6. One wake, then a first-party pull request watcher mini app.
7. One "send to an agent" capability and its projections.

The hardest open question is the permission gate across the wire; it gets a design note before step 5.
