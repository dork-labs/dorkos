# Observability

How to find out what a DorkOS server actually did — the log it writes, the id that joins one message's hops together, the read surfaces that expose state which is otherwise only in memory, and the doctor that checks a machine before anyone files a bug.

Pair this guide with:

- [`specs/messaging-observability/02-specification.md`](../specs/messaging-observability/02-specification.md) — the authoritative spec. If this guide and the spec disagree, the spec wins and this file needs a patch.
- [`specs/messaging-observability/01-ideation.md`](../specs/messaging-observability/01-ideation.md) — the 2026-07-31 incident that produced all of this, and why the OpenTelemetry trace id was the wrong correlation key.
- [ADR 260711-154514](../decisions/260711-154514-otel-spans-local-debug-trace.md) — tracing is off by default, spans are flat, attributes are allowlisted.
- [ADR-0264](../decisions/0264-server-owned-durable-resumable-session-stream.md) — the detached turn, which is why correlation scoping is subtle.

## 1. The one-paragraph version

A message's life crosses six mechanisms with six id vocabularies. One `dispatchId` now joins them, and the file reporter stamps it onto every log line written inside the dispatch, so `jq -c 'select(.dispatchId=="dsp_…")'` reconstructs one exchange in order. Every path that declines to do something writes exactly one line saying why and whether anybody saw it. The pieces of state that only ever lived in process memory are readable at `GET /api/debug/*` and from `dorkos debug`. Tracing stays off by default and nothing here turns it on.

## 2. What the system writes

### The NDJSON log

`apps/server/src/lib/logger.ts` — consola with a file reporter appending one JSON object per line to `<dorkHome>/logs/dorkos.log`, rotating daily and by size into `dorkos.YYYY-MM-DD.N.log`, keeping 14 files.

| Field        | Always | Meaning                                                                    |
| ------------ | ------ | -------------------------------------------------------------------------- |
| `level`      | yes    | `fatal` \| `error` \| `warn` \| `info` \| `debug` \| `trace`               |
| `time`       | yes    | ISO 8601                                                                   |
| `msg`        | yes    | The message, `[tag]` prefix included                                       |
| `tag`        | mostly | Lifted out of the `[tag]` prefix by the reporter — see §4.2                |
| `dispatchId` | no     | Added by the reporter when the line was written inside a dispatch — see §3 |
| …            |        | Everything else is the call site's own context object, spread flat         |

Log level: `debug` in development, `info` in production, overridable with `dorkos --log-level <fatal|error|warn|info|debug|trace>`.

### The four OTel spans

`apps/server/src/services/observability/` — `session.turn`, `runtime.send_message`, `relay.dispatch`, `task.run`. **Off by default and free when off**: `initObservability` returns before importing any OTel module, `startSpan` returns a shared no-op, and the runtime/relay proxies hand back the original object. Turn it on two ways, both the operator's own choice:

```bash
dorkos --debug-trace                          # sanitized JSONL under <dorkHome>/traces/
OTEL_EXPORTER_OTLP_ENDPOINT=http://…  dorkos  # your own stack, batched OTLP/HTTP
OTEL_SDK_DISABLED=true                        # universal kill switch
```

Span attributes are **allowlisted** in `services/observability/attributes.ts`. The file span processor drops any key not in `ATTR`, so a trace file can only ever contain durations, counts, opaque ids, and coarse enums. Adding a key is a deliberate act that needs a justification that its value is opaque.

### The relay trace table

`relayTraces` — `messageId`, `traceId`, `subject`, `status`, `sentAt`, `deliveredAt`, `errorMessage`, `metadata`. Every hop of one dispatch shares a `traceId` (the dispatch id), so `TraceStore.getTrace(dispatchId)` returns a real multi-hop trace. Read it with `dorkos debug trace dsp_…`.

## 3. The dispatch id

### What it is

`dsp_<ULID>` — opaque, random, monotonic, and derived from nothing. `packages/shared/src/dispatch-id.ts`.

