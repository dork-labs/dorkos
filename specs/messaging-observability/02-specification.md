---
slug: messaging-observability
id: 260731-191225
created: 2026-07-31
status: specified
---

# Specification: messaging observability & DX

- **Slug:** messaging-observability · **Id:** 260731-191225 · **Linear:** DOR-797
- **Anchor:** `origin/main` @ `c8f5d945d`, 2026-07-31
- **Read first:** [`01-ideation.md`](./01-ideation.md) — the incident, the evidence, and why the OpenTelemetry trace id is the wrong correlation key.
- **Governs:** `apps/server/src/lib/` (logger, new dispatch context), `apps/server/src/services/observability/`, `apps/server/src/services/rooms/`, `apps/server/src/services/session/`, `apps/server/src/services/relay/`, `apps/server/src/routes/debug.ts` (new), `packages/relay/src/relay-publish.ts`, `packages/shared/src/relay-envelope-schemas.ts`, `packages/cli/src/commands/doctor*.ts`, and a new `contributing/observability.md`.
- **Sequencing:** §11 is load-bearing. Phase 1 must land **after** `fix/room-notice-integrity` and `fix/session-spine-stall-locks-rekey`, and its relay slice **after** DOR-789.

---

## 1. The one-line statement

**One id joins every hop of a message's life, every line that mentions it says why it did what it did, and five in-memory truths become readable without a restart.**

---

## 2. Invariants — what must not break

These are constraints, not goals. A change that violates one is wrong even if it improves observability.

| #   | Invariant                                                                                                                                                                                                                    | Source                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| I1  | `POST /api/sessions/:id/messages` stays trigger-only and answers `202` without awaiting the turn. Nothing added here may make the response wait on the turn or on any observability write.                                   | ADR-0264                                                   |
| I2  | The turn runs detached (`void turn;`). Correlation context must be established around **the detached turn**, not the request — a scope tied to the HTTP request dies at the 202 and would leave the whole turn uncorrelated. | ADR-0264                                                   |
| I3  | Tracing stays **off by default** with zero cost: no OTel module import, no provider, no span. Nothing in this spec may activate it.                                                                                          | ADR 260711-154514                                          |
| I4  | Span attributes stay allowlisted, opaque, and content-free. A new attribute key is a deliberate addition to `ATTR` with a justification that its value is opaque.                                                            | ADR 260711-154514 §4                                       |
| I5  | Nothing phones home. Every artifact here is local: a file, a process-memory buffer, or a localhost read.                                                                                                                     | ADR 260711-141639                                          |
| I6  | The messaging hot path pays nothing for observability it does not emit. See the performance contract, §9.                                                                                                                    | AGENTS.md quality standard                                 |
| I7  | No log line, span, debug response, or doctor output carries message content, prompts, file contents, tokens, or credentials.                                                                                                 | ADR 260711-154514 §4, existing `request-logger.ts` posture |
| I8  | No new database table and no migration.                                                                                                                                                                                      | Scope decision, §10                                        |

---

## 3. The correlation spine

### 3.1 The id

A single domain identifier, named **`dispatchId`**, formatted `dsp_<ULID>`.

- **camelCase**, matching the 41-to-0 evidence for context-key casing.
- **Prefixed**, so `grep dsp_` finds every correlated line in a file and a bare id is self-describing when a user pastes one into an issue. The prefix is three characters against a 26-character ULID — a negligible token cost for a large grep-ability gain.
- **ULID, not UUID**, because ULIDs sort lexicographically by mint time, so a `sort` over ids recovers dispatch order. `monotonicFactory()` from `ulid` is already a dependency of `packages/relay`.
- **Opaque and random.** It derives from nothing — not a path, not a name, not a session id. This is what makes it admissible under I4.

**One dispatch = one agent's response to one trigger.** A room entry addressed to three agents produces one `entryId` and **three** `dispatchId`s. The fan-out is recovered by `entryId`, which already exists and is already logged by `fix/room-notice-integrity`; no second id is minted for it.

**Minted at every turn ingress**, so the field means the same thing everywhere:

