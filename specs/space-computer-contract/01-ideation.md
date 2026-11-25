---
slug: space-computer-contract
number: 261124-194020
created: 2026-11-24
status: specified
---

# The space-computer contract

**Slug:** space-computer-contract
**Linear:** epic DOR-5152; this part DOR-5165 (design note) and DOR-5166 (build)
**Decision:** ADR [`261124-150516`](../../decisions/261124-150516-space-side-and-computer-side-one-contract-two-entries.md)
**Status:** specified. The permission gate is designed in [design-permission-gate.md](design-permission-gate.md); the contract over the wire is specified in [02-specification.md](02-specification.md).

## What the contract is

DorkOS has two kinds of state (ADR `261122-173853`) and is getting two sides in the code to hold them (ADR `261124-150516`):

- **The space side** holds an agent's identity, rules, level, memory, schedules, connections and conversations, and decides what an agent may do.
- **The computer side** runs turns: runtimes, workspaces, terminals, the agent's browser and a small record of its runs. It may be someone's Mac, a cloud agent computer or a machine added over SSH, and it runs agent code and packages, so it is treated as untrusted.

The contract is the one set of operations between them: start a turn, stream it, stop it, answer an ask, call a DorkOS tool, sync an agent, report status. A Mac uses it too, first as calls in one process and then over the wire, so there is one way to run a turn. The hello carries a version and a feature list, and each side uses only what both name.

## What is built

| Piece                                                                                      | State                                                                                                                                               |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| The sealed, signed channel and its handshake                                               | Built (`apps/server/src/services/core/session-relay/channel.ts`)                                                                                    |
| `chats.list`, `session.stream`, `session.send`, `session.interrupt`, `interaction.respond` | Built at both ends, behind the `sessionRelay.enabled` experiment (`packages/shared/src/session-relay.ts`, `core/session-relay/`, `core/hub-relay/`) |
| `agents.sync`, `turn.start`, `tools.list`, `tools.call`, `computer.status`                 | Schema only (`packages/shared/src/session-relay-agent-computer.ts`)                                                                                 |
| The forwarding runtime on the space side                                                   | Not built                                                                                                                                           |
| A Mac running its own turns through the contract                                           | Not built: the Mac calls its runtimes in-process (`core/session-relay/live-deps.ts`)                                                                |
| The local sealed computer (`computer-local`)                                               | Built behind a flag, on its own protocol: an OpenCode client plus a tool bridge (`services/computers/`, `startup/computer-mcp-bridge.ts`)           |

The operation set and the tool bridge come from `specs/everything-is-a-space/design-agent-computers.md` §2 and §3, which stand. Its §5, the whole server in a sealed role, is replaced by the computer side alone.

## What the first part settles

[`design-permission-gate.md`](design-permission-gate.md) answers the question ADR `261124-150516` left open: a runtime checks tools beside its own process and reads an agent's level in-process today, so how do those trust facts cross to a computer? Its answer, for review:

- Decisions that use authority the space holds stay on the space side, on every call.
- Decisions that use only the computer's own resources are made on the computer, from a signed, read-only copy of the agent's rules for that turn.
- The turn's level and marks come from the space side's record of the turn; the computer may only make a turn stricter.
- On a Mac the same payloads pass by function call.

## What the later parts became

All are specified in [02-specification.md](02-specification.md):

1. **The wire operations** (DOR-5163): §5, built in W7 to W17.
2. **The hello** (DOR-5164): §4.1 and the minimum feature set of §5.1, built in W1.
3. **The forwarding runtimes** and the remote computer face: §6, built in W8 and W15 to W17.
4. **Adding a machine** and the computer record: §11 and §8 (W23, W24, W5); one runner at a time: §9 (W18).
5. **`computer-local` on the contract** (DOR-5167): §10 (W22).
6. **A cloud agent's home: settled** by ADR `261125-113808`. What it left open (what an agent in the cloud may do on the person's Mac, its connections there, how the app on a Mac reaches it) is not on this contract: §19, question 4.