- **Prefixed** so `grep dsp_` finds every correlated line and a bare id pasted into an issue is self-describing.
- **A monotonic ULID** so a plain `sort` over ids recovers dispatch order, even within one millisecond.
- **Opaque** so it is admissible as a span attribute under the no-PII allowlist. `isDispatchId()` makes that checkable rather than asserted.

**One dispatch = one agent's response to one trigger.** An entry addressed to three agents produces one `entryId` and **three** dispatch ids. The fan-out is recovered by the entry; each agent's own chain is recovered by its dispatch.

### Where it is minted

| Ingress          | File                                       | Mint point                                          |
| ---------------- | ------------------------------------------ | --------------------------------------------------- |
| Room dispatch    | `services/rooms/room-trigger.ts`           | per `(entry, target)` pair, as the target is built  |
| Interactive turn | `routes/sessions.ts`                       | in the route, before `triggerTurn`                  |
| Task run         | `services/tasks/task-scheduler-service.ts` | in `executeRun`                                     |
| Relay inbound    | `services/relay/binding-router.ts`         | in `handleInbound`, unless the envelope carries one |

**Never re-minted mid-chain.** The runtime handing back a canonical session id does not change it. That is the entire point: the dispatch id is stable exactly where the session id is not.

### How it travels

**Inside the process** — one `AsyncLocalStorage` in `lib/dispatch-context.ts`, entered once per dispatch. `createFileReporter` reads it, so every existing log line inside the chain gains the field without being edited. An explicit `dispatchId` in a call site's context object wins over the ambient one.

**Across the relay bus** — an optional `dispatchId` field on `RelayEnvelope`, forwarded on the republish and used as the `traceId` of the recorded span.

### The scoping rule that matters

`runInDispatch` must wrap the **construction** of a detached async chain, not an `await` that settles before the chain does. An async generator created inside an ALS scope keeps that scope for its whole life, so a turn that outlives its 202 stays correlated — but a scope placed around only the awaited part expires at the response and correlates nothing. `routes/__tests__/sessions-dispatch-correlation.test.ts` fails if that placement moves.

### Where it is provably lost

| Boundary                             | Behaviour                                 | Verdict                                          |
| ------------------------------------ | ----------------------------------------- | ------------------------------------------------ |
| SSE fan-out to `/events` subscribers | Runs in each subscriber's request context | Accepted — the subscriber is not being diagnosed |
| The relay bus                        | A new envelope, possibly a new process    | Handled by the envelope field, not by ALS        |
| Timers registered at module load     | No scope                                  | Not on the dispatch path                         |
| `packages/relay`, `packages/mesh`    | They log through their own `console.*`    | Deliberately out of scope; separate ticket       |

## 4. Log conventions

### 4.1 Context keys

**camelCase**, units in the name (`durationMs`, `heldMs`, `waitedMs`, `inactivityMs`), ids as `<noun>Id`. There are 41 camelCase `xxxId:` keys in logger call sites and zero snake_case ones; this is settled by practice, not preference. (`session_id` and friends appear in SDK payloads and MCP tool schemas — external wire formats, not logging.)

**One documented exception:** a key that mirrors a Claude Agent SDK field verbatim keeps the SDK's spelling — `toolUseID`, `agentID` — so a reader grepping the SDK's own docs finds the same string. This is an exception to be _listed_, not a precedent to extend.

**Errors go through `logError(err)`**, which produces `{ error, stack? }`:

```ts
logger.warn('[rooms] triggered turn failed', { roomId, authorId, ...logError(err) });
```

Passing a bare `{ err }` is a defect: `JSON.stringify` drops an `Error`'s `message` and `stack` because both are non-enumerable, so the line records `{"err":{}}`. **DOR-802 tracks fixing the reporter to serialize `Error` objects properly**; until it lands, `logError(err)` is the only pattern that puts the failure in the file. Do not mass-convert existing `{ err }` sites in the meantime — the reporter fix will make them correct on their own.

### 4.2 Tags

The `'[tag] message'` string prefix is the convention — roughly 90 tags across hundreds of call sites, against three uses of `createTaggedLogger`. The reporter lifts a leading `/^\[([a-zA-Z0-9:_-]+)\]\s/` into the `tag` field while leaving `msg` untouched, which is what makes `jq 'select(.tag=="rooms")'` match anything.