| Ingress          | File                                                      | Mint point                                                                  |
| ---------------- | --------------------------------------------------------- | --------------------------------------------------------------------------- |
| Room dispatch    | `services/rooms/room-trigger.ts`                          | inside `runOne`, once per `(entry, target)` pair, before the claim is taken |
| Interactive turn | `routes/sessions.ts` → `services/session/trigger-turn.ts` | in the route, before `triggerTurn`, so the id exists for the 202 path too   |
| Task run         | `services/tasks/task-scheduler-service.ts`                | in `executeRun`                                                             |
| Relay inbound    | `services/relay/binding-router.ts`                        | in `handleInbound`, if the envelope does not already carry one              |

**Never re-minted mid-chain.** The runtime handing back a canonical session id (`room-trigger.ts:618` placeholder → `rebindRoomSession`) does **not** change the `dispatchId`. That is the entire point: the dispatch id is stable exactly where the session id is not.

New module `packages/shared/src/dispatch-id.ts`, exported as `@dorkos/shared/dispatch-id` (a new entry in the `exports` map):

```ts
/** Mint a new opaque, time-sortable dispatch correlation id. */
export function newDispatchId(): string;
/** Whether a string is a well-formed dispatch id. */
export function isDispatchId(value: string): boolean;
/** The `dsp_` prefix, exported so log tooling and docs share one literal. */
export const DISPATCH_ID_PREFIX = 'dsp_';
```

It lives in `shared` rather than `apps/server` because `packages/relay` (which already depends on `@dorkos/shared`) needs `isDispatchId` to validate an envelope field.

### 3.2 How it rides inside the process — AsyncLocalStorage

New module `apps/server/src/lib/dispatch-context.ts`:

```ts
/** The correlation context carried across one dispatch's async chain. */
export interface DispatchContext {
  /** Opaque `dsp_`-prefixed correlation id. Never content-derived. */
  readonly dispatchId: string;
  /** Coarse origin of the dispatch, for grouping. */
  readonly origin: 'room' | 'session' | 'task' | 'relay';
  /** The room entry this dispatch answers, when the origin is a room. */
  readonly entryId?: string;
}

/** Run `fn` with a dispatch context bound to the current async chain. */
export function runInDispatch<T>(ctx: DispatchContext, fn: () => T): T;
/** The active dispatch context, or `undefined` outside any dispatch. */
export function currentDispatch(): DispatchContext | undefined;
/** The active dispatch id, or `undefined`. Convenience for log/span call sites. */
export function currentDispatchId(): string | undefined;
```

One `AsyncLocalStorage<DispatchContext>` instance, module-private. `runInDispatch` is called **once per dispatch**, never per event.

**I2 compliance.** In `trigger-turn.ts` the scope must wrap the construction of the detached generator pipeline — the `tapEachEvent → withStallGuard → guardTurnErrors → feedProjector` chain and the `void turn;` — not the awaited `Promise.race([firstEvent, delay(CANONICAL_ID_TIMEOUT_MS)])`. An async generator created inside an ALS scope keeps that scope for its whole life, so the detached turn stays correlated after the 202 returns. A scope placed around the awaited race instead would expire at the 202 and correlate nothing. **This is the single most likely implementation error in the phase and must have a dedicated test.**

**Where the context is provably lost, and why that is accepted:**

| Boundary                             | Behaviour                                                 | Verdict                                                                              |
| ------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| SSE fan-out to `/events` subscribers | Runs in each subscriber's request context; no dispatch id | Accepted — the subscriber is not the thing being diagnosed. Documented in the guide. |
| The relay bus                        | A new envelope, possibly a new process                    | Handled explicitly by §3.4, not by ALS                                               |
| Timers registered at module load     | No scope                                                  | Not on the dispatch path                                                             |

### 3.3 How it reaches the log — one reporter, zero call-site edits

`createFileReporter()` in `apps/server/src/lib/logger.ts` gains **one read**: if `currentDispatchId()` returns a value and the entry does not already carry `dispatchId`, add it.

```ts
const dispatchId = currentDispatchId();
const entry = JSON.stringify({
  level: logObj.type,
  time: logObj.date.toISOString(),
  msg: msgParts.join(' '),
  tag: logObj.tag || extractTag(msgParts[0]),
  ...(dispatchId ? { dispatchId } : {}),
  ...context,
});
```

Two properties make this the highest-leverage change in the spec:

1. **Every existing log line inside a dispatch gains correlation without being edited** — including all nine lines the two in-flight branches are adding.
2. The read happens **only when a line is actually written**, after the level filter, so a suppressed `debug` costs nothing (I6).

