---
slug: messaging-observability
id: 260731-191225
created: 2026-07-31
status: ideation
---

# Ideation: forty-one minutes, three log lines

- **Slug:** messaging-observability · **Id:** 260731-191225 · **Linear:** DOR-797
- **Anchor:** `origin/main` @ `c8f5d945d`, 2026-07-31
- **In flight while this was written:** `fix/room-notice-integrity` (PR #657), `fix/session-spine-stall-locks-rekey`, queued DOR-789 (relay trace honesty), queued DOR-784 (room-turn session events). Section 8 records exactly what each already adds so this spec does not re-propose it.

---

## 1. The incident, and the one number that matters

On 2026-07-31 a single room exchange ran **41 minutes**. Inside those 41 minutes: 5 model turns, 4 system notices, 2 approval prompts that each sat unanswered for the full 10-minute interaction timeout without anyone being told, a stall-watchdog kill, a projector rekey collision that displaced a live subscriber, and room session bindings left pointing at session ids that have no transcript on disk.

The server wrote **three log lines**.

That ratio is the whole ticket. Every individual mechanism in that list behaved close to how it was designed to behave; the failure was that a person — and, more to the point, an agent asked to diagnose it — could not reconstruct what happened from the artifacts the system left behind. Deep reviews of rooms, session, relay and client each independently landed on the same conclusion, and several fixes are already in flight.

This is not a request for "more logging." A system that logs more of the same shape produces a longer file that is equally unreadable. The problem has four distinguishable parts:

1. **Nothing joins the hops.** A room entry, a claim, a `triggerTurn`, a runtime turn, a reply post and a relay delivery are six events with six different id vocabularies and no shared key. Reconstruction is timestamp-guessing.
2. **The interesting states are only in memory.** The claim map, pending interactions, the projector registry, subscriber counts, room→session bindings — every one of them was the answer to a question asked during the incident, and none of them is readable from outside the process.
3. **The conventions are unstated, so they drift.** `[rooms]` vs `[SessionStateProjector]` vs `BindingRouter:`; `{ err }` vs `{ error: msg }`; a refusal logged at `info` in one file and not at all in another. The 2026-03 review already catalogued this and it has not improved.
4. **Recurring environment failures have no check.** Stale `@dorkos/shared` dists, orphaned tsx watchers, a `better-sqlite3` poisoned by the desktop Electron rebuild — each has burned an agent this month, each is trivially detectable, and none is detected.

## 2. What already exists (and is better than expected)

The instinct to reach for a new logging stack is wrong. The foundations are good; they are just not connected to each other.

**`apps/server/src/lib/logger.ts`** — consola with an NDJSON file reporter at `<dorkHome>/logs/dorkos.log`, hybrid daily + size rotation producing `dorkos.YYYY-MM-DD.N.log`. Fields are `level`, `time`, `msg`, `tag`, then a spread of the last object argument. Measured against `research/20260301_ai_parseable_logging.md`, this already implements almost every recommendation the research made — ISO-8601-prefixed rotating filenames, self-contained NDJSON lines, short field names, bounded file sizes. The two things the research asked for that are missing are a **correlation id** and a **populated `tag`**.

**`apps/server/src/services/observability/`** — a real OpenTelemetry seam, four spans (`session.turn`, `runtime.send_message`, `relay.dispatch`, `task.run`), a file exporter, an OTLP exporter, and an attribute allowlist that is the enforcement point for the no-PII contract. Governed by ADR 260711-154514 and ADR 260713-143958.

**`packages/cli/src/commands/doctor.ts` + `doctor-checks.ts`** — `dorkos doctor` already exists, with a clean `CheckResult { label, status, detail?, fix? }` model, pure check functions separated from rendering, and an exit code that is non-zero only on `fail`. Nine checks today: Node, data dir, port, Claude CLI, Claude auth, per-runtime auth, extensions, auth config, tunnel config.

**`relayTraces`** — a Drizzle table with `messageId`, `traceId`, `subject`, `status`, `sentAt`, `deliveredAt`, `errorMessage`, `metadata`, and a `getTrace(traceId)` query that joins spans into a trace. It is fully built and **currently degenerate**: `relay-publish.ts` sets `traceId = messageId` on every publish, so every trace has exactly one span and `getTrace` can only ever return the row you already had.

**`CascadeStamp { root, depth }`** — already threaded through every room reply and notice as provenance. The nearest thing to a causal chain in the codebase, but scoped to cascades, not to deliveries.

So: a good logger with no join key, a good tracing seam that is off by default, a good doctor with no messaging checks, and a trace table that has been waiting for something to put in it.

## 3. The correlation decision, and why the obvious answer is wrong

The instinctive move is "we already have OpenTelemetry, use the trace id." Three pieces of evidence say no.

**It is off by default, by decision.** ADR 260711-154514 §2: when tracing is off, `initObservability` returns before importing any OTel module, `startSpan` returns a shared no-op, and the `traceRuntime`/`traceRelay` proxies return the original object untouched. The 41-minute incident happened with tracing off — as will every incident a user reports. A correlation key that does not exist unless you already knew to turn it on is not a diagnostic; it is a rehearsal.

**The spans are flat, by decision.** The same ADR records it as an accepted negative: _"Spans are flat (not a nested trace tree): the file shows each seam's timing independently rather than a parent/child turn→runtime hierarchy."_ `startSpan` is used, not `startActiveSpan`; no context is ever made active. So even with tracing on, the OTel trace id does **not** span the chain — every span is its own root trace. Reusing it would mean first building span-context propagation, which is a much larger change that ADR 260711-154514 deliberately declined.

**The allowlist forbids it.** `ALLOWED_ATTRIBUTE_KEYS` is the no-PII enforcement point; any new id needs a deliberate addition there, with a justification that it is opaque.

The counter-move is a **domain correlation id** minted at ingress, carried in the log line, and — because it costs almost nothing — _also_ set as an allowlisted span attribute so that an operator who does turn on OTLP gets the same key joining their logs to their spans. Domain id primary, because it is the one that exists on the default path and the one `grep` can find; OTel attribute secondary, as a bridge.

There is a research report that disagrees. `research/20260216_logging_strategy.md` says: _"For a local single-user tool, correlation IDs provide minimal value… For now, `sessionId` in log entries is sufficient correlation."_ That was written in February, before rooms existed. It is now falsified by direct evidence: one room entry fans out to N agents, each acquiring a **different** session, and the session id that starts the turn is frequently **not** the session id that finishes it (`room-trigger.ts:618` mints a placeholder UUID, the runtime hands back its own canonical id, and `rebindRoomSession` reconciles them afterwards). `sessionId` is not merely insufficient — during the window where you most need to correlate, it _changes_. This ideation supersedes that recommendation on the evidence.

### Where it rides

A parameter threaded through forty functions is not going to survive review, and would fight ADR-0264's detached-turn shape besides. The two candidate mechanisms:

**AsyncLocalStorage.** Greenfield here — the only ALS in the repo is `packages/shared/src/atomic-write.ts`, used for reentrant-lock detection, not request context. One store, one `run()` per dispatch, read by the file reporter so that **every existing log line inside the async chain gains the id without being edited**. That last property is what makes it worth doing: it retrofits hundreds of call sites, including every line the two in-flight branches just added, for the price of one module.

Its failure mode is real and must be stated rather than discovered: ALS context does not cross a boundary the runtime scheduled outside the scope. Concretely — the SSE fan-out to `/events` subscribers runs in each _subscriber's_ request context, so events delivered to clients will not carry the dispatcher's id. That is acceptable (the subscriber is not the thing being diagnosed) but it must be written down.

**An explicit field on the envelope**, for the one hop ALS provably cannot cross: the relay bus. `BindingRouter.handleInbound` republishes through `relayCore.publish`, which mints a _fresh_ ULID per hop, so the inbound and outbound `messageId`s for one logical delivery are unrelated values. The correlation id must therefore be a field on `RelayEnvelope`, and — the pleasing part — stamping it into the already-existing `traceId` column turns `relayTraces` from a table of one-row traces into the multi-hop trace it was designed to be, and makes `getTrace(traceId)` meaningful for the first time.

So: ALS inside a process, an envelope field across the bus, and the existing `traceId` column as the persistence. No new table, no new query.

## 4. What the read surfaces have to answer

The test for this scope is not "what would be nice to expose" but "which questions did the 2026-07-31 incident ask that the process could not answer." Those were, exactly:

| Question asked during the incident                               | What holds the answer today                                            | Readable from outside? |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------- |
| Which agent is holding a claim, since when?                      | `ActiveClaim` map in `RoomTriggerDispatcher`, keyed `roomId\0authorId` | no                     |
| Is this turn parked on a person, and for how long?               | `SessionStateProjector` pending interactions                           | no                     |
| Which projector owns this session, and who is subscribed?        | projector registry + subscriber set                                    | no                     |
| Did an agent refuse, and was the refusal shown or damped?        | nothing — it was not recorded at all                                   | no                     |
| Does this room binding point at a session that has a transcript? | `roomSessions` rows vs. the on-disk JSONL slug                         | no                     |

Five questions, five in-memory structures, zero of them readable. That is the scope, and nothing beyond it: this is a diagnostic read surface, not an admin API.

Two design calls follow from being honest about what it is for.

**Point-in-time vs. buffered.** Four of the five are live structures and want a plain point-in-time read — no storage, no retention question, no schema. Only the fifth (refusals) and the completed-dispatch history are _past_ events, and those want small bounded in-memory ring buffers that die with the process. The durable record is the NDJSON log; a ring buffer that persists would be a second, worse log.

**The auth posture, and why gating it would defeat it.** There is no `localOnly` middleware in the codebase to opt into. The two precedents are conditional mounting on an env var (`test-control.ts`, which simply does not exist outside test mode) and an inline `router.use` refusal (`admin.ts`, which refuses when managed by the desktop shell). Copying `test-control` would be a mistake: a debug surface that requires an env var and a restart is unavailable in precisely the situation it exists for — a user's machine, mid-incident, where restarting destroys the in-memory state you wanted to read. The surface should be **always mounted and read-only**, inheriting the app-wide `hostGuard` + `sessionGate` stack, and it should earn that by carrying **only what a span may carry**: ids, counts, durations, coarse enums, timestamps. No message text, no prompts, no paths. The discipline that already makes `attributes.ts` safe to export is the same discipline that makes this safe to mount.

## 5. Conventions: what to settle, and what the code already settled

Three of the four convention questions have empirical answers in the codebase and do not need debating.

**Context keys are camelCase.** 41 `xxxId:` camelCase keys in logger call sites; zero snake_case. Settled. (`session_id` and friends appear in SDK payload shapes and MCP tool schemas — external wire formats, not logging.) The one wrinkle worth naming rather than silently tolerating: `session-spine-stall-locks-rekey` adds `toolUseID` and `agentID` with a capital `ID`, because they mirror Claude Agent SDK field names verbatim. That is a defensible exception, but it should be a _documented_ exception, not a precedent.

**Tags are a `[prefix]` in the message.** ~90 distinct bracket tags across hundreds of call sites, against exactly 3 uses of `createTaggedLogger`. Every file in the dispatch path uses the string prefix. Settled by overwhelming practice — but with a consequence nobody has noticed: because the tag lives in `msg`, the NDJSON `tag` field is **empty on almost every line**, and `jq 'select(.tag=="rooms")'` — the filter `debug:logs` advertises — matches nothing.

That is fixable in one place. The file reporter can lift a leading `[tag]` out of the message into the `tag` field while leaving `msg` intact. One function, hundreds of lines retrofitted, no call-site churn. This is the cheapest single improvement in the whole ticket.

**Levels need one rule, not a table.** The generic ladder from `research/20260216_logging_strategy.md` is fine and uncontroversial. The rule that would have changed the incident is narrower:

> **Every path that declines to do the obvious thing logs one line carrying the reason and whether the person could see it.**

Refusals, drops, damped notices, timeouts, kills, budget denials. Each gets a stable `reason` from a closed union — so `jq` can group without reading prose — and a `visibility` marker saying whether the user was told.

And the level follows from the visibility, which is the one place this ideation pushes back on an in-flight branch. `fix/room-notice-integrity` logs _"an agent did not answer"_ at `info` with `{ reason, damped }`, which is a large improvement on logging nothing. But `damped: true` means **the user was never told** — the failure is invisible in the product, so the log is the only place it exists. A refusal the user can see is `info`; a refusal that was suppressed is `warn`. Same line, one conditional, and it directly encodes the incident's "4 notices, 2 invisible timeouts."

The same rule exposes a gap neither branch fills: `interactive-handlers.ts` now logs approval _requests_ at `info`, but nothing logs an approval **timing out**. Two ten-minute silences in the incident were exactly that, and they remain unlogged after both branches merge.

## 6. Doctor: it exists, and the interesting checks are on the wrong side of a process boundary

`dorkos doctor` is already the right shape. The work is checks, `--json`, and one split.

The failure modes this week fall cleanly into two groups by what they can see:

- **No server needed** — stale `@dorkos/shared` dists, orphaned tsx watchers, `better-sqlite3` poisoned by the desktop Electron rebuild, EMFILE/descriptor headroom. Filesystem and process probes.
- **Server needed** — room bindings with no transcript, relay binding ghosts, quarantined access rules, unparsed adapter entries, duplicate mesh agent ids. All require the live singleton graph; `dorkos doctor` today talks to no server at all.

That argues for both a CLI and an API, but not as duplicates: `GET /api/health/deep` returns the **same `CheckResult[]` shape** the CLI already renders, and `dorkos doctor --deep` merges the two lists into one checklist. One renderer, one result type, two sources.

The pushback: three of the "no server needed" checks — stale dists, orphaned watchers, `better-sqlite3` — are **repo-development** failures. A user who installed from npm has no `@dorkos/shared` dist to be stale and no tsx watcher to orphan. Putting them in the shipped `dorkos doctor` would add noise to a user-facing surface to serve contributors, which fails the "every element justifies its existence" filter. They belong in a separate repo-local `pnpm doctor:dev`. Same `CheckResult` type, same renderer, different audience.

`--json` is uncontroversial and matches the established operator-verb convention (`printJson`, used by `capabilities`, `activity`, `agent`, `task`, `version`).

## 7. Dev-loop DX, and one thing to explicitly not build

The documented `jq` recipes are the highest-leverage item and cost nothing but writing: with a correlation id and a populated `tag`, "show me everything that happened in dispatch X, in order" becomes a one-liner. Those belong in a new `contributing/observability.md` — there is no logging or observability guide in `contributing/` today, across 36 files.

`pnpm dev` noise should be _measured_ before it is cut. Asserting that dev output is too loud without counting lines per startup is how a useful line gets deleted.

**The cockpit debug panel should be explicitly deferred, not quietly omitted.** It is a user-facing surface, so it would need the demo-claim gate; it duplicates what the read surfaces plus `--json` already answer; and the log-viewer idea has been sitting at "FUTURE" in the 2026-03 review for five months without anyone needing it. The condition that would bring it back: if the read surfaces get used often enough that operators are writing their own scripts against them, that is the signal a UI is owed.

## 8. What the in-flight work already covers (do not re-propose)

Read off the branch diffs on 2026-07-31.

**`fix/room-notice-integrity` (PR #657)** adds, in `room-trigger.ts`: claim hold (`[rooms] an agent took a room turn`, with `roomId/authorId/entryId/cascadeRoot`), claim release (`[rooms] an agent finished a room turn`, adding `heldMs` and a new log-only `ClaimOutcome = 'answered' | 'quiet' | 'busy' | 'failed'`), late delivery (`[rooms] a late answer landed and was posted`, with `waitedMs`), a bind failure warn, and — the important one — `[rooms] an agent did not answer` at `info` with `{ reason, damped, cascadeRoot, entryId }`, which fires on damped refusals too. In `room-service.ts`, an error line when a committed post cannot be dispatched. In `stall-guard.ts`, `logger.warn('[session] no activity from the agent; interrupting the turn', { sessionId, timeoutMs })`.

**`fix/session-spine-stall-locks-rekey`** adds, in `stall-guard.ts`, `logger.warn('[stall-guard] no activity from the runtime; interrupting the turn', { sessionId, inactivityMs, timeoutMs })` plus a paired outcome line at `info` (interrupted) or `warn` (could not interrupt), each with `{ sessionId, interrupted, elapsedMs, details }`. In `interactive-handlers.ts`, `[canUseTool] requesting approval` is **promoted from debug to info** and gains `agentID`. In `session-state-projector.ts`, the rekey-collision warn gains `endedSubscribers`. It also introduces the `LockActivity` seam, `hasPendingInteractions()`, `terminate()`, and exports `tapEachEvent`.

**Queued DOR-789** makes relay trace statuses honest and populates `error_message` / `delivered_at`, plus DLQ counting — i.e. it is already inside `recordTrace` in `relay-publish.ts`.

**Queued DOR-784** persists room-turn session events and adds `awaiting_approval` notices.

Three consequences for this spec:

1. **Both branches edit `stall-guard.ts` and both add a stall-fired warn**, with different tags (`[session]` vs `[stall-guard]`) and different keys (`timeoutMs` vs `inactivityMs` + `timeoutMs`). Whichever merges second must rebase, and one of the two tags has to lose. This is a live, concrete instance of the problem this ticket exists to fix, and it is worth naming as the first entry in the tag registry.
2. **DOR-789 owns `recordTrace`.** The `traceId = dispatchId` change lives in the same function. Sequencing, not conflict — but it must be sequenced.
3. **The correlation-id work must land after both branches**, because it edits the same three files (`room-trigger.ts`, `room-turn-runner.ts`, `trigger-turn.ts`) and because its value is partly that it retrofits the lines those branches are adding.

## 9. Assumptions

- The 41-minute incident is representative, not a one-off; the same gaps would defeat diagnosis of the next messaging incident.
- The messaging hot path is latency-sensitive enough that observability must be zero-cost when inactive, matching the posture `withSpan`/`traceRelay` already take.
- AI agents are first-class consumers of these logs, per `research/20260301_ai_parseable_logging.md` — a line must be self-contained and groupable by field, not by prose.
- No change here is user-facing, so the demo-claim gate does not bind; the deferred cockpit panel is deferred partly _because_ it would.
- ADR-0264 (trigger-only 202s, detached turns) and ADR 260711-154514 (tracing off by default, flat spans, allowlist) are constraints, not things to revisit.

## 10. Out of scope

- Replacing consola with pino. The existing NDJSON output already satisfies the research's format recommendations; swapping the library would be churn with no diagnostic gain.
- Nested OTel span trees / span-context propagation. ADR 260711-154514 accepted flat spans deliberately; nothing in the incident evidence requires a tree.
- PostHog server-side error tracking or any remote sink. That is Plane-1 consent territory and needs its own ADR.
- Routing `packages/relay` and `packages/mesh` `console.*` calls through the server logger (the 2026-03 review's Priority 1). Real, but a separable ticket — and the correlation design deliberately avoids depending on it by keeping the id on the envelope and recording it server-side.
- Client-side logging, the dead `verboseLogging` toggle, and error boundaries.
- Any new database table or migration.
- A cockpit debug panel or in-app log viewer (§7).

## 11. Recommended direction

Build the correlation spine first, on the existing infrastructure: a `dispatchId` minted at every turn ingress, carried by AsyncLocalStorage inside the process and by a `RelayEnvelope` field across the bus, injected into every NDJSON line by the file reporter, added to the OTel allowlist, and stamped into the existing `relayTraces.traceId` column. Then the conventions and the guide, then the read surfaces, then doctor.

The ordering is not arbitrary: the read surfaces are far more useful once every line they point at shares a key, and the guide cannot document conventions that are not yet decided. Doctor is genuinely independent and can run in parallel from day one.

**Next step: SPECIFY.** The design questions are answered by evidence rather than preference, and the two in-flight branches define the sequencing constraint precisely enough to write against.