**New tags are lowercase-kebab and name the mechanism or domain.** Existing PascalCase tags (`[Extensions]`, `[Marketplace]`, `[HarnessSync]`) are legacy and are not being renamed; a rename would break every filter anyone has saved. The tag registry for the dispatch path — the part this guide governs — is:

| Tag                      | Owning directory                         | Notes                                                                                            |
| ------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `[rooms]`                | `services/rooms/`                        | Claims, notices, refusals, presence                                                              |
| `[stall-guard]`          | `services/session/stall-guard.ts`        | The inactivity watchdog. Names the mechanism, not the domain                                     |
| `[relay]`                | `services/relay/`                        | Inbound routing and its refusals                                                                 |
| `[claude-code]`          | `services/runtimes/claude-code/`         | Runtime-specific, including expired prompts                                                      |
| `[canUseTool]`           | `messaging/interactive-handlers.ts`      | SDK-mirroring exception, kept for grep parity                                                    |
| `[phantom-cancellation]` | `observability/phantom-cancellations.ts` | The DOR-1087 tripwire. Written by BOTH claude-code senders, so it is one tag, not one per sender |
| `[POST /messages]`       | `routes/sessions.ts`                     | The interactive turn ingress                                                                     |
| `[DorkOS]`               | `index.ts`                               | Process lifecycle: boot, routes mounted, shutdown                                                |

Add a row here in the same PR that introduces a tag. To see every tag currently in use:

```bash
grep -rhoE "logger\.(debug|info|warn|error)\(\s*['\`]\[([a-zA-Z0-9:_-]+)\]" apps/server/src \
  | sed -E "s/.*\[([a-zA-Z0-9:_-]+)\]/\1/" | sort | uniq -c | sort -rn
```

### 4.3 Levels

| Level   | Earns it                                                                                                                                         |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `error` | The operation failed and nothing downstream will retry. A turn died.                                                                             |
| `warn`  | Someone waited and got less than they asked for: a refusal the user cannot see, a drop, a timeout, a kill, a budget denial, a degraded fallback. |
| `info`  | Lifecycle: dispatch start/end, claim hold/release, turn start/end, approval requested, a refusal the user _can_ see.                             |
| `debug` | Per-event and per-decision detail. Mechanical bootstrap detail belongs here, not at `info`.                                                      |

### 4.4 The refusal rule

> **Every path that declines to do the obvious thing logs exactly one line, carrying `reason`, `visibility`, and (ambiently) `dispatchId`.**

Use `logRefusal` from `services/observability/refusals.ts`. It is the only correct way to write one:

```ts
logRefusal('[rooms] an agent did not answer', {
  reason: 'agent_busy', // a value from the closed REFUSAL_REASONS union
  visibility: damped ? 'damped' : 'shown',
  roomId,
  authorId,
  entryId,
  detail: { cascadeRoot, busyWith },
});
```

- **`reason`** comes from a closed union, never a free-form string, so `jq 'group_by(.reason)'` works without parsing prose. Adding a reason means adding it to `REFUSAL_REASONS` with a one-line meaning.
- **`visibility`** is `'shown' | 'damped' | 'silent'` — was the person told, was a notice suppressed as a repeat, or is there no notice for this path at all.
- **Level follows visibility.** `shown` → `info`; `damped` or `silent` → `warn`. `logRefusal` does this for you and it is not overridable.
- **`dispatchId` is ambient by default, and you must override it when ambient would lie** — see below.

#### When ambient correlation is a lie

The reporter stamps every line with the dispatch scope it was written in. For a refusal decided _inside_ the dispatch it is about, that is exactly right and you write nothing. Two shapes make it wrong, and both are on the messaging path:

| Shape                                                                                      | What ambient gives you       | Pass                         |
| ------------------------------------------------------------------------------------------ | ---------------------------- | ---------------------------- |
| The refusal is decided **before** the dispatch exists, or **after** its scope has returned | Nothing, or a bystander's id | The id explicitly, or `null` |
| The frame is running inside **somebody else's** dispatch                                   | That other dispatch's id     | `null`, or the right id      |