An explicit `dispatchId` in a call site's context object wins over the ambient one, so a caller that legitimately logs about a _different_ dispatch is not silently mislabelled.

### 3.4 How it crosses the relay bus — the envelope, and the column that was waiting

`RelayEnvelopeSchema` (`packages/shared/src/relay-envelope-schemas.ts`) gains one **optional** field:

```ts
dispatchId: z.string().optional().describe('Opaque correlation id joining every hop of one dispatch'),
```

Optional, so every existing producer and every persisted maildir envelope stays valid. This is an OpenAPI-registered schema, so the change requires regenerating the API docs (`pnpm docs:export-api` then `pnpm generate:api-docs` — both, per the `api-reference.md` note).

`RelayPublishPipeline.publish` (`packages/relay/src/relay-publish.ts`) takes `dispatchId` through `PublishOptions`, stamps it on the envelope, and — the payoff — passes it to `recordTrace`:

```ts
deps.traceStore?.insertSpan({
  messageId,
  traceId: options.dispatchId ?? messageId,  // was: traceId: messageId
  ...
});
```

Today `traceId === messageId` on every row, so every trace has exactly one span and `TraceStore.getTrace(traceId)` can only return the row you already had. With this one-line change, all hops of one dispatch share a `traceId` and `getTrace` returns a real multi-hop trace for the first time. **No schema change, no migration** (I8) — the column, the index, and the query already exist.

`BindingRouter.handleInbound` reads `envelope.dispatchId`, mints one if absent, and forwards it on the republish — closing the gap where the inbound and outbound `messageId`s of a single logical delivery are unrelated ULIDs.

### 3.5 The OTel bridge

`ATTR` gains one key:

```ts
/** Opaque `dsp_`-prefixed dispatch correlation id; joins spans to NDJSON log lines. */
DISPATCH_ID: 'dorkos.dispatch_id',
```

Set on all four existing spans (`session.turn`, `runtime.send_message`, `relay.dispatch`, `task.run`) from `currentDispatchId()`. Admissible under I4 on the same grounds as `dorkos.session_id`: opaque, random, never content-derived — and `isDispatchId` makes that checkable.

Spans stay flat. No `startActiveSpan`, no context propagation, no span tree. The dispatch id is what joins them, which is precisely the gap ADR 260711-154514 recorded as its accepted negative — closed here without reopening the decision.

---

## 4. Log conventions

### 4.1 Context keys

**camelCase**, units in the name (`durationMs`, `heldMs`, `waitedMs`, `inactivityMs`), ids as `<noun>Id`.

One documented exception: keys that mirror a Claude Agent SDK field verbatim keep the SDK's spelling — `toolUseID`, `agentID` (both added by `fix/session-spine-stall-locks-rekey`). Rationale: a reader grepping the SDK's own docs finds the same string. This is an exception to be _listed_, not a precedent to extend; a new key that is not an SDK field is camelCase.

Errors go through the existing `logError(err)` helper, producing `{ error, stack? }`. Passing a bare `{ err }` (an Error object serialized by `JSON.stringify`, which drops `message` and `stack`) is a defect.

### 4.2 Tags

The `'[tag] message'` string prefix stays — ~90 tags across hundreds of call sites against 3 uses of `createTaggedLogger`. Two corrections:

**Lift the tag into the NDJSON field.** `createFileReporter` extracts a leading `/^\[([a-zA-Z0-9:_-]+)\]\s/` from the message into `tag`, leaving `msg` unchanged. `logObj.tag` (set by `createTaggedLogger`) still wins when present. This retrofits hundreds of existing lines into a filterable field, makes `jq 'select(.tag=="rooms")'` work as `debug:logs` already advertises, and touches exactly one function.

**A tag registry**, in `contributing/observability.md`: one table of the tags in use, their owning directory, and their casing. New tags are added to the table in the same PR that introduces them. The first entry it must resolve is live today: `fix/room-notice-integrity` tags the stall warn `[session]` while `fix/session-spine-stall-locks-rekey` tags it `[stall-guard]` — the same event, two tags, in one file. `[stall-guard]` wins (it names the mechanism, not the whole domain); whichever branch merges second reconciles to it.

Tags are lowercase-kebab and name the mechanism or domain: `[rooms]`, `[stall-guard]`, `[relay]`, `[canUseTool]` (an existing SDK-mirroring exception).

### 4.3 Levels

