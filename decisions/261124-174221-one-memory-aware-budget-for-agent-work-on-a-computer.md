---
id: 261124-174221
title: One memory-aware budget for agent work on a computer; work over it waits, it is never refused
status: proposed
created: 2026-11-24
spec: null
superseded-by: null
amends: [260812-134510, 261009-171114]
---

# 261124-174221. One memory-aware budget for agent work on a computer; work over it waits, it is never refused

## Status

The operator agreed to this rule in principle on 2026-11-24. It stays Proposed until the turn port's owner confirms the shape (DOR-5192).

Proposed by the architect (2026-11-24), from the review of the problems of 2026-11-23 (`research/20261124_architecture-direction-review.md` and Linear DOR-5192). Becomes Accepted when the turn port's owner picks up DOR-5192 and confirms the shape.

**Would amend** (each stays Accepted; only the named clause would be retired):

- [260812-134510](260812-134510-persistent-streaming-input-sessions.md), in "The warm ceiling is a separate number from the session ceiling, on purpose": "`SESSIONS.MAX_WARM_SESSIONS` (default **12**) counts **processes**" and "a host is only refused when nothing is reclaimable" (already narrowed by [260915-202228](260915-202228-a-warm-process-ends-only-when-it-is-quiet.md); the code has since replaced the fixed 12 with a memory-sized number, DOR-3012). The warm process count stops being its own limit and becomes one input to the budget, and a host with nothing reclaimable waits instead of being refused. Warmth as a cache rationed by least recent use stands, and so does the separate `MAX_SESSIONS` ceiling on session records.
- [261009-171114](261009-171114-chat-message-origin-and-delivery-rules.md), in "No loop guard and no turn cap": "The machine-load launch cap still applies; a send it refuses is answered with the reason, and the sender tries again." A send over the budget waits in line instead. No loop guard and no turn cap stand.

**Builds on, and changes nothing in:** [261124-150516](261124-150516-space-side-and-computer-side-one-contract-two-entries.md) (the budget belongs to the computer side) and [261124-150517](261124-150517-turns-survive-restarts-run-record-outbox-capped-recovery.md) (the turn port, the one door every new turn will pass through, and the run record, which can hold a waiting turn's place).

## Context

On 2026-11-23 one Mac ran about 130 node processes, swap filled and the load average reached 138. Five separate limits decide how much agent work a computer starts, and none reads free memory:

- `runtimes.maxAgentChats` (8, `packages/shared/src/config-schema/runtime-settings.ts`) counts agent-started chats. A launch past it is refused, not queued: a heartbeat that meets it ends with "Too many chats were running to start its beat turn." (`apps/server/src/services/heartbeats/beat-cycle.ts`) and is not retried (DOR-3313). What it gathered waits for the next beat.
- The warm-process ceiling (`apps/server/src/services/runtimes/claude-code/sessions/slot-wait/warm-ceiling-size.ts`) is a number a person can pin (`runtimes.claudeCode.maxWarmProcesses`). Left unset, it comes from total memory: 2 GB per process, between 12 and 32 (`apps/server/src/config/constants.ts`). It never looks at free memory or swap. When it is full and nothing can be reclaimed, a turn waits up to 45 minutes and is then refused (`SESSIONS.WARM_SLOT_WAIT_MS`).
- `rooms.maxConcurrentTurnsPerAgent` (3) and `scheduler.maxConcurrentRuns` (4) are fixed counts.
- The load gate (`apps/server/src/services/core/load-gate/`) gives agents' heavy shell commands one slot and reads only the load average.

Nothing in the server measures how much memory a process uses. A helper an agent starts, such as a test worker pool or a tool server, counts against no limit.

## Decision

We will give each computer one budget for agent work, measured in what actually runs out.

- **One budget, on the computer side.** It is checked at the turn port for every new turn and every helper chat, before a process starts.
- **It reads memory, not a count.** The budget reads the computer's free memory and how fast swap is growing, the same signals the repo's heavy-run order already uses (`scripts/lib/heavy-order.sh`, DOR-5073). A fixed number of chats is not the measure.
- **Over the budget, work waits.** It waits in line with its place shown, first in, first out, and starts when memory frees up. Nothing is refused for being busy.
- **The computer reports what each agent uses.** It samples memory for each runtime process and its children, keyed by agent and chat, and reports it in its status, so a person can see which agent is heavy.
- **The five limits fold in or go.** Each becomes an input to the one budget or is removed. None stays as a separate line that can refuse on its own.
- **A person can move it.** The budget has a setting to raise or lower it, for a computer that also does other work. A pinned number, the remaining scope of DOR-2098, is one such setting.

## Consequences

### Positive

- A computer runs as much agent work as its memory allows: more on a large server, less on a small laptop, with no number a person has to tune.
- No beat, message or scheduled run is lost to "too busy"; it runs later instead.
- A person can see which agent is using the memory before the computer slows down.
- One place decides admission, so a new kind of turn cannot forget to ask.

### Negative

- Processes DorkOS did not start are outside the budget. On 2026-11-23 many of the team's sessions were bare terminal sessions, and the budget cannot hold them back. It can only see the memory they use up.
- Memory is a noisy signal. A turn can start while memory looks free and grow later, so the budget will sometimes admit too much and must leave room for that.
- Waiting work can wait a long time on a busy computer. The line has to say why it waits and for how long, or it feels like a hang.
- Sampling memory for every process tree costs some work of its own, and reading it differs between macOS, Linux and Windows.

## Alternatives considered

- **A fixed number of concurrent agents.** Rejected: any one number is wrong on both a 16 GB laptop and a large server, which is how today's five limits came to exist.
- **Leave it to the operating system.** Rejected: the system's answer is to swap, and swap filling up is what stopped the Mac on 2026-11-23.
- **A budget per agent.** Rejected for now: one shared budget first. Limits for each agent can sit on top of it later.