The second one is the dangerous one, and it is not hypothetical. `RoomTriggerDispatcher.claimTargets` runs **synchronously inside `RoomService.post`** — and when the post is an agent's reply, that is inside the _replying_ agent's dispatch scope. Left ambient, a cascade refusal about Bo is filed under Ana's dispatch id, and `jq 'select(.dispatchId=="<ana>")'` returns a refusal that has nothing to do with her. **A missing field is legible; a bystander's id is a lie the tooling cannot detect**, so the three-state field exists to make "there is no dispatch" sayable:

```ts
logRefusal('[rooms] the guard stopped an exchange', {
  reason: 'cascade_depth',
  visibility: 'silent',
  dispatchId: null, // absent → inherit ambient · a string → this one · null → none, ever
});
```

`null` is a _suppression_, not a fallback: it puts a present-but-undefined key on the entry, which beats the reporter's injection and is then dropped by `JSON.stringify`. The same rule already governs the claim lines in `room-trigger.ts`, which pass `dispatchId` explicitly because a claim is taken before `runOne` enters its scope and released from `halt()` with no scope at all.

Rule of thumb: **if the line is written outside the `runInDispatch` that owns it, say which dispatch it belongs to.**

That last clause is the rule that would have changed the 2026-07-31 incident. A damped refusal means the person was never told, so the log line is the only record that anything happened — and a record filed at `info` beside the ones they _did_ see is a record nobody looks at.

**Report visibility after attempting the notice, not before.** A notice the room could not write (an archive between the post and the notice) leaves the person exactly as uninformed as a damped one, and the line has to say `silent` rather than claiming it was shown.

Every refusal `logRefusal` writes is also kept in a 256-entry in-memory ring, readable at `GET /api/debug/refusals`.

## 5. Diagnostic read surfaces

### Posture

`GET /api/debug/*` is **always mounted**, **read-only**, and inherits the app-wide `hostGuard` + `sessionGate` stack with no carve-out. When local login is on it needs the operator's credential exactly like `/api/sessions` does; when login is off it is as reachable as every other API route, which is the same posture the whole API has.

The alternative — mount only when an env var is set, like `routes/test-control.ts` — would make the surface unavailable in exactly the situation it exists for: a user's machine, mid-incident, where enabling it needs a restart and a restart destroys the in-memory state you wanted to read.

It earns that by obeying the **same content discipline as the span allowlist**: ids, counts, durations, coarse enums, ISO timestamps. No message text, no prompts, no file paths, no agent-authored strings. `transcriptExists` is the sharpest case — the question is about a path and the answer is a boolean, because the path never crosses the boundary. `routes/__tests__/debug.test.ts` poisons every reachable input and asserts none of it survives.

### Routes

| Route                                  | Answers                                                          |
| -------------------------------------- | ---------------------------------------------------------------- |
| `GET /api/debug/dispatches`            | Live room claims + the recent-dispatch ring (`?limit=`)          |
| `GET /api/debug/refusals`              | The refusal ring (`?limit=`)                                     |
| `GET /api/debug/phantom-cancellations` | The phantom-cancellation tripwire: counts by path, recent rows   |
| `GET /api/debug/projectors`            | Every live projector: seq, subscribers, waiters, buffer sizes    |
| `GET /api/debug/sessions/:id`          | One session: lifecycle, lock, pending interactions, durable rows |
| `GET /api/debug/rooms/:id/bindings`    | Whether each of a room's agent sessions has a transcript on disk |
| `GET /api/debug/relay/traces/:traceId` | Every hop of one dispatch across the bus                         |

Buffers are 256 entries each (the phantom ring is 64), process-lifetime, **never written to disk**. The NDJSON log is the durable record; a persisted ring would be a second, worse log with its own retention problems.

#### The phantom-cancellation tripwire