| Level   | Earns it                                                                                                                                         |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `error` | The operation failed and nothing downstream will retry. A turn died.                                                                             |
| `warn`  | Someone waited and got less than they asked for: a refusal the user cannot see, a drop, a timeout, a kill, a budget denial, a degraded fallback. |
| `info`  | Lifecycle: dispatch start/end, claim hold/release, turn start/end, approval requested, a refusal the user _can_ see.                             |
| `debug` | Per-event and per-decision detail.                                                                                                               |

### 4.4 The refusal rule

> **Every path that declines to do the obvious thing logs exactly one line, carrying `reason`, `visibility`, and (ambiently) `dispatchId`.**

- `reason` is a value from a **closed union** in code, never a free-form string, so `jq 'group_by(.reason)'` works without parsing prose.
- `visibility` is `'shown' | 'damped' | 'silent'` — was the person told, was the notice suppressed, or was there never a notice.
- **Level follows visibility:** `shown` → `info`; `damped` or `silent` → `warn`.

That last clause is a deliberate, small amendment to `fix/room-notice-integrity`, which logs `[rooms] an agent did not answer` at `info` with `{ reason, damped }`. When `damped: true` the user was never told, so the log line is the _only_ record that anything happened — exactly the class of event that produced two invisible ten-minute silences in the incident. One conditional on an existing line.

**The gap neither branch fills.** `interactive-handlers.ts` now logs approval _requests_ at `info`, but nothing logs an approval **timing out** at `INTERACTION_TIMEOUT_MS`. Add, where the projector expires a pending interaction:

```ts
logger.warn('[canUseTool] approval expired without an answer', {
  sessionId,
  toolName,
  toolUseID,
  waitedMs,
  visibility: 'silent',
});
```

An audit pass over the dispatch path applies the rule to every remaining silent refusal: cascade-guard denials, turn-budget exhaustion, relay budget/consent gate rejections, session-busy skips, and bind failures.

---

## 5. Diagnostic read surfaces

### 5.1 Posture

A new router at **`/api/debug`**, mounted in `index.ts` (it needs the singleton graph), **always mounted**, **read-only**, inheriting the app-wide `hostGuard` + `sessionGate` stack. No new middleware, no env gate.

The reasoning is the deciding one: `test-control.ts`'s pattern (mount only when an env var is set) would make the surface unavailable in exactly the situation it exists for — a user's machine, mid-incident — because enabling it requires a restart, and a restart destroys the in-memory state you wanted to read.

It earns "always mounted" by obeying the **same content discipline as `attributes.ts`**: ids, counts, durations, coarse enums, ISO timestamps. No message text, no prompts, no paths, no agent-authored strings. Every handler is a `GET`; there is no mutating verb in this router.

### 5.2 Routes

| Route                                  | Returns                                                                                                                                                                                                          | Kind                  |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `GET /api/debug/dispatches`            | live claims: `{ roomId, authorId, entryId, cascadeRoot, dispatchId, claimedAt, heldMs }[]` + the recent-dispatch ring buffer                                                                                     | live + buffer         |
| `GET /api/debug/sessions/:id`          | `{ sessionId, canonicalId, runtime, lifecycle, epoch, seq, subscribers, ringSize, eventLogSize, lockHeldBy, lockAcquiredAt, lastActivityAt, pendingInteractions: [{ kind, toolName, startedAt, remainingMs }] }` | point-in-time         |
| `GET /api/debug/projectors`            | registry: `{ sessionId, epoch, seq, subscribers, lastEventAt }[]`                                                                                                                                                | point-in-time         |
| `GET /api/debug/rooms/:id/bindings`    | `{ authorId, sessionId, boundAt, transcriptExists, transcriptPath: null }[]`                                                                                                                                     | point-in-time + probe |
| `GET /api/debug/refusals?limit=N`      | refusal ring buffer: `{ at, dispatchId, origin, roomId?, authorId?, sessionId?, reason, visibility }[]`                                                                                                          | buffer                |
| `GET /api/debug/relay/traces/:traceId` | the spans of one dispatch from `TraceStore.getTrace`                                                                                                                                                             | DB read               |

Notes that matter:

