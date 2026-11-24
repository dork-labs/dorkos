---
id: 261124-150516
title: A space side and a computer side with one contract between them; one program, two entries; a new process only for a different lifetime or trust level
status: accepted
created: 2026-11-24
spec: null
superseded-by: null
amends: [261015-042933, 261122-173853, 261123-170832, 261012-211000]
---

# 261124-150516. A space side and a computer side with one contract between them; one program, two entries; a new process only for a different lifetime or trust level

## Status

Accepted (operator decision, 2026-11-24, on the architect's review of Herdr, Buzz and T3 Code and two traces of our own server: `research/20261124_architecture-direction-review.md`).

**Amends** (each stays Accepted):

- [261015-042933](261015-042933-everything-is-a-space-hubs-space-servers-and-agent-computers.md): its three roles stand as three ways to run the one program. What is retired is the way the agent computer is built: the whole server started in a sealed role with features switched off. An agent computer runs the computer side only. A role is now "which entries are on". Its rule 4 stands: the link from a person's cloud home to their own Mac carries chats only, and the Mac decides what it shares. The contract in this record is a different link, a space asking a computer that runs its agents. The two share a channel and a hello, not their operations.
- [261122-173853](261122-173853-one-space-model.md): its two kinds of state stand and this record gives them a home in the code. "Which servers register a runtime is a role setting read once" becomes "which entries are on". Its gate G4 (one role predicate) stands until the entries below replace the scattered role checks.
- [261123-170832](261123-170832-api-stability-without-deprecation-periods.md): "breaking changes land at once with every caller fixed" stands for the HTTP API and its streams. It does not cover the contract between two computers, where the caller is another machine on another version: that wire negotiates, as below.
- [261012-211000](261012-211000-local-agent-computer.md): the local sealed computer stands as built, with its sealing rules. It forwards OpenCode's own protocol for now and moves onto the contract below.

**Builds on:** [261018-124422](261018-124422-one-program-before-launch.md) (one package, one release, one entry per role), [261006-235238](261006-235238-one-dorkos-server-in-every-size.md) (only one place runs an agent at a time), ADR-0089 (each runtime SDK stays inside its adapter: the model for the computer entry's lint wall) and ADR-0213 with [261005-105209](261005-105209-isolated-extension-server-halves-run-as-a-permission-model-subprocess.md) (a mini app's server half may run as its own limited process: the trust-level split this record names).

## Context

ADR 261122-173853 split DorkOS's state in two: space data (members, agents, conversations, rules, memory, schedules, connections, settings, documents, mini apps) and execution state (workspaces, the runtimes' own transcripts and sign-ins, running processes). The code has no such line. The agent computer is the whole server with about a dozen startup branches switched off: it still loads every runtime SDK and the full module graph, and no image, script or command starts it. The contract between a person's DorkOS and a computer that runs its agents is designed, but only five chat operations are built, behind an experiment flag, and a Mac never uses the contract to run its own agents: it calls its runtimes in-process. Space-side code calls the turn code directly in 156 places, about 100 of them rooms, tasks, heartbeats, canvas and mini apps starting and watching turns, and the DorkOS tool server sits inside the Claude Code runtime. Three outside systems we reviewed all draw their lines the same way: by how long a part must live and by whom it trusts, never by feature.

## Decision

We will give the two kinds of state two sides in the code, with one contract between them.

- **The space side** holds space data and decides what an agent may do. **The computer side** runs turns: runtimes, workspaces, terminals, the agent's browser and a small record of its runs.
- **One contract.** Start a turn, stream it, stop it, answer an ask, call a DorkOS tool, sync an agent, report status. It is the contract already designed for cloud agent computers. A Mac uses the same contract, first as calls inside one process and then over the wire, so there is one way to run a turn, not two.
- **One program, two entries.** A Mac runs both sides. A person's DorkOS in the cloud runs the space side only. An agent computer runs the computer side only: that is the headless DorkOS. The space server keeps its own entry. The local sealed computer (`computer-local`) moves onto the same contract.
- **A computer is a record in a space**: its name, when it was last seen, and which agents work on it. A Mac can be the home that other computers attach to, with no cloud. Adding a machine is one command that installs the matching build on the far side, over SSH or over DorkOS's own tunnel with a sign-in.
- **The wire negotiates.** Two computers can run different versions, so the contract's hello carries a version and a list of features, and a side uses only what both name. This holds from the first build, whatever the REST API does before 1.0.
- **When a new process is allowed.** Only for a different lifetime (the computer side, a one-shot job) or a different trust level (the space server, a sandboxed mini app, a holder of someone else's credentials). Never for a feature: there is no separate service for Relay, for "the orchestrator" or for the web server.
- **How we get there.** Seam by seam, each behind a check that only tightens: one turn port that every space-side caller uses; the DorkOS tool server out of the Claude Code runtime; a computer entry that starts with no space-side code, held by a lint wall; then the wire. No rewrite.

One question stays open and gets its own design note before the wire is built: the permission gate. It belongs on the space side, but a runtime checks tools beside its own process and reads an agent's level in-process today. Across a wire the computer needs a signed, read-only copy of the agent's rules, with the space side still deciding anything that changes state.

## Consequences

### Positive

- "Headless DorkOS", "agent computer", "add a machine" and the local sealed computer become one thing run in different places.
- An agent computer loads about 100,000 to 175,000 lines, not the whole server, and holds no space data to steal.
- The one-space-model's move of the private space onto the space store gets a seam to move along.
- A feature built on the space side works in every space, and nothing reaches into a runtime to get it.
- A clear answer to "should this be its own service": name the lifetime or the trust level, or it stays in.

### Negative

- The cut is real work. About 470 imports cross from the computer side to the space side today and about 320 the other way.
- Two entries mean two start-up paths to keep working, and a wire to keep compatible across versions.
- Calls that are free in one process (reading an agent's level, a tool check) cost a round trip across a wire, so the rules copy has to be designed with care.
- Until the turn port exists, the old direct calls and the new port live side by side.

## Alternatives considered

- **Keep the agent computer as the full server in a sealed role.** Rejected: it ships every feature and dependency to the least trusted machine, and it leaves two ways to run a turn.
- **Split DorkOS into services (a relay, an orchestrator, a web server).** Rejected: none of the systems we reviewed does it, it breaks the single write that keeps a turn and its follow-up work together (ADR 261124-150517), and Relay is already set to shrink into conversations (ADR 261017-211859).
- **Extract a `core` package and keep one entry.** Rejected: a package boundary without a second entry would not prove the computer side can run alone.