`services/observability/phantom-cancellations.ts` counts one specific bug rather than answering an incident question: the Claude Code CLI writing its interrupt sentinel as a `tool_result` when no operator decision is behind it, so the model reads a refusal nobody made (DOR-1087; eight in one session on 2026-08-09, zero real denies). Detection lives in `runtimes/claude-code/messaging/phantom-cancellation.ts`; this module only counts, and both senders record through it — so `byPath.turn` is the resume-per-message path and `byPath.pump` is the persistent one. That split is the measurement in spec `persistent-session-runtime` task 5.1, which tests the claim that persistence removes the class. Every hit also writes one `[phantom-cancellation]` warning carrying the running totals, so a log outlives the process the counter died with.

### From a terminal

```bash
dorkos debug dispatches                 # who is working, and what ran recently
dorkos debug refusals --limit 20        # what was declined, and whether anyone saw it
dorkos debug projectors                 # live streams and their subscribers
dorkos debug phantoms                   # work the runtime cut short by mistake (DOR-1087)
dorkos debug session <session-id>
dorkos debug room <room-id>
dorkos debug trace dsp_01J…
dorkos debug refusals --json | jq 'group_by(.reason)'
```

### Deliberately not built

**A cockpit debug panel or in-app log viewer.** It is a user-facing surface subject to the demo-claim gate, it duplicates what these routes plus `--json` already answer, and the same idea has sat at "FUTURE" in `research/20260301_logging_review.md` for five months without anyone needing it. The condition that reopens it: operators writing their own scripts against `/api/debug` often enough that a UI is owed.

## 6. Recipes

```bash
L=~/.dork/logs/dorkos.log   # dev: apps/server/.temp/.dork/logs/dorkos.log

# Everything in one dispatch, in order
jq -c 'select(.dispatchId=="dsp_01J…")' "$L"

# Every dispatch that produced a warning, newest first
jq -rc 'select(.level=="warn") | [.time,.dispatchId,.tag,.msg] | @tsv' "$L" | tail -50

# Why agents stayed quiet, grouped
jq -c 'select(.reason)' "$L" | jq -s 'group_by(.reason) | map({reason:.[0].reason, n:length})'

# Refusals nobody saw
jq -c 'select(.visibility=="damped" or .visibility=="silent")' "$L"

# One room's whole life
jq -c 'select(.roomId=="<id>")' "$L"

# One tag only, now that the tag field is populated
jq -c 'select(.tag=="rooms")' "$L"

# Live tail, warnings and worse only
tail -f "$L" | jq -c --unbuffered 'select(.level=="warn" or .level=="error" or .level=="fatal")'
```

## 7. Reading a room incident, end to end

The worked example, using the 2026-07-31 exchange as the shape. A room has gone quiet and somebody wants to know why.

**1. Find the dispatch.** Start from what you can see — the room.

```bash
jq -rc 'select(.roomId=="<room-id>") | [.time,.level,.dispatchId,.msg] | @tsv' "$L" | tail -40
```

An entry addressed to three agents gives you three `dispatchId`s under one `entryId`. Pick the agent that went quiet.

**2. Follow that one dispatch.**

```bash
jq -c 'select(.dispatchId=="dsp_…")' "$L"
```

You should see `[rooms] an agent took a room turn` → the turn's own lines → `[rooms] an agent finished a room turn` with `heldMs` and `outcome`. What the incident showed instead was a hold with no release, which localises the problem immediately.

**3. Ask what it is waiting on**, while it is still running:

```bash
dorkos debug session <session-id>
```

`pendingInteractions` with a `remainingMs` counting down is a turn parked on a person — the incident's actual cause, invisible for forty-one minutes because nothing recorded it. `lockHeldBy` tells you whether another client is holding the write lock.

**4. Check what was refused, including what nobody saw.**

```bash
dorkos debug refusals --json | jq '.refusals[] | select(.visibility!="shown")'
```

`interaction_expired` at `warn` is a prompt that timed out with nobody watching. `agent_busy` with `visibility: "damped"` is a refusal the room deliberately swallowed as a repeat.

**5. Check the bindings still point at real conversations.**

```bash
dorkos debug room <room-id>
```

`transcriptExists: false` means the room remembers a session id the runtime never wrote a transcript for — the incident's last symptom, and the one that costs an agent its memory of the room.

**6. If a chat integration is involved**, the dispatch id is also the trace id:

```bash
dorkos debug trace dsp_…
```

More than one span means the message crossed the bus and you can see where it stopped.

## 8. Doctor

`dorkos doctor` checks a machine from cold: Node, the data directory, the port, the Claude CLI and its auth, per-runtime auth, extensions, auth config, tunnel config, and file-descriptor headroom. `--json` emits the raw `CheckResult[]`. `--deep` additionally calls `GET /api/health/deep` and merges the server's own checks into the same checklist; with no server reachable it degrades to one `info` line and never fails.

The split is by what a check can see. A user who installed from npm has no `@dorkos/shared` dist to be stale and no `tsx` watcher to orphan, so the contributor-only checks live in `pnpm doctor:dev` — same `CheckResult` type, same renderer, different audience. Checks that need the live singleton graph (room bindings without transcripts, relay binding ghosts, quarantined access rules, unparsed adapter entries, duplicate mesh agent ids) live behind `/api/health/deep`.

`/api/health/deep` always answers `200`: a failing check is a fact about the machine, not a failed request. It is gated even though `/api/health` is exempt — including when the path is spelled with a trailing slash, which is how an earlier version of that carve-out leaked the whole report with no credential.

Adding a check: write a pure function returning a `CheckResult`, add it to `doctor-checks.ts` (cold) or `services/observability/deep-health/checks.ts` (needs the server), and wire it into the list in `run.ts`. Every deep check is contained — one that throws costs its own line, never the whole report.

## 9. Startup noise

Measured rather than asserted, because cutting a useful line is easy and noticing you did is not. A steady-state `pnpm dev` startup, as of 2026-08-01:

| Measure                 | Before | After |
| ----------------------- | ------ | ----- |
| Log records             | 72     | 61    |
| `info`                  | 56     | 45    |
| `debug`                 | 16     | 16    |
| Records with no `[tag]` | 8      | 2     |
| `warn` / `error`        | 0      | 0     |

Eleven of those 56 `info` lines were `[X] Routes mounted`, which is eleven lines to say "routes mounted" — nothing varying, nothing anyone reads. They are now one `[DorkOS] routes mounted { routers: … }`. The two remaining untagged records are in `packages/relay`, whose logging is a separate ticket by design.

Reproduce the measurement:

```bash
pnpm dev   # let it settle, then count:
grep -c '^ℹ' <captured-output>
```

**Before cutting anything else, count.** Asserting the output is too loud without counting is how a useful line gets deleted.

## 10. Performance contract

Observability the messaging hot path does not emit costs it nothing.

| Mechanism                             | Cost when inactive                                                    | Cost when active                         |
| ------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------- |
| `runInDispatch`                       | not called                                                            | one `ALS.run` per **dispatch**           |
| `currentDispatchId()` in the reporter | one `getStore()` — and only after the level filter has already passed | same                                     |
| Ring buffers                          | one array write per dispatch and per refusal                          | same                                     |
| OTel `dispatch_id` attribute          | `startSpan` returns the shared no-op before reading it                | one `setAttribute`                       |
| `/api/debug/*`                        | routes idle; no polling, no timer, no background work                 | one request                              |
| `transcriptExists` probe              | not called                                                            | one `existsSync` per binding, on request |

Two rules when adding to any of this: **no dispatch context is created per stream event** (the per-event tap may only _read_), and **no observability work happens on the awaited portion of the 202 path**.

## 11. Rules of thumb

1. If you add a log line inside the dispatch path, you get `dispatchId` for free. Add it by hand when the ambient scope is not the dispatch the line is about — a different one, or none (§4.4, "When ambient correlation is a lie").
2. If your line says "we are not doing the thing", it is a refusal — use `logRefusal`, not `logger.warn`.
3. If your line opens with `[tag]`, the tag becomes a filter. Pick one that already exists, or add a row to §4.2.
4. If you want to expose new state at `/api/debug`, first ask whether every field could be a span attribute. If any could not, it does not go.
5. Never log a prompt, a message body, a file path, a token, or an agent-authored string. `logError(err).error` is a message, which is usually fine; `err.stack` carries paths, which is why it is a separate field you can drop.