- `transcriptExists` answers the incident's "bindings pointing at ids with no transcript" directly. It is a boolean from an `fs.existsSync` against the slug computed by `projectSlug()` — the byte-exact SDK slug algorithm that `fix/session-spine-stall-locks-rekey` introduces in `sessions/project-slug.ts`. **The path itself is never returned** (I7); only the boolean.
- `pendingInteractions` reuses `SessionStateProjector.hasPendingInteractions` / `listPendingInteractions` from the same branch.
- `/api/debug/relay/traces/:traceId` is only meaningful once §3.4 lands, because until then every trace has one span.

### 5.3 Buffers and retention

Two bounded, process-lifetime, in-memory ring buffers in `apps/server/src/services/observability/`:

- **recent dispatches** — 256 entries: `{ dispatchId, origin, startedAt, endedAt, outcome, roomId?, sessionId? }`
- **refusals** — 256 entries: the shape above

Never written to disk, never persisted, dropped on restart. The NDJSON log is the durable record; a persisted buffer would be a second, worse log with its own retention and rotation problems. Fixed-size arrays with a write cursor — no allocation per write beyond the record itself.

### 5.4 CLI reachability

`dorkos debug <subject> [--json]`, where subject is `dispatches | session <id> | projectors | rooms <id> | refusals`. Registered by the argv-interception pattern in `cli.ts`, handler at `packages/cli/src/commands/debug.ts` returning an exit code, using `apiCall` + `printJson`/`renderTable` from `lib/operator-output.js` — identical in shape to `commands/capabilities.ts`. Human table by default, raw JSON on `--json`.

---

## 6. Doctor

### 6.1 Shape

`dorkos doctor` keeps its `CheckResult { label, status, detail?, fix? }` model, its renderer, and its "only `fail` exits non-zero" rule. Three additions:

1. **`--json`** — emits `CheckResult[]` via `printJson`, matching the operator-verb convention. Nothing else on stdout, so it pipes into `jq`.
2. **`--deep`** — additionally calls `GET /api/health/deep` and merges the returned `CheckResult[]` into the same checklist. When no server is reachable, `--deep` degrades to one `info` line ("DorkOS is not running; skipped the checks that need it") and never fails.
3. **`pnpm doctor:dev`** — a repo-local script running the contributor-only checks. Same `CheckResult` type, same renderer, different audience.

### 6.2 The split, and why

| Check                                                                    | Home               | Why                                               |
| ------------------------------------------------------------------------ | ------------------ | ------------------------------------------------- |
| Stale `@dorkos/shared` dist (dist older than newest `src`)               | `doctor:dev`       | A user installed from npm has no dist to be stale |
| Orphaned tsx watchers (stray `tsx watch` processes)                      | `doctor:dev`       | Only exists in the dev loop                       |
| `better-sqlite3` ABI mismatch (poisoned by the desktop Electron rebuild) | `doctor:dev`       | Caused by `apps/desktop`'s rebuild, only in-repo  |
| File-descriptor headroom (`ulimit -n` vs. a floor; EMFILE/chokidar risk) | `dorkos doctor`    | A real user-machine failure                       |
| Room session bindings with no transcript                                 | `/api/health/deep` | Needs the room store + the runtime slug           |
| Relay binding ghosts (bindings whose adapter is gone)                    | `/api/health/deep` | Needs the binding store + adapter registry        |
| Quarantined access rules                                                 | `/api/health/deep` | Needs the live config graph                       |
| Unparsed adapter catalog entries                                         | `/api/health/deep` | Needs the adapter plugin loader                   |
| Duplicate mesh agent ids                                                 | `/api/health/deep` | Needs `MeshCore`                                  |

Putting the three contributor checks in the shipped `dorkos doctor` would add noise to a user-facing surface to serve contributors — the "every element justifies its existence" filter says no.

### 6.3 `GET /api/health/deep`

A separate route from `GET /api/health`, which stays exactly as it is (a fast liveness probe with `status`, `version`, `uptime`, optional `tunnel` — it must not become slow, and things depend on its shape). `/api/health/deep` returns `{ checks: CheckResult[] }` and always answers `200`; a failing check is data, not an HTTP error. The `CheckResult` type moves to `@dorkos/shared` so the CLI and server share one definition rather than two that drift.

Every check is read-only and content-free (I7): a check reports _that_ a binding has no transcript and how many, never the transcript path or the room's text.

---

## 7. Dev-loop DX

**`contributing/observability.md`** — a new guide (there is no logging or observability guide in `contributing/` today, across 36 files). Outline:

