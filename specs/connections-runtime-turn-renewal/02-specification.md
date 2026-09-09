---
id: 260908-151620
title: Connections runtime-turn lease renewal
status: implemented
created: 2026-09-08
provenance:
  {
    tracker: linear,
    issue: DOR-1903,
    project: 51f95eb0-bae7-488e-9b24-8b33028d5fd4,
    parent: DOR-1792,
  }
amends: specs/white-label-connections/02-specification.md
---

# Connections runtime-turn lease renewal

**Status:** Implemented
**Tracker:** [DOR-1903](https://linear.app/dorkspace/issue/DOR-1903/design-uninterrupted-connections-credential-renewal-across-runtimes)
**Parent:** [DOR-1792](https://linear.app/dorkspace/issue/DOR-1792/deliver-dorkos-connections-managed-and-byo-accounts-agent-access-usage)
**Architecture decision:** [260908-153657](../../decisions/260908-153657-a-live-runtime-turn-renews-connections-authority-through-its-process-owner.md)

This addendum extends the runtime authority design in the approved
[Connections specification](../white-label-connections/02-specification.md). It does not change provider execution,
grants, approval policy, account selection, or the runtime transports. It keeps a Connections
binding usable during a legitimately active turn that runs for days, while preserving the
four-hour bound after its server-owned supervisor stops.

## Intent

A Claude Code, Codex, or OpenCode turn may remain active for longer than four hours. The current
Connections binding has one absolute `expiresAt` fixed when the turn first opens. It has no
renewal method. A later Connections call therefore fails even when the same runtime process still
owns the same live turn and all owner, agent, session, connection, and grant authority remains
valid.

The four-hour value belongs only to this new Connections runtime-turn binding. It is not the
generic agent identity token, whose current policy is seven days idle and thirty days absolute.
A long-lived DorkOS or Codex session does not by itself prove that a Connections binding was used
or remained live.

The desired behavior is:

- a live runtime turn can continue using its unchanged Connections bearer for days;
- a bearer cannot renew itself by making requests;
- cancellation, terminal completion, setup/runtime failure, server restart, expiry, or changed
  canonical authority permanently closes that binding;
- renewal never expands the immutable claims or the current grants available to the turn;
- Codex keeps its fixed subprocess environment, OpenCode keeps its directory-scoped sidecar
  registration, and Claude Code keeps its in-process tool path;
- provider calls retain the existing no-blind-retry rule for ambiguous writes.

## Current-source findings

The implementation already has the right shared security authority and runtime-specific
attachment points:

- `apps/server/src/services/connectors/principal/runtime-principal-service.ts` opens a random
  bearer after canonical authorization, stores only its hash, fixes expiry at creation, checks
  expiry on both bearer resolution and principal revalidation, and tombstones in process before a
  durable revoke.
- `apps/server/src/services/connectors/runtime-principal-port.ts` exposes only `openTurn`,
  `resolve`, and `revoke`. There is no renewal port.
- `apps/server/src/services/runtimes/connector-mcp/listener.ts` is already one shared IPv4-loopback
  listener for Codex and OpenCode. Claude Code invokes the same Connections capability service
  through its in-process MCP server and receives the same server principal.
- `apps/server/src/services/runtimes/claude-code/connector-turn-context.ts` lazily opens once on the
  first Connections call. The context belongs to one message turn even when a warm Claude process
  serves many turns.
- `apps/server/src/services/runtimes/codex/codex-runtime.ts` opens once per message turn and passes
  the bearer into the spawned `codex exec` process as MCP header environment. A running child
  cannot receive a replaced environment variable.
- `apps/server/src/services/runtimes/opencode/opencode-runtime.ts` owns one active-turn object and
  holds a canonical-directory lease for the whole connector-capable turn. Its MCP manager stores
  headers in a directory-scoped registration on the shared sidecar.
- `apps/server/src/services/connectors/execution/execution-broker.ts` revalidates before every
  attempt and immediately around final dispatch. It already prevents a revoked or expired binding
  from authorizing a safe retry.

Existing duration controls answer different questions and must remain independent:

| Existing control               |                  Current value | Scope                                                      | Renewal consequence                                         |
| ------------------------------ | -----------------------------: | ---------------------------------------------------------- | ----------------------------------------------------------- |
| Connections binding expiry     |                        4 hours | One runtime turn's Connections authority                   | Becomes the renewable lease horizon.                        |
| Generic agent identity         | 7 days idle / 30 days absolute | Attribution and general DorkOS agent identity              | Unchanged; it is not the renewal credential.                |
| Claude turn stall watchdog     |                     10 minutes | An open turn window that stops showing liveness            | Unchanged; renewal does not declare a stalled turn healthy. |
| Human interaction park ceiling |                        4 hours | One unanswered approval/question and its warm-process cost | Unchanged; renewal cannot keep an abandoned prompt parked.  |
| Claude warm idle               |                      5 minutes | A process with no open turn                                | Unchanged; no supervisor exists between turns.              |
| Session record timeout         |                     30 minutes | Inactive in-memory session record                          | Unchanged; durable session presence is not renewal proof.   |

Codex and OpenCode define no universal wall-clock limit for a productive turn. The addendum does
not invent one.

## Decisions

### Keep a four-hour lease and renew it hourly

The binding remains a four-hour lease. A live supervisor requests renewal every hour. Each
successful renewal sets the same binding's expiry to `renewedAt + 4 hours`, then schedules the next
attempt from the returned expiry rather than from the previous timer's firing time.

This gives the supervisor three hours of margin for temporary event-loop delay or storage failure,
while preserving the existing worst-case exposure after the supervisor stops. A timer delayed
beyond the current expiry cannot renew or recreate the binding. Machine sleep, process suspension,
or an outage longer than the remaining lease therefore fails closed.

Renewal errors may use bounded backoff only while the current lease is still live. The retry is a
local lease-row update, never a provider operation. Once the lease expires or renewal receives a
terminal refusal, the supervisor stops and later Connections calls return a clear start-a-new-turn
error.

The initial retry delays are one minute, five minutes, then fifteen minutes. A continuing storage
failure stays capped at one attempt every fifteen minutes until the current expiry. Every callback
rechecks the clock before touching storage, and no callback scheduled at or after expiry runs the
renewal operation. A success replaces that retry schedule with the normal next renewal at three
hours before the newly committed expiry.

The supervisor records one terminal, non-secret lease-loss state containing the binding ID,
runtime, safe reason, last committed expiry, and observation time. It emits at most one structured
warning for that loss. A later Connections attempt receives one uniform safe instruction to start a
new turn; neither the log nor the private MCP response distinguishes secrets or exposes canonical
authority detail. Successful hourly renewal produces no Activity entry, usage attempt, toast, or
turn event.

### Do not add a hidden hard run cap

There is no new absolute run-duration cap and no new configuration field. A productive turn may
renew for days while its exact process-owned turn remains live. The lease horizon already bounds
exposure after liveness disappears.

If DorkOS later adds an operator-selected maximum run duration, it needs a visible policy and an
explicit terminal reason shared by all runtimes. It must not arrive as a secret expiry inside the
Connections credential path.

### Let only the process-owned supervisor renew

Opening a binding also creates an opaque, process-local renewal permit. The permit is returned only
to server runtime code. It is never persisted, serialized, logged, added to MCP headers, or exposed
through a REST, Transport, MCP, CLI, or public schema.

Each runtime owns a `ConnectorTurnLeaseSupervisor` for one exact active-turn object:

- it receives the turn's `AbortSignal`;
- it receives an `isCurrent()` guard that checks object or controller identity in the adapter's
  active-turn slot;
- it starts only after that turn has usable Connections attachment;
- it stops before terminal teardown releases the runtime-owned process or directory resource;
- it cannot be reconstructed from a session row, transcript, thread ID, OpenCode session, or
  connector binding row.

Bearer traffic does not renew the lease. A copied bearer may use the remaining lease if every
other authorization check passes, but it cannot extend its own lifetime.

### Extend the same bearer with a compare-and-set update

Renewal does not rotate the bearer. The principal service:

1. verifies the opaque process-local permit is still open for the exact binding;
2. reads and rejects an absent, revoked, expired, or prior-boot row;
3. revalidates the immutable owner, runtime, canonical session, agent, agent path, and canonical
   working-directory claims through the existing canonical authority resolver;
4. after the awaited authority call, synchronously re-reads the current row and clock and rejects a
   row that is absent, revoked, expired at that fresh instant, or from a prior boot;
5. at that same commit boundary, rechecks the exact permit, process-local tombstone, and the
   adapter's active object or controller identity guard;
6. updates only `expiresAt`, comparing the exact freshly observed expiry and requiring the same boot
   epoch and `revokedAt IS NULL`;
7. returns the committed expiry used to schedule the next supervisor tick.

The current `expiresAt` value is sufficient as the compare-and-set version; no schema migration or
parallel lease table is required. Concurrent renewal attempts either observe the committed expiry
or lose the compare-and-set. They cannot move an expiry backward and cannot reopen a terminal row.

Cancellation and revoke close the process-local permit and add the binding to the existing
in-process tombstone before the durable update. Replacing an adapter's active turn object or
controller synchronously invalidates the ownership guard registered with that permit, even if an
older abort signal has not fired yet. There is no awaited gap between the fresh clock/current-row,
permit, tombstone, owner-slot checks and the synchronous SQLite compare-and-set. A renewal that was
already awaiting authority therefore loses to expiry, cancellation, revocation, or slot replacement
when it resumes.

### Keep runtime attachment mechanics separate

The lifecycle contract is shared. Credential attachment remains adapter-owned:

- **Claude Code:** create no binding or timer for a turn that never calls a Connections tool. After
  the lazy first resolution succeeds, supervise the same principal until the per-turn context is
  cancelled or revoked. A warm process's next message receives a new context, permit, and bearer.
- **Codex:** open and supervise the binding under the exact active controller used by that
  `sendMessage` call. Keep the bearer placed in the subprocess's initial environment. Extending the
  same bearer avoids an impossible environment update while `codex exec` is running. Stop the
  supervisor and revoke before/while interrupting the child; the next message turn receives a new
  binding even when it resumes the same Codex thread.
- **OpenCode:** acquire the canonical-directory lease, open/register the binding, and start the
  supervisor only after `dorkos_connections` reports applied. Keep the directory lease until
  supervisor shutdown and revocation finish. Same-bearer renewal needs no mid-turn `mcp.add`; the
  next turn still has a different bearer, changes the registration signature, and re-adds under the
  same directory lease.

Moving Claude through the loopback listener or replacing these adapters with one transport is not
part of this work. The server already shares the lifecycle authority; forcing one transport would
add process and registration constraints without improving renewal safety.

## Race and failure behavior

| Race or failure                                                                                                                | Required outcome                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Renewal and terminal completion overlap                                                                                        | Terminal closes the permit and revokes; renewal cannot update the row afterward.                                                              |
| Renewal and cancellation overlap                                                                                               | Stop remains prompt; the process-local tombstone wins even if the durable revoke reports an error.                                            |
| Renewal awaits canonical authority while owner, agent, session binding, path, runtime, expiry, or the active turn slot changes | The fresh commit-boundary clock, row, authority, permit, and owner-slot checks refuse renewal. No claim is rewritten.                         |
| A connection, grant, operation revision, session override, or approval changes                                                 | Existing execution-broker guards allow or refuse each operation; the structural turn lease is unchanged.                                      |
| Two renewal callbacks overlap                                                                                                  | One compare-and-set wins; the other adopts the still-valid committed expiry or stops on a terminal state. No duplicate supervisor is created. |
| Server restarts                                                                                                                | Boot initialization revokes all prior rows; process-local permits and supervisors are gone and are never reconstructed.                       |
| Timer runs after the old expiry                                                                                                | Renewal refuses `expired`; neither stored session existence nor a live-looking sidecar revives it.                                            |
| Temporary database failure                                                                                                     | Retry the lease update with bounded backoff inside the remaining lease; do not retry provider work.                                           |
| Provider call crosses lease expiry after final dispatch authorization                                                          | Let the dispatched call settle and record its result. Expiry does not pretend the upstream call was cancelled.                                |
| A provider response permits a safe retry after expiry/revoke                                                                   | Existing principal revalidation blocks the second attempt. Return the already observed result under existing broker rules.                    |
| A provider write has an unknown outcome                                                                                        | Preserve `outcome_unknown`; renewal never makes the write retryable.                                                                          |
| Supervisor loses ownership but the session row remains                                                                         | Stop renewing. Durable session existence alone grants nothing.                                                                                |

## Security and custody

Renewal keeps the current permission model. It revalidates the structural owner, runtime, session,
agent, path, working directory, boot epoch, expiry, and exact active-turn ownership. Connection
state, exact operation revision, grant, session override, and approval remain enforced by the
execution broker for each operation; changing one can refuse that operation without ending an
otherwise valid structural turn lease. Renewal changes only the expiry of that structural principal;
it cannot alter claims or make a previously denied operation available.

The explicit tradeoff is that a stolen bearer can remain usable while the legitimate turn keeps
renewing. Its maximum remaining lifetime is still four hours after the last successful legitimate
renewal. This is longer total exposure than today's one-shot four-hour binding for a days-long turn,
but shorter than an unbounded token, and attacker traffic cannot prolong it. Immediate operator
revocation, agent/session authority changes, runtime teardown, and server restart still close it
before that horizon.

For clarity, the same stolen bearer can remain valid throughout a legitimate days-long active run
because the trusted supervisor extends that same binding. That consequence is accepted for this
design. The bearer cannot invoke the internal renewal method, cannot reconstruct the permit from
JSON or the database, and cannot extend itself after the legitimate runtime owner stops.

The renewal permit is more sensitive than a binding ID but does not need to cross a process
boundary. Logs and audit rows may include binding ID, runtime, renewal outcome, and safe refusal
reason. They must exclude bearer, token hash, permit, provider arguments/results, and credentials.

## Contract changes

Extend the internal `ConnectorRuntimePrincipalPort` with a renewal operation and an opaque
process-local permit returned by `openTurn`. Exact names may follow the implementation's type
conventions, but the semantic result must distinguish:

- `renewed` with the committed `expiresAt`;
- `refused` with an internal reason such as expired, revoked, stale boot, authority changed, or
  inactive permit;
- a thrown storage/runtime error that remains eligible only for bounded pre-expiry supervisor
  retry.

Add one shared supervisor helper with injected clock and scheduler seams. It owns no session lookup,
provider call, bearer resolution, runtime interruption, or durable reconstruction. Runtime adapters
provide the liveness proof and retain their current teardown authority.

The supervisor exposes a bounded internal state (`active`, `stopped`, or `lost`) so an adapter and
diagnostic can observe a terminal renewal failure exactly once. Renewal successes and retries are
internal bookkeeping: they do not create connector usage attempts and do not appear as provider
operations or user-facing hourly activity.

No public DTO, HTTP route, external MCP tool, CLI command, configuration field, provider port,
database column, or hosted API changes.

## Implementation phases

### Phase 1: renewable principal contract

Add the opaque in-process permit and expiry compare-and-set to the existing runtime principal
service. Keep persistence, bearer resolution, canonical authority, and revocation in that service.
Prove expiry, boot, authority, cancellation, and concurrent renewal races before any runtime starts
a timer.

### Phase 2: shared supervisor and runtime ownership

Add one clock- and scheduler-injected supervisor, then attach it at each adapter's real turn-owned
boundary. Claude starts it only after lazy Connections setup. Codex binds it to the exact active
controller while the child keeps its initial environment. OpenCode starts it only after MCP
registration and retains its canonical-directory lease through supervisor shutdown and revoke.

### Phase 3: composed boundary proof

Exercise multi-day fake-clock turns through all three runtimes and the actual private capability
seams. Prove that request traffic cannot renew, terminal lease loss is observable once, retries
cannot repeat uncertain provider writes, restart cannot recover a permit, and warm runtime
processes start the next message with fresh authority.

## Verification strategy

### Principal service and supervisor

- Exact clock tests cover one instant before expiry, exactly at expiry, and after expiry.
- Successful renewal keeps the same token hash and immutable claims, changes only `expiresAt`, and
  returns the committed deadline.
- Repeated bearer resolution and real Connections capability calls do not change expiry without a
  supervisor tick.
- Renewal after expiry, revoke, terminal teardown, authority change, or a new boot is refused and
  leaves the row terminal.
- Cancellation/revoke wins while renewal is awaiting authority. A mutant that omits the final
  permit/tombstone check must fail.
- A held canonical-authority call that resumes at or after the old expiry cannot extend the row.
  The regression advances an injected clock across expiry before releasing authority; a mutant
  that relies only on the pre-await clock must fail.
- Replacing the adapter's active turn object or controller while renewal awaits authority invalidates
  the registered ownership guard even if the old abort signal remains live. A mutant that checks
  `isCurrent()` only before awaiting authority must fail.
- Concurrent renewal callbacks have one monotonic compare-and-set result. A mutant that performs an
  unconditional expiry update must fail.
- A process-local permit cannot be serialized or reconstructed from the durable row. Public schema,
  OpenAPI, Transport, external-MCP, and CLI inventories remain unchanged.
- Supervisor tests use an injected clock/scheduler, prove hourly scheduling from returned expiry,
  bounded pre-expiry retry, timer cancellation, no post-stop callback, and no `setInterval` drift.

### Execution boundary

- A read or write dispatched after final revalidation may settle when the clock crosses expiry;
  usage records the actual result.
- Expiry or revoke before a retry produces no second provider command. Existing safe-result and
  unknown-outcome rules remain exact.
- Mutations that bypass structural renewal authority or the execution broker's per-operation
  connection, grant, revision, override, or approval checks fail their respective public-seam tests.
- An MCP client holding only the bearer cannot invoke renewal and cannot keep expiry alive through
  request traffic.

### Runtime adapters

- **Claude Code:** no Connections call means no open/renew/revoke row; lazy first use starts one
  supervisor; a days-long fake-clock turn renews; cancel and terminal teardown stop it; the next turn
  on the warm process gets a new binding.
- **Codex:** the child receives one unchanged bearer in its initial environment; supervisor renewal
  requires the exact active controller; cancellation and child/setup failure stop/revoke; a later
  message on the same thread gets a new binding.
- **OpenCode:** renewal occurs while the exact active turn owns the canonical-directory lease;
  same-bearer renewal performs no `mcp.add`; cancellation, terminal teardown, setup failure, and
  compaction handoff settle renewal/revoke before lease release; the next turn re-registers its new
  bearer.
- Shared runtime conformance runs a multi-day fake-clock turn for all three adapters and proves
  identical lease semantics while allowing their different attachment mechanisms.

### Restart and warm-process acceptance

- Real SQLite restart coverage opens and renews a binding, restarts the service, and proves the old
  bearer and permit cannot resolve or renew.
- Warm Claude, resumed Codex thread, and reused OpenCode sidecar tests prove each new message turn
  receives a fresh binding and that no prior supervisor survives.
- Tests do not depend on real waiting, provider traffic, or paid model calls.

## Acceptance criteria

- A continuously active turn can retain Connections authority across at least seventy-two hours of
  deterministic fake-clock runtime tests in Claude Code, Codex, and OpenCode.
- The lease remains four hours and renews hourly only from the exact in-process active-turn owner.
- Bearer use, stored session existence, a transcript/thread/sidecar record, and MCP registration do
  not renew or recreate authority.
- There is no automatic revival after expiry, cancellation, terminal/error teardown, server
  restart, or canonical authority change.
- Renewal changes neither the bearer nor any owner/runtime/session/agent/path claim, grant,
  connection, operation revision, or approval scope.
- Codex needs no environment mutation or subprocess restart; OpenCode needs no mid-turn MCP
  re-registration; Claude stays in process.
- Existing in-flight completion, safe-retry, and `outcome_unknown` behavior remains exact, including
  zero automatic retry of an uncertain provider write.
- No new hidden run-duration cap, public renewal endpoint, configuration field, database migration,
  or provider API is introduced.

## Resolved questions

- ~~Should runtime request activity extend expiry?~~ **No.** Only the server-owned supervisor can
  renew, so a stolen bearer cannot keep itself alive.
- ~~Should renewal rotate the bearer?~~ **No.** Extending the same binding preserves Codex's fixed
  environment and OpenCode's shared directory registration. Immediate revocation and per-call
  revalidation retain the security boundary.
- ~~Should days-long turns receive a new hard maximum?~~ **No.** No cross-runtime product policy
  currently defines one. The renewable four-hour lease bounds authority after process liveness is
  lost without silently ending legitimate work.
- ~~Can a durable session row prove the turn is alive?~~ **No.** Renewal requires an opaque
  process-local permit plus exact active-turn object/controller ownership.
- ~~Should all runtimes use the loopback transport?~~ **No.** Lifecycle is shared already. Adapter
  attachment remains specific to Claude's in-process tools, Codex's child environment, and
  OpenCode's directory-scoped sidecar.

## Source references

- `apps/server/src/services/connectors/principal/runtime-principal-service.ts`
- `apps/server/src/services/connectors/runtime-principal-port.ts`
- `apps/server/src/services/connectors/execution/execution-broker.ts`
- `apps/server/src/services/runtimes/connector-mcp/{auth,listener}.ts`
- `apps/server/src/services/runtimes/claude-code/{connector-turn-context,claude-code-runtime}.ts`
- `apps/server/src/services/runtimes/codex/{codex-runtime,codex-options}.ts`
- `apps/server/src/services/runtimes/opencode/{opencode-runtime,mcp/mcp-manager}.ts`
- `apps/server/src/services/core/agent-identity/agent-identity-service.ts`
- `apps/server/src/config/constants.ts`
