---
id: 260908-151620
title: Uninterrupted Connections authority for days-long runtime turns
status: ideation
created: 2026-09-08
provenance:
  {
    tracker: linear,
    issue: DOR-1903,
    project: 51f95eb0-bae7-488e-9b24-8b33028d5fd4,
    parent: DOR-1792,
  }
---

# Uninterrupted Connections authority for days-long runtime turns

**Slug:** `connections-runtime-turn-renewal`
**Tracker:** [DOR-1903](https://linear.app/dorkspace/issue/DOR-1903/design-uninterrupted-connections-credential-renewal-across-runtimes)
**Parent specification:** [white-label-connections](../white-label-connections/02-specification.md)

## Intent and assumptions

Connections gives each agent runtime turn a server-minted bearer whose durable binding expires four
hours after creation. The binding is separate from the generic agent identity token. It carries
structural owner, runtime, session, agent, path, and working-directory authority into the private
Connections capability surface.

Days-long Claude Code, Codex, and OpenCode turns must remain able to use Connections while the exact
runtime adapter still owns the live turn. Renewal must preserve the current immediate-revocation,
restart, authority-change, exact-grant, approval, and no-blind-provider-retry boundaries.

Assumptions:

- the shared runtime principal service remains the lifecycle authority;
- Claude Code keeps its in-process capability path;
- Codex and OpenCode keep the shared loopback listener, with credentials attached through their
  existing runtime-specific mechanisms;
- the four-hour value remains the failure horizon after supervision stops;
- stored session existence, bearer traffic, and runtime history are not evidence of a live turn;
- no current product policy sets one maximum duration across all three runtimes.

Out of scope:

- rotating bearer material, PKI, proof-of-possession, or a new authentication system;
- moving Claude Code onto HTTP or replacing adapter-specific runtime attachment;
- public renewal routes, CLI commands, MCP tools, Transport methods, or configuration;
- changing generic agent identity expiry, approval parking, warm-process limits, or session eviction;
- retrying provider operations or changing `outcome_unknown` handling.

## Source findings

- `runtime-principal-service.ts` fixes `expiresAt` at open, checks it during both resolution and
  revalidation, and exposes no renewal operation.
- All connector execution and discovery paths revalidate the runtime principal. The broker also
  revalidates around final dispatch and before a safe retry.
- Claude Code lazily opens on first Connections use and stores one per-message context on a warm
  session.
- Codex eagerly opens per message and puts the bearer into a newly spawned process's fixed
  environment.
- OpenCode eagerly opens per message, writes headers into a directory-scoped sidecar registration,
  and serializes connector-capable turns with a canonical-directory lease.
- Terminal completion, cancellation, setup failure, runtime failure, authority loss, and server
  restart already revoke or invalidate bindings.
- Current duration controls are scoped: Claude's ten-minute stall watchdog detects stalled turn
  windows; its four-hour interaction ceiling bounds unanswered prompts; its five-minute warm idle
  applies between turns; the thirty-minute session timeout applies to inactive records. Codex and
  OpenCode have no universal productive-turn duration ceiling.

## Options considered

### Rotate the bearer periodically

This limits the lifetime of one secret, but Codex cannot change an environment variable in a
running `codex exec` process. OpenCode would need to mutate directory-shared MCP registration while
a turn is using it and prove the sidecar has switched headers before the old bearer is revoked.
Claude Code could rotate in process, but a shared lifecycle would still need two more complicated
adapter protocols.

**Decision:** reject for this increment. It adds runtime-specific handoff races without changing
the canonical permission checks.

### Extend expiry when the bearer is used

This is simple and works across transports, but a copied bearer could keep itself alive. Request
volume would become the liveness oracle, so an attacker or wedged runtime could prolong authority
without the process owner proving the turn still exists.

**Decision:** reject. Bearer traffic never renews authority.

### Reopen from durable session state

A reconciler could find a session/thread/sidecar record and mint again. Those records outlive live
turns and survive process ownership changes. Restart is currently an explicit invalidation barrier.

**Decision:** reject. Durable session existence is neither necessary nor sufficient renewal proof.

### Renew the same binding from a process-owned supervisor

The server gives the runtime adapter an opaque in-memory permit when it opens a binding. A shared
supervisor renews hourly only while the adapter's exact active-turn object/controller still owns its
slot and its abort signal remains live. Renewal rechecks canonical authority and compare-and-sets
only expiry. The bearer never changes.

**Decision:** choose. It fits all three attachment mechanisms and keeps request traffic unable to
extend its own authority.

## Recommended direction

Keep a four-hour lease horizon and renew it every hour from a shared server-side supervisor. Each
success moves the same binding expiry to four hours after the renewal instant. Do not add a hidden
absolute run cap: a productive turn may renew for days, while loss of its supervisor leaves at most
the existing four-hour exposure.

The supervisor must own an unforgeable process-local permit, the turn's abort signal, and an exact
adapter identity guard that remains valid at the commit boundary. Cancellation, teardown, expiry,
changed authority, slot replacement, and boot initialization close or invalidate that permit.
Renewal must re-read the row, clock, permit, tombstone, and active-turn owner after awaited authority
work, then compare-and-set the exact observed row so expiry or concurrent teardown cannot be undone.

The explicit security tradeoff is that a stolen bearer can remain usable for the duration of a
legitimate days-long run, provided every other permission check passes. It remains bounded to four
hours after the last legitimate supervisor renewal, and traffic from the bearer cannot prolong it.

## Risks and proof obligations

- A renewal racing Stop or terminal teardown must never revive the row.
- An event-loop pause longer than the remaining lease must expire rather than renew late.
- Supervisor storage retries must remain inside the old expiry and must never retry provider work.
- Codex must keep one fixed bearer in the child environment.
- OpenCode must not re-register MCP merely because the lease expiry changed, and its next turn must
  still install a new bearer under the directory lease.
- Warm Claude processes, resumed Codex threads, and reused OpenCode sidecars must never inherit the
  previous message turn's permit or supervisor.
- Tests need injected clocks and schedulers; real waiting cannot establish the boundary.

## Next step

Proceed to the implementation-ready [specification](./02-specification.md), then the canonical
[task breakdown](./03-tasks.json). Implementation remains gated on independent review and a frozen
design.