1. _What the system already writes_ — the NDJSON log and its fields; the four OTel spans and how to turn them on; the relay trace table.
2. _The dispatch id_ — what it is, where it is minted, where it is lost (the SSE fan-out), and how to follow one.
3. _Log conventions_ — camelCase keys with the two SDK exceptions; the level table; the refusal rule; the tag registry.
4. _Recipes_ — the `jq` one-liners below.
5. _Reading a room incident_ — a worked example following the 2026-07-31 exchange end to end using the surfaces this spec adds. This section is what makes the guide worth writing.
6. _Diagnostic surfaces_ — the `/api/debug` routes and their CLI equivalents.
7. _Doctor_ — what each check means and how to add one.

Register it in `contributing/INDEX.md` (Guide Coverage Map row with source patterns `lib/logger|services/observability/|routes/debug|doctor-checks`, plus a Maintenance Tracking row), then regenerate `.claude/scripts/docs-coverage-map.json` via `node .claude/scripts/docs-coverage-map.mjs --regen`.

**The recipes** (these are the deliverable, not decoration):

```bash
L=~/.dork/logs/dorkos.log   # dev: apps/server/.temp/.dork/logs/dorkos.log

# Everything in one dispatch, in order
jq -c 'select(.dispatchId=="dsp_01J...")' "$L"

# Every dispatch that produced a warning, newest first
jq -rc 'select(.level=="warn") | [.time,.dispatchId,.tag,.msg] | @tsv' "$L" | tail -50

# Why agents stayed quiet, grouped
jq -c 'select(.reason)' "$L" | jq -s 'group_by(.reason) | map({reason:.[0].reason, n:length})'

# Refusals nobody saw
jq -c 'select(.visibility=="damped" or .visibility=="silent")' "$L"

# One room's whole life
jq -c 'select(.roomId=="<id>")' "$L"

# Live tail, warnings and worse only
tail -f "$L" | jq -c --unbuffered 'select(.level=="warn" or .level=="error" or .level=="fatal")'
```

Both `.claude/commands/debug/logs.md` and `.claude/commands/debug/api.md` gain a pointer to the guide and to `dispatchId` as the first filter to reach for.

**`pnpm dev` noise**: measure before cutting. Capture a clean startup, count lines by tag and level, and only then decide what drops to `debug`. Asserting the output is too loud without counting is how a useful line gets deleted.

**Explicitly deferred: a cockpit debug panel or in-app log viewer.** It is a user-facing surface subject to the demo-claim gate; it duplicates what §5 plus `--json` already answer; and the same idea has sat at "FUTURE" in `research/20260301_logging_review.md` for five months without anyone needing it. The condition that reopens it: operators writing their own scripts against `/api/debug` often enough that a UI is owed.

---

## 8. What changes for a person

Nothing user-facing. No UI, no copy, no new setting, no behaviour change in any room, session, or message. The demo-claim gate is not engaged, and no claim about the Obsidian plugin, the Windows alpha, Mesh+Relay, or marketplace compatibility is made or implied.

The one thing a user could notice is second-order and good: when they report a problem, the answer arrives faster, and `dorkos doctor` tells them about a broken setup before they file anything.

---

## 9. Performance contract

I6 is testable, not aspirational. The obligations:

| Mechanism                             | Cost when inactive                                                                                | Cost when active                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `runInDispatch`                       | not called                                                                                        | one `AsyncLocalStorage.run` per **dispatch** (never per event) |
| `currentDispatchId()` in the reporter | one `als.getStore()` — and only after the level filter has already passed                         | same                                                           |
| Ring buffers                          | one array write per dispatch and per refusal                                                      | same                                                           |
| OTel `dispatch_id` attribute          | `startSpan` already returns the shared no-op when tracing is off; the attribute is never computed | one `setAttribute`                                             |
| `/api/debug/*`                        | routes idle; no polling, no timer, no background work                                             | one request                                                    |
| `transcriptExists` probe              | not called                                                                                        | one `existsSync` per binding, on request only                  |

Two rules for implementation: **no dispatch context is created per stream event** (the tap runs per event and must only _read_), and **no observability work happens on the awaited portion of the 202 path** (I1).

---

## 10. Excluded, deliberately

- **Replacing consola with pino.** The current NDJSON output already satisfies `research/20260301_ai_parseable_logging.md` on format, naming, rotation, and self-containment. A swap is churn with no diagnostic gain.
- **Nested OTel span trees / span-context propagation.** ADR 260711-154514 accepted flat spans; the dispatch id closes the gap that decision left open without reopening it.
- **PostHog or any remote error sink.** Plane-1 consent territory; needs its own ADR.
- **Routing `packages/relay` and `packages/mesh` `console.*` through the server logger.** Real (the 2026-03 review's Priority 1), separable, and deliberately not a dependency — §3.4 keeps the id on the envelope and records it server-side precisely so this spec does not need it.
- **Client logging, the dead `verboseLogging` toggle, error boundaries.**
- **Any new table or migration** (I8). The `relayTraces.traceId` column already exists.
- **Persisting the ring buffers.**
- **A cockpit debug panel** (§7).

---

## 11. Phases and sequencing

### The in-flight constraint, first

| In-flight work                                                  | Files it owns                                                                                                                 | Effect on this spec                                                                                                                                                                                                                             |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fix/room-notice-integrity` (PR #657)                           | `rooms/room-trigger.ts`, `room-turn-runner.ts`, `room-service.ts`, `room-notices.ts`, `mentions.ts`, `session/stall-guard.ts` | **Blocks Phase 1.** Phase 1 edits three of these files.                                                                                                                                                                                         |
| `fix/session-spine-stall-locks-rekey`                           | `session/trigger-turn.ts`, `session-lock.ts`, `session-state-projector.ts`, `stall-guard.ts`, `interactive-handlers.ts`       | **Blocks Phase 1.** Phase 1's ALS scope goes inside `trigger-turn.ts`, which this branch restructures. Phase 3 _depends_ on its `hasPendingInteractions()` and `projectSlug()`.                                                                 |
| Both, on `stall-guard.ts`                                       | same file, both add a stall warn with different tags and keys                                                                 | **A conflict between the two branches, not with this spec.** Second-to-merge rebases; reconcile to `[stall-guard]` per §4.2.                                                                                                                    |
| DOR-789 (relay trace honesty)                                   | `packages/relay/src/relay-publish.ts` `recordTrace`, trace statuses, `error_message`/`delivered_at`, DLQ counting             | **Blocks Phase 1's relay slice only.** The `traceId = dispatchId ?? messageId` line is inside the function DOR-789 rewrites. Land DOR-789 first; the change then reduces to one line.                                                           |
| DOR-784 (room-turn session events, `awaiting_approval` notices) | rooms + session events                                                                                                        | **No conflict; align vocabulary.** DOR-784's `awaiting_approval` notice is the `visibility: 'shown'` counterpart to §4.4's approval-expiry warn. Whichever lands second reuses the other's `reason` values rather than inventing parallel ones. |

Neither branch adds any correlation, trace, or dispatch id, and neither adds an HTTP route — so **nothing in this spec is already built**, and §8 of the ideation lists what not to re-propose.

### Phase 1 — the correlation spine _(blocked on both branches; relay slice blocked on DOR-789)_

`packages/shared/src/dispatch-id.ts` + `exports` entry · `apps/server/src/lib/dispatch-context.ts` · `runInDispatch` at the four ingresses · reporter injection in `logger.ts` · `ATTR.DISPATCH_ID` + the four span call sites · `RelayEnvelopeSchema.dispatchId` + OpenAPI regen · `PublishOptions.dispatchId` + `traceId = dispatchId ?? messageId` · `BindingRouter` forwarding.

Scope: **medium**. ~10 files, mostly small; the two hard parts are the `trigger-turn.ts` scope placement (I2) and the OpenAPI regeneration.

### Phase 2 — conventions and the guide _(design frozen by Phase 1; §2.1–2.2 need Phase 1 merged)_

Tag extraction in `createFileReporter` · the tag registry, resolving `[session]` vs `[stall-guard]` · the refusal-rule audit over the dispatch path, including the level-follows-visibility amendment and the missing approval-expiry warn · `logError` consistency pass · `contributing/observability.md` + INDEX registration + coverage-map regen · pointers from `debug:logs` / `debug:api`.

Scope: **medium**. The audit is the bulk; the guide is the deliverable.

### Phase 3 — diagnostic read surfaces _(depends on Phase 1 for buffer contents; depends on `fix/session-spine-stall-locks-rekey` for `hasPendingInteractions` and `projectSlug`)_

`routes/debug.ts` + the six handlers · the two ring buffers · claim-map and projector-registry accessors · `packages/cli/src/commands/debug.ts` + argv interception.

Scope: **medium-large**. Mostly new files, which keeps merge risk low; the accessors are the only edits to existing services.

### Phase 4 — doctor _(independent — can start immediately, in parallel with Phase 1)_

`CheckResult` moved to `@dorkos/shared` · `--json` · `GET /api/health/deep` + the five server-side checks · `--deep` merge and its degradation · `pnpm doctor:dev` + the three contributor checks · the file-descriptor check in the shipped doctor.

Scope: **medium**. Touches no messaging file, so it carries no conflict risk with anything in flight — **this is the phase to start on day one.**

### Phase 5 — dev-loop noise _(depends on Phase 2's guide)_

Measure `pnpm dev` startup output; reclassify what the measurement justifies; record the counts in the guide.

Scope: **small**.

**Critical path:** branches merge → Phase 1 → Phase 2 → Phase 3 → Phase 5, with Phase 4 running alongside from the start.

---

## 12. Verification

| Claim                                  | How it is proved                                                                                                                                                                                            |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The id survives the detached turn (I2) | Trigger a turn, let the 202 resolve, assert log lines emitted **after** the response still carry the same `dispatchId`. Fails if the scope is placed around the awaited race.                               |
| One entry, three agents, three ids     | Room test with three targets: three distinct `dispatchId`s, one shared `entryId`.                                                                                                                           |
| A rekey does not change the id         | Placeholder session id → canonical rebind; `dispatchId` is byte-identical before and after.                                                                                                                 |
| Existing lines gain the id for free    | A log call with no `dispatchId` in its context, made inside a dispatch, produces a line carrying one.                                                                                                       |
| The relay trace is a real trace        | Publish through two hops with one `dispatchId`; `getTrace(dispatchId)` returns >1 span. Asserting `>1` is the whole point — today it is always exactly 1.                                                   |
| The tag field is populated             | `logger.info('[rooms] x')` yields `{"tag":"rooms","msg":"[rooms] x"}` — `msg` unchanged.                                                                                                                    |
| Damped refusals are `warn`             | Force a damped refusal; assert `level: 'warn'`, `visibility: 'damped'`, and a `reason` from the union.                                                                                                      |
| Approval expiry is logged              | Let a pending interaction reach `INTERACTION_TIMEOUT_MS`; assert one `warn` with `waitedMs`.                                                                                                                |
| Debug routes leak nothing (I7)         | Poison a room with message text, an absolute path, and a token; snapshot every `/api/debug/*` response and assert none survives — mirroring the existing span-poisoning test in `observability/__tests__/`. |
| Zero cost when inactive (I6)           | Assert `runInDispatch` is not called outside a dispatch, and that a filtered-out `debug` call performs no `getStore()`.                                                                                     |
| Doctor `--deep` degrades               | With no server running, `--deep` exits `0` with one `info` line.                                                                                                                                            |
| Nothing is user-facing                 | No `apps/client` or `apps/site` file changes in Phases 1–5.                                                                                                                                                 |

Standard gates: `pnpm verify`, `pnpm test -- --run` (never bare `pnpm vitest run` for a full pass), and — because `RelayEnvelopeSchema` is OpenAPI-registered — both `pnpm docs:export-api` and `pnpm generate:api-docs`, or `openapi-fresh` goes red.

---

## 13. Follow-ups

- **ADRs to seed** (three decisions here are load-bearing and reversible only at cost):
  1. _A domain dispatch id, not the OpenTelemetry trace id, is the messaging correlation key_ — with the three pieces of evidence from ideation §3, and the supersession of `research/20260216_logging_strategy.md`'s "correlation ids provide minimal value".
  2. _AsyncLocalStorage carries dispatch context, and the file reporter injects it_ — including the boundaries where it is provably lost.
  3. _The diagnostic read surface is always mounted and read-only, earning it by carrying only what a span may carry_ — and why an env gate would defeat the purpose.
- **`specs/manifest.json` registration.** This spec is not yet registered in the root manifest; the ideation and specification were written as intent-stage artifacts in the main checkout. Register at status `specified` before DECOMPOSE.
- **Relay/mesh `console.*` logger injection** — the 2026-03 review's Priority 1, deliberately excluded here (§10), still worth its own ticket.

**Next step: DECOMPOSE.**
