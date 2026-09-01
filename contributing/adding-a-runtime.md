# Adding a Runtime

## Overview

This guide walks through adding a new agent runtime (runtime #4) behind the `AgentRuntime` interface, using the two adapters shipped by the `additional-agent-runtimes` spec (Codex and OpenCode) as worked examples. Follow it end-to-end and your runtime gets full DorkOS treatment: session streaming, aggregated listing, permission modes, dependency checks with setup UX, and its own visual identity in every badge and picker.

Related ADRs: [0307](../decisions/0307-second-and-third-runtimes-opencode-and-codex.md) (runtime selection), [0308](../decisions/0308-opencode-adapter-managed-server-sidecar.md) (sidecar pattern), [0309](../decisions/0309-codex-adapter-sdk-threads.md) (SDK-thread pattern), [0310](../decisions/0310-runtime-owned-session-storage-aggregated-listing.md) (runtime-owned storage, registry aggregation).

## Key Files

| Concept                             | Location                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------- |
| The contract                        | `packages/shared/src/agent-runtime.ts` (`AgentRuntime`, `RuntimeCapabilities`, `DependencyCheck`) |
| StreamEvent vocabulary              | `packages/shared/src/schemas.ts` (`StreamEventSchema`, `StreamEventTypeSchema`)                   |
| Conformance suite                   | `packages/test-utils/src/runtime-conformance.ts` (`runtimeConformance`, `RuntimeConformanceOpts`) |
| Worked example: per-turn subprocess | `apps/server/src/services/runtimes/codex/`                                                        |
| Worked example: managed sidecar     | `apps/server/src/services/runtimes/opencode/`                                                     |
| Reference stateless implementation  | `apps/server/src/services/runtimes/test-mode/`                                                    |
| Runtime registry (composition)      | `apps/server/src/services/core/runtime-registry.ts` (`runtimeRegistry`)                           |
| Composition root registration       | `apps/server/src/index.ts` (registration blocks + `shutdownServices()`)                           |
| SDK confinement (ESLint)            | `apps/server/eslint.config.js`                                                                    |
| Config schema                       | `packages/shared/src/config-schema.ts` (`runtimes` block)                                         |
| Config migrations                   | `apps/server/src/services/core/config-manager.ts` (`CONFIG_MIGRATIONS`)                           |
| Shared session infrastructure       | `apps/server/src/services/session/` (lock manager, EventLog, projector, aggregation)              |
| Status-line label bound             | `packages/shared/src/constants.ts` (`STATUS_VALUE_MAX_CHARS`)                                     |
| Bound enforcement (model catalogs)  | `apps/server/src/services/runtimes/__tests__/model-catalog-labels.test.ts`                        |
| Client visual identity              | `apps/client/src/layers/entities/runtime/config/runtime-descriptors.ts`                           |
| Adapter icons                       | `packages/icons/src/adapter-logos.tsx`                                                            |
| Needs-setup UX                      | `apps/client/src/layers/entities/runtime/ui/RuntimeSetupDialog.tsx`                               |
| Runtime enum (mesh/discovery)       | `packages/shared/src/mesh-schemas.ts` (`AgentRuntimeSchema`)                                      |

## When to Use What

Two architectural decisions shape an adapter. Decide both before writing code.

**How does the backend run?**

| Backend shape                             | Pattern                                                      | Worked example                              |
| ----------------------------------------- | ------------------------------------------------------------ | ------------------------------------------- |
| SDK spawns a fresh subprocess per turn    | Facade + durable id map; no process lifecycle to own         | `codex/` (`thread-map.ts`, ADR-0309)        |
| Long-lived server the adapter must manage | Managed sidecar: lazy spawn, health check, backoff, teardown | `opencode/` (`server-manager.ts`, ADR-0308) |
| SDK manages its own long-lived process    | Facade over the SDK's process (no sidecar code)              | `claude-code/`                              |

**Where does session history live?** (ADR-0310: storage is always runtime-owned; there is no unified DorkOS transcript store)

| Backend storage               | `getMessageHistory` / `listSessions` strategy   | Worked example                           |
| ----------------------------- | ----------------------------------------------- | ---------------------------------------- |
| Native store the SDK can read | Serve from the SDK; EventLog as fallback        | `opencode/` (SDK reads its SQLite store) |
| No listing/reading API        | Stateless: serve from the DorkOS-owned EventLog | `codex/` (`readLogBackedHistory`)        |
| Native transcript files       | Parse them directly                             | `claude-code/` (JSONL)                   |

**Log-backed history is durable** (ADR 260710-024641, DOR-189): a runtime whose
history reconstructs from the DorkOS EventLog declares `logBackedHistory: true`
in its capabilities. The platform then persists each completed turn to the
SQLite `session_events` store on `turn_end` (turn-granular, never per delta),
lazily rehydrates a fresh projector — restoring `seq` continuity — and
`getMessageHistory` reads durably via `readLogBackedHistory`
(`apps/server/src/services/session/log-backed-history.ts`), so transcripts
survive a server restart with no live projector. Runtimes with their own native
transcripts (claude-code JSONL) must NOT declare it — their EventLog is
gap-replay overflow only, and persisting it would double-store. On the adapter's
read paths, pass `{ persist: true }` to `getOrCreateProjector` (see
`codex-runtime.ts`); the trigger path enables it automatically from the
capability flag.

## The AgentRuntime Contract

`packages/shared/src/agent-runtime.ts` is the whole surface. Routes and services depend only on this interface, never on a concrete adapter. The method groups, and what each demands of a new adapter:

- **Session lifecycle** (`ensureSession`, `hasSession`, `forkSession`, `updateSession`, `renameSession`): `ensureSession` receives a resolved `SessionOpts` (permission mode already decided by the caller); it must be cheap and idempotent. Backends without native fork/rename return `null` / no-op honestly (see `CodexRuntime`).
- **Messaging** (`sendMessage`): an `AsyncGenerator<StreamEvent>`. This is the heart of the adapter; see [The StreamEvent Contract](#the-streamevent-contract) below.
- **Interactive flows** (`approveTool`, `submitAnswers`, `submitElicitation`, `stopTask`, `interruptQuery`): return `false` for interactions your backend cannot support, and declare that honestly in capabilities (Codex sets `supportsToolApproval: false` because `codex exec` closes stdin after the prompt; OpenCode sets it `true` and routes `approveTool` to `POST /session/{id}/permissions/{permissionID}`). `approveTool`'s `options` carries `alwaysAllow` on an approval and `denyReason` on a refusal; deliver the reason to your backend if it has a channel for one, and — this is the part that matters — only tell the projector `reasonGiven: true` when you actually did. The transcript receipt's "agent was told why" is that flag and nothing else, so a runtime that drops the reason must stay silent rather than claim it (OpenCode's respond endpoint takes `once`/`reject` and does exactly that).
- **Stop is bounded (C11, DOR-1299).** If `interruptQuery` (or `stopTask`) awaits a backend ack over any wire — an SDK control call, an HTTP request to a sidecar — that ack can go unanswered forever on a wedged backend, and an unbounded `await` there means Stop does nothing until the backend ends on its own. Race the ack against a wall-clock bound instead (claude-code's `sessions/bounded-control.ts`, `STOP_ACK_TIMEOUT_MS`; opencode's `INTERRUPT_ACK_TIMEOUT_MS` in `runtime-constants.ts`) and answer honestly on expiry — `true` only for a call you know reached the backend, `false` otherwise, with an escalation to a session-scoped kill ONLY if you have one (claude-code closes the CLI subprocess; opencode manages exactly ONE `opencode serve` child for the whole server, shared by every session across every project, so it has none, and expiry is a plain `false`). A backend with nothing to await — a synchronous local abort, like codex's `controller.abort()` — is bounded by construction and owes the suite nothing extra. Conformance case C11 proves it: wire `RuntimeConformanceOpts.hangingInterrupt` to stage a genuinely open turn whose interrupt call your test double never acks, and the case races your real `interruptQuery` against a generous ceiling; omit the driver and C11 still runs, asserting the at-rest call resolves without spending real wall-clock time (the shape a truly synchronous interrupt has).
- **Emitting an `approval_required`**: include `timeoutMs` — the budget after which the ask is auto-denied and the run continues. The card's countdown is gated on it, so a card raised without one shows no deadline at all.
- **Storage queries** (`listSessions`, `getSession`, `getMessageHistory`, `getSessionSnapshot`, `subscribeSession`, `subscribeSessionList`, `getSessionTasks`, `getSessionETag`, `getLastMessageIds`, `getSessionCwd`, `readFromOffset`): serve from your backend's native storage or the EventLog (see the split below). `getSession` returns `Session | null`, never throws, and must stamp `runtime: this.type`. `getSessionCwd` is optional (DOR-1322): a synchronous, best-effort answer to "what directory is this session id bound to right now", using only a LIVE binding your adapter already holds — no directory lookup, no filesystem scan. Omit it and callers fall back to an explicit `projectDir`; implement it and C10 holds you to the same shape `getLastMessageIds` already assumes internally (claude-code's is `this.sessionStore.findSession(sessionId)?.cwd`): it must answer `undefined` for an id you have never heard of, and **must never throw, for any id** — a route that calls it is on a graceful-degradation path and has nowhere to send an exception.
- **Do not populate `origin`, `originLabel` or `originRoomId`.** They are server-owned: the session-origin overlays (`apps/server/src/services/session/origin/`) stamp them from DorkOS's own records of which sessions are room turns and which are scheduled runs, on both the REST routes and the global session-list stream. A runtime that filled them in would be overwritten on every read and would be guessing at facts it cannot see. (The one exception is historical and claude-code-only: it derives `origin` from durable markers in its transcript head, and the overlays still win.) `SessionSchema` keeps all three optional, so the conformance suite asks nothing of you here.
- **Locking** (`acquireLock`, `releaseLock`, `isLocked`, `getLockInfo`): do not hand-roll. Instantiate the shared `SessionLockManager` from `apps/server/src/services/session/session-lock.ts` and delegate, exactly as both new adapters do:

  ```typescript
  import { SessionLockManager } from '../../session/session-lock.js';

  private readonly locks = new SessionLockManager();
  ```

- **Capabilities** (`getCapabilities`, `getSupportedModels`, `getSupportedSubagents`, `checkDependencies`): see the next two sections.
- **Lifecycle** (`checkSessionHealth`, `getInternalSessionId`): `getInternalSessionId` is a loaded gun; see [Common Traps](#common-traps).
- **Optional DI setters** (`setSessionSettings`, `setMeshCore`, `setRelay`, `setManagedMcpServers`, ...): implement `setSessionSettings` so per-session settings (model, permission mode) hydrate from and write through to the durable `session_metadata` store (ADR-0260). The composition root injects `runtimeRegistry` as the port. If you declare `supportsManagedMcpServers: true`, implement `setManagedMcpServers(resolver: ManagedMcpServerResolver)` too — nothing else enforces that link, so a runtime that declares the capability but skips the setter ships a UI affordance ("Add server" on an agent profile's Tools & MCP page) that silently does nothing. Codex and OpenCode are the worked examples (`setManagedMcpServers` in their runtime files); the composition root wires it via `runtime.setManagedMcpServers?.(agentMcpServerService)`.

### RuntimeCapabilities

`getCapabilities()` returns a static `RuntimeCapabilities` object. Keep it in a `runtime-constants.ts` (`CODEX_CAPABILITIES`, `OPENCODE_CAPABILITIES` are the models). Three parts deserve care:

- **`permissionModes` is structured, and every mode declares what it does.** Enumerate the modes your backend genuinely supports as `PermissionModeDescriptor[]` plus a `default` id, or declare `{ supported: false, values: [] }` for no picker at all. Draw ids from the shared `PermissionModeSchema` enum (`packages/shared/src/schemas.ts`) when a mode must persist in `session_metadata`.

  Beyond `id`/`label`, four fields are **required** and carry the mode's meaning. The client derives every warning, tint, and caption from them by uniform rules (`@dorkos/shared/permission-semantics`) — there is no id table anywhere that a new runtime can be missing from, which is exactly why these are not optional:

  | Field     | Values                                          | What it answers                                                     |
  | --------- | ----------------------------------------------- | ------------------------------------------------------------------- |
  | `stop`    | `ask` \| `act` \| `autonomy`                    | Which of the three fixed dial positions this mode is                |
  | `asks`    | `always` \| `when-risky` \| `never`             | How often it actually stops to ask, as YOUR backend behaves         |
  | `reach`   | `read` \| `edit` \| `workspace` \| `everything` | How far its actions can go, whether or not it asks first            |
  | `promise` | one plain sentence                              | What happens, in the person's words — shown verbatim as the caption |

  `native` is optional: your own name for the mode when it differs from `id` (Codex declares `native: 'workspace-write'`).

  **Declare `asks` from measured behavior, not from the mode's name.** Where it disagrees with the position's canonical expectation (`ask`→always, `act`→when-risky, `autonomy`→never) the UI says so out loud rather than hiding it — that divergence signal is the whole reason the field is separate from `stop`. Codex is the worked example: `workspace-write` sits at the middle stop but has no approval channel at all, so it declares `asks: 'never'` and its `promise` names the consequence.

  ```typescript
  permissionModes: {
    supported: true,
    default: 'default',
    values: [
      {
        id: 'default',
        label: 'Read only',
        description: 'Sandboxed reads — no edits, no commands, no network.',
        stop: 'ask',
        // Nothing to ask about: this mode cannot write, run, or fetch.
        asks: 'never',
        reach: 'read',
        promise: 'Reads files and answers questions. Nothing on your machine changes.',
        native: 'read-only',
      },
      {
        id: 'acceptEdits',
        label: 'Workspace write',
        stop: 'act',
        // Measured: this backend cannot pause mid-turn, so it never asks.
        asks: 'never',
        reach: 'workspace',
        promise: "Edits files and runs commands inside the workspace — Codex can't pause to ask.",
        native: 'workspace-write',
      },
    ],
  }
  ```

  **`permissionModes.denyReason` gates the deny-reason text field on the client, not just the receipt's honesty above.** Optional, defaults to `true`. Set it `false` when your `approveTool` deny path has nowhere to deliver a free-text reason — OpenCode sets it `false` because `POST /session/{id}/permissions/{permissionID}` takes `once`/`reject` and nothing else. Leaving it unset on a runtime with no channel would show the field anyway and let a person type into a void; declaring it hides the affordance instead of offering one that silently goes nowhere (DOR-825).

  Two conformance assertions to know about: `default` must reference a declared descriptor, **and** that descriptor's `stop` must not be `'autonomy'` — a runtime whose fresh sessions start with the keys handed over fails. If yours genuinely must (test doubles), declare `autonomyDefaultReason` in your `runtimeConformance` call; it takes a sentence, not a boolean.

  `reach: 'read'` is load-bearing and narrow: it means no writes, no commands, **and no network**. The derivation rules treat a read-only mode as having nothing to warn about, so a mode that can still fetch a URL must declare `'edit'` or wider.

- **`settings` is required, and it is what puts your runtime on the Settings > Runtimes page.** Declare it next to `permissionModes`.

  | Field            | Type                       | What it answers                                                                                                                                                                                                                                                                            |
  | ---------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | `configSection`  | `string \| null`           | Which key under `runtimes.*` in user config holds this runtime's default model, effort and trust stop (`claudeCode`, `codex`, `opencode`). `null` when the runtime has no config section, and then it never appears in `executionDefaults.perRuntime` (`test-mode` is the worked example). |
  | `supportsEffort` | `boolean`                  | Whether your backend can be asked for more or less thinking at all. Per-model rungs are a separate, catalog-level fact (`ModelOption.supportsEffort` / `supportedEffortLevels`); both gates apply. OpenCode declares `false` because its prompt body carries no effort field.              |
  | `sections`       | `RuntimeSettingsSection[]` | Ordered bespoke panels your settings card renders, by `kind`. Empty for most runtimes.                                                                                                                                                                                                     |

  The client's renderer registry (`apps/client/src/layers/features/settings/ui/runtimes/section-registry.tsx`) has shipped: a section appears only if the client has a renderer registered for its kind; an unknown kind renders nothing, deliberately, so an older cockpit against a newer server degrades instead of crashing. Declaring a new kind is therefore a two-sided change: the declaration here, and the renderer in the client. Claude Code's `claude-accounts` and OpenCode's `opencode-power-source` are the two registered kinds today.

  The declaration carries no dynamic state. Account lists, the current provider, and readiness ride `GET /api/config` and `GET /api/system/requirements`, which refetch; capabilities are cached with `staleTime: Infinity` and would go stale if any of that lived here.

  Claude Code's real declaration:

  ```typescript
  settings: {
    configSection: 'claudeCode',
    supportsEffort: true,
    sections: [{ kind: 'claude-accounts' }],
  },
  ```

  Two conformance assertions to know about: `configSection` must be `null` or a non-empty string, and every declared `sections` kind must be unique.

- **Three disposition flags are required, and every one is a promise the degradation ladder routes on** (spec `persistent-session-runtime` §P4). A message can arrive at a busy session three ways, and these say which your backend can actually do:

  | Flag                        | What it claims your backend can do                                                                                                                |
  | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `supportsPersistentSession` | Hold ONE backend process open across turns instead of starting fresh work each time — the usual prerequisite for the other two, but not absolute. |
  | `supportsSteer`             | Hand a message to the agent MID-TURN so it changes course now, rather than waiting for the running turn to finish.                                |
  | `supportsContextStaging`    | Append context to the conversation WITHOUT provoking a turn.                                                                                      |

  There is deliberately **no `supportsQueue`**: the server owns the queue for every runtime, so queueing is true by construction and a flag saying so could only ever be wrong. Queue is the floor the ladder degrades to.

  **Declare these from MEASURED behavior, not from the flag's name** — the same discipline `asks` demands above. `supportsSteer: true` is a claim that `deliverIntoTurn({ mode: 'steer' })` reaches the model inside an open turn; declare it because you drove a steer and watched it land, not because the SDK's docs mention a steer verb. The cost of getting this wrong is not a crash a person can see — the server's ladder degrades around a missing or refusing `deliverIntoTurn` — it is a person told their steer went to the running agent when it silently rode the queue instead. Codex and OpenCode declare all three `false` on exactly this basis: whether their SDKs expose a mid-turn channel at all is unverified, and `false` is the honest answer until a live probe measures otherwise (`codex/NOTES.md` is the worked reasoning). Claude-code and test-mode declare all three `true`. Test-mode's persistence is scripted (`test-mode/held-process.ts`, DOR-1326) — no process is spawned; a session that opts in gets bookkeeping that behaves like one across turns — and it exists so a browser test can reach the pairing that keeps biting: a capable RUNTIME with a session that cannot use the capability. See "A held process, faked" below.

  The one optional method behind these flags is `deliverIntoTurn`, and its three traps are documented on the interface (`packages/shared/src/agent-runtime.ts`): it returns a RECEIPT, not a generator (a steer's events surface on the already-open turn's stream); it is called ONLY when the matching flag is declared; and it MUST NOT throw for an ordinary refusal (no open turn, a closed stream, an unsupported mode are all `{ delivered: false, reason }`). A runtime that declares neither steer nor stage simply omits the method — the ladder degrades around its absence.

  **If steering is true of your adapter but not of every session it runs, say so per session.** `canSteerSession(id)` is the optional companion to `supportsSteer`: `true` when a steer sent to THAT session right now could join its live turn. Claude-code is why it exists (DOR-1268) — its steer rides the persistent pump's held input stream, so a session on the resume path, which is how a default install ships, has nothing to push into and answers `false` while the adapter's flag stays `true`. Omit it and your static flag stands for every session, which is right for a runtime whose steering is uniform. Implement it and C7 holds you to three things: it answers a plain boolean for any session id, including one you have never heard of; it only ever NARROWS the flag — a runtime declaring `supportsSteer: false` may not report a steerable session; and where the suite can move a session between states, the answer FOLLOWS THE MECHANISM rather than the adapter. The server publishes the answer on the session's own status, and the composer offers Steer only when it is not `false`; a steer that arrives anyway is degraded as `not-steerable` and the sender is told, rather than quietly queued.

  **The same is true of staging, and getting it wrong costs more.** `canStageSession(id)` is the optional companion to `supportsContextStaging`: `true` when a stage sent to THAT session right now could reach your transcript. Claude-code needed it for the same reason (DOR-1307) — a native stage appends to the persistent pump's held input stream, so a resume-path session has nothing to append to, and the only way the adapter could answer `true` was to BOOT a process the operator never opted into, which also moved that session onto the persistent path for every later message. Omit it and your static flag stands. Implement it and C9 holds you to C7's three claims, with `supportsContextStaging` in place of `supportsSteer`. The one difference from steering is what a `false` means to the person: **nothing**. The server folds the words into the next dispatch (ADR-0273) with a `context_staged` receipt and `degradedBecause: 'not-stageable'`, so Add context stays offered on both paths and this answer never reaches the client — it exists to keep the server from asking for a native stage that would have to be manufactured.

- **`features` is a typed extension point** (`Record<string, unknown>`, ADR-0256) for runtime-specific metadata that does not merit a first-class field. Consumers must validate what they read.

### Labels are budgeted: `STATUS_VALUE_MAX_CHARS`

Several strings an adapter declares surface in the composer's status line, and that
line's width budget **counts slots, not pixels** — an assumption that only holds
while every slot is about one size. `STATUS_VALUE_MAX_CHARS`
(`packages/shared/src/constants.ts`, currently **13**) is the width one slot is
priced at. The constant lives in `shared` rather than the client precisely because
it is a **contract with runtime authors**, not a private UI detail: the server's own
tests are held to it.

**Where the bound is actually applied is narrower than the price list.** Below the
line's widest density tier every item drops its verbose parts and its value is cut to
the bound. At the widest tier — a bar of 640px or more — only the model item is cut;
a permission-mode label is drawn whole, and the row's own CSS truncation is all that
stops it. That truncation fires when the whole row overflows, so an overlong label
takes width from its neighbours instead of capping itself.

`13` is the width of the longest name in the two places that _are_ asserted: the
`CODEX_MODELS` catalog (`GPT-5.3 Codex`) and the client's runtime descriptors
(`Claude Code`).

The split that matters is authorship, not length:

| String                                                                                                               | Rule                      | Enforced by                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `displayName` in a **static, hand-written** model catalog (`CODEX_MODELS`)                                           | Must fit outright         | `apps/server/src/services/runtimes/__tests__/model-catalog-labels.test.ts`                                                                  |
| `RuntimeDescriptor.label` (step 8)                                                                                   | Must fit outright         | `apps/client/src/layers/features/status/__tests__/status-labels.test.ts` (`describe('the compactness invariant the slot budget rests on')`) |
| `permissionModes.values[].label`                                                                                     | Keep it short             | Nothing. Cut to the bound below the widest tier; drawn whole at the widest                                                                  |
| Any name your adapter merely **relays** from a third party — a provider's model display name from OpenCode's catalog | Truncated, never rejected | `compactStatusValue` (`apps/client/src/layers/features/status/lib/status-labels.ts`)                                                        |

**Shipped permission labels already overshoot, so do not read them as a licence.**
`'Bypass permissions'` (18 characters) ships in both `claude-code` and `opencode`,
and `'Workspace write'` (15) in `codex`. Below the widest tier they are cut and the
slot budget holds; at the widest tier they are drawn in full, which is more width
than the budget charged for them. The gap between what a slot is priced at and what
the widest tier draws is tracked as DOR-461 — not something a new adapter should add
to.

**Relayed strings are cut, not rejected — deliberately.** DorkOS does not control
what a third-party provider calls its model, and failing a session because a
provider chose a verbose name would be the wrong trade. A static catalog is
different: DorkOS wrote it, so it can be held to the bound, and a shipped
`GPT-5.3 Cod…` on a wide desktop is a bug in the number rather than a budget doing
its job (DOR-452).

**If your runtime ships a static catalog, register it.** Add it to
`FIRST_PARTY_CATALOGS` in `model-catalog-labels.test.ts`; a runtime that resolves
its catalog at runtime (Claude Code from the SDK, OpenCode from its sidecar's
provider list) deliberately stays off that list. Note the test lives in the
_parent_ `runtimes/__tests__/` directory, so
`pnpm vitest run apps/server/src/services/runtimes/<name>/` does not run it.

Raising the bound is legitimate but not free: `FULL_SLOT_COST_PX` in
`apps/client/src/layers/features/status/model/status-budget.ts` is derived from
it, so a wider character bound buys fewer slots at the same bar width. Shorten the
name first.

### The live-state split (facade + mapper + projector)

Both new adapters follow the same architecture, inherited from `test-mode`:

1. **The facade** (`codex-runtime.ts`, `opencode-runtime.ts`) implements `AgentRuntime`. `sendMessage` is a _pure StreamEvent producer_: it drives the SDK and yields mapped events. It does not write the EventLog itself; the platform's `trigger-turn` (`apps/server/src/services/session/trigger-turn.ts`) consumes the generator into the per-session `SessionStateProjector`.
2. **The event mapper** (`event-mapper.ts`) is pure functions translating native SDK events into `StreamEvent`s, with a per-turn mutable context struct (`CodexEventContext`, `OpenCodeEventContext`). Purity is what makes it testable against recorded fixtures.
3. **Native-storage access** stays SDK-only (`thread-map.ts` + `session-registry.ts` for Codex; `session-mapper.ts` for OpenCode). Never read another product's private database or files directly (ADR-0308/0310).
4. **`subscribeSession` / `getSessionSnapshot`** serve from the projector's DorkOS-owned EventLog via `getOrCreateProjector` / `peekProjector` (`apps/server/src/services/session/session-state-projector.ts`). A stateless adapter reconstructs completed history with `reconstructHistoryFromEvents` (`apps/server/src/services/session/event-log-history.ts`).

## The StreamEvent Contract

Every event `sendMessage` yields must satisfy `StreamEventSchema` (`packages/shared/src/schemas.ts`); the conformance suite `safeParse`s each one. The essentials:

- **Exactly one terminal `done` ends every turn**, no matter how the native stream ends: success, failure, abort, or the SDK generator throwing. Do not scatter `done` emission through the mapper; wrap the whole stream in one function that owns the invariant. `mapCodexThread` (`codex/event-mapper.ts`) and its OpenCode counterpart both guarantee: terminal native events produce `done`, a thrown stream still gets its trailing `done`, and double terminals are suppressed.
- **Errors are typed, non-terminal `error` events.** A recoverable or informational failure surfaces as `{ type: 'error', ... }` and the turn still terminates via `done`. Reserve turn termination for your backend's authoritative turn-end signal; both SDKs emit misleading "error" events mid-turn (see [Common Traps](#common-traps)).
- **User-initiated aborts are not failures.** OpenCode's interrupt surfaces as a `MessageAbortedError` followed by idle; the mapper suppresses the error and ends with a plain `done`. Codex handles `AbortError` the same way. Match that behavior.
- **Deltas, not snapshots.** The UI expects incremental `text_delta` / `thinking_delta`. If your SDK emits cumulative snapshots (both Codex and OpenCode do), track last-seen text per item id in the mapper context and emit only the new suffix.
- **`toolCallId` is unique WITHIN a turn, and only within a turn.** Codex passes the SDK's raw `item.id` through and opens a fresh thread per turn, so turn 2 starts counting at `'0'` again; the test-mode scenarios re-run with the same literal ids on every turn. Adapters may keep doing that, but nothing downstream may key across turns by id alone — matching a history part to a live one on the id by itself deletes a real earlier call out of the transcript the moment a later turn reuses its number (DOR-1269).

## Step-by-Step: Runtime #4

### 1. Research the SDK, write `NOTES.md`

Pin the SDK version. Verify streaming behavior, turn-end signals, approval surfaces, and auth against a _live_ binary, not just the published types; record every verified fact (with upstream source references) in a `NOTES.md` inside the adapter directory. `codex/NOTES.md` and `opencode/NOTES.md` are the models; several documented behaviors there contradict the SDKs' own type docstrings.

#### Bumping a pinned SDK

A pinned SDK version is a verified claim, so a bump re-verifies it. Checklist for the `@openai/codex-sdk` 0.142.5 → 0.143.0 bump (motivation: 0.142.x has an unbounded `logs_2.sqlite` write, fixed upstream in 0.143.0) — reuse the same steps for any adapter SDK:

1. Confirm the target is a stable release: `npm view @openai/codex-sdk dist-tags`.
2. Diff the `.d.ts` of the `ThreadEvent` union and the 8 item types the event mapper imports against the pinned version.
3. Recompile — the event mapper's exhaustiveness `never` checks must still compile, so a new union member fails the build instead of silently dropping events.
4. Run the runtime conformance suites: `pnpm vitest run apps/server/src/services/runtimes/codex`.
5. Run one live smoke turn against a real `codex` binary: `DORKOS_CODEX_LIVE=1 pnpm vitest run src/services/runtimes/codex/__tests__/conformance.test.ts` (from `apps/server`).

A bump also inherits behavior changes no compiler catches. Record the decision on each one here, so the next bump does not re-derive it.

**Subagent spawn depth (claude-agent-sdk 0.3.217, decided 2026-08-07 on the 0.3.177 → 0.3.224 bump).** Upstream dropped the default subagent nesting depth from 5 to 1 and added a cap of 20 concurrent subagents. **DorkOS accepts the new default.** Its documented orchestrator pattern (`claude-code/messaging/context-builder.ts`) is parent-driven and therefore depth-1, and its headline parallelism is multi-_session_ — each session gets its own CLI subprocess and its own depth budget, so only within-session `Task`-in-`Task` is capped at all. A runaway recursive agent tree is a worse failure for an operator than a refused nested spawn. The escape hatch, if a skill genuinely needs nesting: set `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` in the CLI subprocess env that `claude-code/messaging/message-sender.ts` already builds. Nothing in the repo sets it today.

### 2. Create the adapter directory

```
apps/server/src/services/runtimes/<name>/
├── <name>-runtime.ts        # AgentRuntime facade
├── event-mapper.ts          # native SDK events → StreamEvent (pure)
├── check-dependencies.ts    # binary + auth probes → DependencyCheck[]
├── runtime-constants.ts     # <NAME>_CAPABILITIES (+ models if static)
├── index.ts                 # barrel (composition root imports from here)
├── NOTES.md                 # live-verified SDK facts
├── __tests__/
│   ├── conformance.test.ts  # wires the shared suite (step 4)
│   ├── event-mapper.test.ts # fixture-driven mapper tests
│   └── <name>-scenarios.ts  # recorded fixture events / mock stream builders
└── ...                      # backend-specific: thread-map.ts, server-manager.ts, session-mapper.ts, ...
```

The backend-specific extras follow from your decision-matrix row: Codex adds `thread-map.ts` (durable sessionId ↔ threadId in the `codex_threads` SQLite table), `session-registry.ts`, and `turn-input.ts`; OpenCode adds `server-manager.ts` (sidecar lifecycle), `global-event-hub.ts` (one SSE subscription demuxed per session), `session-mapper.ts`, `approvals.ts`, and `models.ts`.

### 3. Implement the facade and mapper

Work from `codex/codex-runtime.ts` (simpler: no process lifecycle) or `opencode/opencode-runtime.ts` (sidecar). Reuse the shared session services rather than reinventing them: `SessionLockManager`, `getOrCreateProjector`/`peekProjector`, `reconstructHistoryFromEvents`. Constructor dependencies come in through an options object built at the composition root (see `CodexRuntimeOptions`), which keeps the adapter testable.

### 3b. Teach tools by the name your runtime actually exposes

Any prose you write that tells an agent to call a tool must spell that tool the way **your** runtime hands it to the model. This is a rule and not a style note, because breaking it fails silently on strong models and hard on cheap ones: a model that scans its tool list papers over a wrong name, while Haiku copies the prose, calls the string it read, and gets `No such tool available` (DOR-1292 — two credentialed evals lost whole turns to it).

The names differ per runtime because DorkOS's tools arrive by more than one route:

| Runtime     | How it reaches DorkOS tools                                                                          | What the model must type                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| claude-code | in-session SDK MCP server (`createDorkOsToolServer`)                                                 | `mcp__dorkos__<verb>` — Claude Code qualifies every MCP tool                        |
| codex       | the UI server it spawns is `dorkos_ui` (`codex/codex-ui-mcp-server.ts`); the rest is external `/mcp` | `mcp__dorkos_ui__<verb>`, or the `/mcp` server under whatever their config named it |
| opencode    | external `/mcp`, wired by the person's own harness config                                            | `<verb>` under whatever prefix their config gave the server                         |

So:

- **Runtime-specific blocks** (`claude-code/messaging/context-builder.ts` and the equivalent in your adapter) name tools in full. Render the prefix from one constant — claude-code's is `IN_SESSION_TOOL_PREFIX` in `mcp-tools/tool-exposure.ts`, which is also what the server is created with — never by typing it out per line. The same constant builds the auto-approval allow-lists in `interactive-handlers.ts`; hand-writing the prefix there meant a server rename would silently make every DorkOS tool raise an approval card.
- **Runtime-neutral blocks** (`runtimes/shared/*.ts`), **capability descriptions** (`services/**/*-capabilities.ts`), **tool descriptions** (`claude-code/mcp-tools/*.ts`) and the **operating skills** (`packages/operating-skills/`) may spell no prefix AND no bare tool name. Descriptions are the easy one to miss: `register-from-definitions.ts` serves the same string to the external `/mcp` server, so "call `mcp_signin` first" is wrong on claude-code and unreliable everywhere else. Name the verb ("sign in with the MCP sign-in tool"); say "this same tool" for a two-call protocol; or, where the name really is the payload (a reference skill), present it as an ENDING — "its name ends in `list_capabilities`" — which is the one form true on every runtime.
- **Know which of your tools are deferred, and say so.** Claude Code's tool search is on by default, so an MCP server's tools are absent from the turn-1 prompt unless you opt out — and you CAN: `createSdkMcpServer` takes `alwaysLoad`, and `tool()`'s fifth argument takes `alwaysLoad` and `searchHint` per tool (both surface as `anthropic/*` `_meta` keys; verify against the real factory, not the `.d.ts`). DorkOS always-loads eight — six of the eight room verbs, `list_capabilities` and `memory_write` — and leaves the other 80 deferred, the two room lookups among them, because eighty-odd schemas on every prompt is a worse trade than one search — and a tool the prompt does not name can afford that search. Each of the eight is named by the system prompt itself, and a tool the prompt names must not need a lookup first. Everything deferred carries a `searchHint` derived from its own title, and `<dorkos_tools>` tells the model to run `ToolSearch(query="select:mcp__dorkos__…")` with the full name. A search for the short name returns nothing, which is how both evals dead-ended.

Pin it the same way claude-code does: build your live tool server in a test, list its tools, and diff every name your prose writes against that list in both directions. A test that restates the names cannot catch the drift it exists for — and assert WHICH blocks the scan actually read. The first version of this guard mocked a manifest to `null`, which collapsed every block it meant to check down to one, and it passed while covering almost nothing.

### 4. Wire the conformance suite

Every adapter must clear the shared behavioral gate before its UI activates. Add `__tests__/conformance.test.ts`:

```typescript
import { vi } from 'vitest';
import { runtimeConformance } from '@dorkos/test-utils';

// Mock the SDK: fixture events in, no binary required (see mocking stance below)
vi.mock('@vendor/sdk', () => ({ /* mock stream builders from <name>-scenarios.ts */ }));
vi.mock('../check-dependencies.js', () => ({
  check<Name>Dependencies: vi.fn(() => [/* satisfied checks */]),
}));

import { MyRuntime } from '../my-runtime.js';

runtimeConformance(() => new MyRuntime({ /* fresh isolated deps per test */ }), {
  name: 'MyRuntime (mocked SDK) — AgentRuntime conformance',
  expectHistory: false, // true only if native history is served after a turn
});
```

`runtimeConformance(makeRuntime, opts)` registers a `describe` block asserting session lifecycle, StreamEvent well-formedness and the terminal `done`, interrupt semantics, history shape, presence truthfulness (below), `RuntimeCapabilities` structure (including the permission-modes contract), and `DependencyCheck` validity. The factory runs once per test; declare legitimate cross-runtime differences via `RuntimeConformanceOpts` (`name`, `projectDir`, `permissionMode`, `expectHistory`, `messageContent`) instead of weakening assertions. `test-mode/__tests__/conformance.test.ts` is the minimal wiring; `codex/__tests__/conformance.test.ts` is the full pattern.

**Your `subscribeSessionList` must actually emit something, and that is not the default you might expect.** One case subscribes to the list stream and parses the first event through `SessionListEventSchema` — the schema `SessionListBroadcaster` applies before fanning events to the sidebar, dropping whatever fails it with nothing louder than a log line (DOR-851). A stream that says nothing gives that check no event to parse, so the case would pass having asserted nothing. It therefore **fails** instead: seed your mocked backend so at least one session is observable the moment the suite subscribes, the way claude-code seeds a transcript into a hermetic Claude account. If your adapter genuinely cannot — its list stream observes a store the mocked backend has no way to write to — declare `sessionListSilentReason` with a sentence saying why, like `autonomyDefaultReason`, and whitespace waives nothing. All four shipped runtimes clear this without a waiver. The rule lives in `evaluateSessionListStream` (`packages/test-utils/src/runtime-conformance.ts`) and `packages/test-utils/src/__tests__/runtime-conformance-session-list.test.ts` proves it rejects a dead stream; this default is strict precisely because the lenient one hid a claude-code case that never ran in CI at all (DOR-1085).

**You must decide, in writing, whether you can say when the person last wrote.** `Session.userLastMessageAt` is half the sidebar's Today order key (`lastInteractionAt = max(userLastMessageAt, userLastOpenedAt)`, spec `sidebar-now-today-library` BC-16), and it exists because `updatedAt` moves whenever the _agent_ writes — ordering on that makes rows jump under a cursor. There are two honest answers and the suite makes you pick one:

- **You can say.** Wire `userLastMessageAtSession`: a probe returning the Session **your LIST path reports** (not `getSession` — this is a field of the recents list, and that is the path the sidebar calls) for a conversation a person wrote to **and an agent worked on afterwards**. The suite asserts the reported instant is strictly earlier than that session's `updatedAt`. That gap is an obligation on your **fixture**, not a claim about runtimes: a conversation that really ended on the person's turn has both facts legitimately equal, but it also cannot discriminate, because a runtime that merely renamed `updatedAt` would pass on it.
- **You cannot.** Declare `userLastMessageAtOmittedReason` with a sentence saying why (whitespace declares nothing). The suite then asserts the field is **absent** on a session that has just taken a user message — not null, not an empty string, not `updatedAt` quietly filling the gap. Implementing the field later means _deleting_ that reason.

Claude-code takes the first arm; codex, opencode and test-mode take the second. Two things to copy from how claude-code does it:

- **Derive it inside a pass the listing path already makes.** This endpoint is read on every cockpit boot, so a whole-conversation read per row is the wrong trade. Claude-code folds it into the transcript-tail read it already performs — no extra open, read or stat. That window is `TRANSCRIPT.TAIL_BUFFER_BYTES`, sized at 64 KB **by this field**: measured over 474 real transcripts the person's last turn sits a median of 27 KB back, so the previous 16 KB answered ~11% of conversations while 64 KB answers ~90% of those touched in the last week.
- **The `user` role is a wire role, not an author, and DorkOS itself writes on it.** Tool results, resume bootstraps, compaction summaries, relay hand-offs from other agents, scheduled-task prompts and room posts by other agents all arrive as user messages. Claude-code answers the markered ones per record (`isPersonAuthoredUserRecord`) and the unmarkered ones per session: an `agent`/`task`/`room` origin drops the field whole (`services/session/origin/user-last-message-origin.ts`, applied by the runtime and by both route overlays). If your runtime cannot separate a person's message from a relay or scheduled one, that is a reason to take the second arm — it is exactly why codex does.

The rules live in `chooseUserLastMessageAtArm` / `evaluateUserLastMessageAtPresence` / `evaluateUserLastMessageAtOmission` (`packages/test-utils/src/runtime-conformance.ts`), and `packages/test-utils/src/__tests__/runtime-conformance-last-user-message.test.ts` proves each one rejects the wrong answer.

**Presence must be true or absent — never invented.** The roster and the presence strip ask a runtime two questions about every session: is a turn running right now, and what is this session bound to. Your adapter answers both — the first through `getSessionSnapshot().status.lifecycle` plus its `inProgressTurn`, the second through the session's own `cwd`. Exactly these rules are enforced, no more:

| Reading                                          | Enforced                                                                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| any                                              | `lifecycle` is a real `SessionLifecycle`; `inProgressTurn` is events or `null`                                            |
| any, when it says `streaming`                    | a NON-EMPTY `inProgressTurn` — an empty array is absence wearing the shape of presence, and the projector never emits one |
| a session that has never run a turn              | `idle`, and `inProgressTurn` strictly `null`                                                                              |
| after the turn reached its terminal `done`       | anything but `streaming`                                                                                                  |
| the reported `cwd`, when the runtime reports one | the cwd the session was created with — and none at all for a session created with none                                    |

Mid-turn, no particular lifecycle is demanded: `blocked` is legitimate the moment an approval opens — the turn is still open, nobody is working — and it keeps its live non-null turn, as may a turn that ended in `error` or `interrupted`. What the suite pairs is the two live readings: a runtime that says `streaming` while the turn runs must have let go of it afterwards, and one that says `idle` while the turn runs must report nothing at all (`inProgressTurn: null`), so it cannot answer at one moment and hide at the other. A runtime that reports no session at all (`getSession` → `null`) makes no binding claim and is not held to one.

So: absence passes, fabrication fails — **the strip omits rather than lies.** There is no opt-out on `RuntimeConformanceOpts`, because "cannot report" and "reports absence" are already the same value. What fails is a `streaming` claim with nothing behind it, a session still lit up after its turn ended, or a binding the session never had (the ghost-row class, DOR-202).

**The live half needs a driver, and without one it skips.** A runtime's `sendMessage` is a pure event producer that moves no projector, so presence read off it alone reports `idle` at every moment for every runtime — assertions that cannot fail. Wire `presenceTurn` to `drivePresenceTurn` (same harness file as `driveDurableTurn`); it opens one turn through the real `getOrCreateProjector` → `feedProjector` seam and hands control back while the turn is open, then after it closes. All four shipped runtimes are wired and all four genuinely transition under it (`streaming` with a live turn, then `idle`); claude-code additionally reports no binding in the mocked-SDK suite, because with no JSONL on disk its `getSession` honestly returns `null`. Omit the driver and the live case registers as a named skip rather than passing on a manufactured absence.

The rules live in `validatePresenceReport` (`packages/test-utils/src/runtime-conformance.ts`). `packages/test-utils/src/__tests__/runtime-conformance-presence.test.ts` proves the predicate rejects each fabrication; the suite cases themselves were proved by seeding a stuck-`streaming` and an empty-turn defect into `test-mode` and watching them go red.

**If your adapter holds a process open between turns, warmth is a third presence question.** `supportsPersistentSession` says the adapter CAN keep one backend process serving many turns — not that every session does; whether a given session does is normally an operator setting, and claude-code's is `runtimes.claudeCode.persistentSession`, on by default since it graduated (spec `full-power-defaults`). Declaring the capability commits you to three things:

| Method                       | What it must answer                                                                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getSessionWarmth(id)`       | `cold` / `warming` / `warm` / `running` / `crashed` — about the PROCESS, never the conversation. A session you hold nothing for is `cold`, always. |
| `reapSession(id)`            | Close the process and leave the record, the transcript and the conversation untouched. The next message must resume as if nothing happened.        |
| `settleOpenTurn(id)`         | End a turn you could not finish, and say whether you found one. See below — a held process is the only thing that can strand a turn.               |
| the presence pair, unchanged | A warm session is `idle` with `inProgressTurn: null`. It is holding a process, not running a turn.                                                 |

That last row is the trap the C4 case exists for. The presence contract already forbids `streaming` with an empty `inProgressTurn`, but warmth is a NEW way to reach the same lie: the process is alive while nothing at all is running, so an adapter that reported warmth as activity would pin every idle chat to "working" forever. Two more rules follow from the same honesty:

- **A reap is invisible or it is a bug.** C5 drives a session warm, reaps it, and dispatches again; both turns must be well formed and indistinguishable. That is what makes a short idle window safe to have at all.
- **An idle crash reports `crashed` and says NOTHING on the session stream.** The stream's `error` member is a TURN error, so minting a turn for a session where nothing was running would report a failure that never happened.
- **A turn you could not finish is settled BEFORE the next one opens, never during it.** This is the only failure mode a held process adds that a fresh-process runtime cannot have: a turn is bounded by the stream you hand back, unless the process outlives the stream, in which case a turn whose terminal never arrives is simply open forever. Ending it lazily — when the next dispatch trips over it — is too late, because the server mints the next turn's `turn_start` before it pulls your generator once, so your terminal lands inside a healthy turn and settles it as the abandoned one's error (DOR-1295). `settleOpenTurn(id)` is the seam the server calls first, once per turn. Its boolean is your account of what you did, not a lever: the server waits on the PROJECTOR either way (`services/session/settle-open-turn.ts`), so you cannot skip the ordering guarantee by answering `false` or buy extra delay by answering `true`. C8 is where the three obligations are held rather than hoped for — see below.

**The warmth half needs a driver too, and without one it skips.** Wire `warmSession(runtime, sessionId)`: leave the session WARM — a completed turn with the process still held — and hand control back. Turning on whatever per-session opt-in your runtime requires is the driver's job, and so is supplying a backend double that stays alive after its `result`; the one-shot doubles the rest of the suite uses read as a crash the moment their stream ends, so every second turn would test crash recovery instead of warmth (`claude-code/sessions/__tests__/fake-persistent-cli.ts` is the shape). Omit the driver and C4/C5 register as a named skip — codex and opencode take that arm today, because neither declares the capability.

#### A held process, faked (test-mode)

Test-mode declares `supportsPersistentSession` without spawning anything, and the reason is worth reading before you copy the pattern or change it. The persistent path's two shipped defects were both the same shape — **a capable runtime paired with a session that cannot use the capability**: a Steer offered on a session with nothing to cut into (DOR-1268), and an Add context that booted a process nobody opted into (DOR-1307). Neither was reachable above the unit layer, because the one runtime a browser test can drive for free declared the whole idea away and steered every open turn. A claude-code leg that flipped the real flag would spend model tokens on every run and cannot go in CI.

So `services/runtimes/test-mode/held-process.ts` is bookkeeping, not a second pump: which sessions opted in, which hold a scripted process, how many turns that process has served, and what has been staged onto it. Everything else is the product's own machinery reacting to the answers that bookkeeping produces.

| Seam                                  | On the held path                                                                                                                              | Off it (the default)                                                                                                                                        |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getSessionWarmth`                    | `running` during a turn, `warm` after it, `cold` after `POST /api/test/reap`                                                                  | always `cold`                                                                                                                                               |
| `canSteerSession` / `canStageSession` | `true` from the opt-in, before the first turn (`willHold`, mirroring `shouldDispatch`)                                                        | `false` — the composer hides Steer, the server folds a stage                                                                                                |
| `deliverIntoTurn({ mode: 'steer' })`  | delivers while a turn is open                                                                                                                 | `no-open-turn`, which the dispatcher probes the session about: `not-steerable` if a turn is really open, `session-idle` if none is                          |
| `deliverIntoTurn({ mode: 'stage' })`  | warms the session first if it holds none yet, then appends; the next scripted answer repeats the words                                        | refused as `unsupported` — the one refusal the server folds, so a staged message is never queued. Only reachable by a caller that ignored `canStageSession` |
| `settleOpenTurn`                      | always `false`, honestly: a scripted turn is bounded by the generator `sendMessage` hands back on both paths, so it cannot outlive its stream | same                                                                                                                                                        |

**The stage row is the one to copy carefully.** `canStageSession` and the stage branch of `deliverIntoTurn` must ask the SAME question — here `willHold`, for claude-code `shouldDispatch`. Gate the method on "is a process held right now" while the answer says "would the next turn run on one" and the two disagree in every state between the two, which a session reaches by opting in before its first turn or by being reaped: the server is told stageable, takes the native route, and gets back a refusal it is not allowed to fold, so the person's staged words go on the QUEUE and provoke a reply. That is the one outcome Add context promises never to produce, and the only refusal `deliverStage` folds is `unsupported` — so a runtime that cannot stage a session must say exactly that, and one that could must warm it rather than refuse.

The opt-in is per SESSION (`POST /api/test/persistent { sessionId, enabled }`), because the test-mode server is shared by four concurrent Playwright projects and a process-wide switch would warm a neighbour's chats. `GET /api/test/persistent` reads warmth and the two per-session answers off the runtime itself — there is no product API for warmth, which is exactly why a browser needs this one. The `warm-echo` scenario names in its own answer which path served the turn (`HELD-PROCESS-TURN-2` versus `NO-HELD-PROCESS`) and where staged words came from (`staged-native:` versus `staged-folded:`), so a spec that quietly ran on the other path goes red instead of passing. `apps/e2e/tests/chat/held-process.ts` is the consumer.

A runtime that declares `logBackedHistory: true` must also pass the `durableHistory` opt — wire it to `driveDurableTurn` (`apps/server/src/services/session/__tests__/durable-turn-harness.ts`), which runs one real turn through the projector → durable store path, drops the projector (the restart analog), and asserts history reconstructs from the store (DOR-189). All three log-backed suites show the wiring.

### Disposition honesty and cwd resolution (C1, C2, C3, C6, C7, C9, C10)

The three disposition flags above are not free to declare — the suite holds every runtime to them, because **a capability that is not conformance-tested is one a runtime can lie about**, and a lie here sends a person's steer somewhere it did not go. Six cases enforce it, and they follow the same "measure, don't guess" stance as presence: fabrication fails, honest absence passes or skips by name. C10 is unrelated to steer/stage but lives in the same catalogue for the same reason: it is an optional per-session method held to the same "answer or skip by name, never fabricate" bar.

- **C6 — capability completeness.** All three flags present and boolean. Compile-time forced already (ADR-0256), asserted anyway so a cast that slips a non-boolean onto the flag the ladder routes on cannot dodge conformance. No driver; never skips.
- **C1 — disposition honesty.** For each of steer and stage: a mode you DECLARE must reach the model inside an open turn with no new `turn_start`; a mode you do NOT declare must be either absent (you omit `deliverIntoTurn` entirely) or refused as `{ delivered: false, reason: 'unsupported' }`, and neither branch may throw. The not-declared half runs at rest, no driver. The declared half needs a turn genuinely open underneath it — a steer delivered onto an idle session proves nothing — so it needs a `dispositionTurn` driver, and **declaring a disposition is what creates the obligation to wire one**: a runtime that declares steer or stage and wires no driver FAILS the "wires a dispositionTurn driver" case rather than skipping it (the same stance `warmSession` takes). A runtime that declares neither takes the named skip legitimately — codex and opencode do.
- **C2 — terminal exactly once.** A turn window emits exactly one `turn_end`, however many native `result`s the backend produced. This is a PLATFORM invariant, not an adapter one — `feedProjector`'s idempotent `closeTurn` (spec task 0.1) collapses a coalesced multi-result window — so its `terminalOnce` driver feeds a synthetic two-terminal window through the real projector rather than the runtime, and asserts one `turn_end`. It was proved able to fail by deleting the `if (!turnOpen) return` guard and watching the count climb to three.
- **C7 — per-session steerability.** Only for a runtime that implements `canSteerSession`; the rest take a named skip, reported as a skip rather than as a green tick over nothing. Three claims. It ANSWERS for a session it has never heard of instead of throwing — the composer asks about whatever chat is on screen. It NARROWS the static flag: a runtime declaring `supportsSteer: false` may report no session as steerable. And, where the suite can move a session between states, the answer FOLLOWS THE MECHANISM — a session holding the process reports `true`, one holding none reports `false`. That last pair is the only claim a constant cannot satisfy, and it is the case that would have caught DOR-1268; it reuses the `warmSession` driver, so a runtime that implements `canSteerSession` without holding a process between turns is asked to explain what its answer varies with instead.
- **C8 — settling an open turn.** Only for a runtime declaring `supportsPersistentSession`, and for that runtime it is an obligation rather than an option: declaring the capability is what creates the exposure, so a persistent runtime that omits `settleOpenTurn` FAILS the case rather than skipping it (the same stance `warmSession` and `dispositionTurn` take). Three claims, all about honesty at rest. It ANSWERS for a session it has never heard of — the server asks before every turn, including the first one on a brand-new session, so a throw there would make a repair the thing that fails a person's first message. It answers `false` for a WARM IDLE session, which is the half a constant `true` cannot survive: there is a live process behind it and nothing running on it, so claiming to have settled something there tells the server a person's previous reply failed when it did not. And it is idempotent. What C8 deliberately does NOT assert is the abandonment itself — that needs a turn genuinely stranded underneath it, which no shipped backend double can be made to do at this level; claude-code pins it end to end instead (`sessions/__tests__/stranded-turn-successor.test.ts`), and the composer's own guarantee — start the turn anyway when a runtime throws here — is pinned at the dispatcher. Test-mode's implementation is a constant `false`, and that is the honest answer rather than a stub: its turn is bounded by the generator `sendMessage` hands back on both paths, so it has no way to strand one. Answering is still worth doing, because the server reads the ABSENCE of the method as "this runtime cannot strand a turn" — the same claim, made in a way indistinguishable from a persistent runtime that forgot to wire it.
- **C9 — per-session stageability.** C7 with `canStageSession` and `supportsContextStaging` in place of their steering counterparts, and the same named skip for a runtime that omits the method. It exists because the defect it catches is worse than C7's: a `canSteerSession` that lied put a dead button in front of a person, while a `canStageSession` that lied made the server ask for a native stage, and claude-code's only way to answer was to start an agent process the operator had not turned on (DOR-1307). Numbered C9 because C8 was already taken by `settleOpenTurn`.
- **C3 — queue durability.** A message queued behind a turn that FAILS still runs, and a message never runs while a pending interaction is open (firing a prompt into an open approval is read as the person's reply — OpenCode #2609, Gemini #17719). The queue is server-owned by construction (§2.4, there is no `supportsQueue`), so this too is a platform invariant every runtime inherits; its `queueDurability` driver exercises the real dispatcher, projector and SQLite queue with a controllable runtime, because both failure modes need a turn that PARKS on command that no shipped adapter's mocked backend can be made to do here.
- **C10 — cwd resolution (DOR-1322).** Only for a runtime that implements `getSessionCwd`; the rest take a named skip. Two claims. It ANSWERS `undefined` for a session it has never heard of instead of throwing — `GET /api/sessions/:id/messages` calls it on the path whose whole job is graceful degradation when no `?cwd=` was supplied, and a throw there would turn an honest 404 into a 500. And, where the suite can move a session into a live binding, the answer FOLLOWS THE MECHANISM: it reuses the `warmSession` driver and asserts a warmed session's answer matches the directory it was warmed with. A runtime with no live per-session cwd binding omits the method entirely and takes the named skip — codex, opencode, and test-mode do.

**Wiring**, all from the shared `durable-turn-harness.ts`, mirroring the `presenceTurn`/`warmSession` pattern:

| Opt               | Driver                 | Who wires it                                                                                                                                                                      |
| ----------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dispositionTurn` | `driveDispositionTurn` | Runtimes that DECLARE steer or stage. test-mode puts the session on its held path and holds a turn open with the `long-turn` scenario; claude-code with the persistent `FakeCli`. |
| `terminalOnce`    | `driveTerminalOnce`    | All four — it proves the shared projector, not the adapter.                                                                                                                       |
| `queueDurability` | `driveQueueDurability` | All four — it proves the shared queue, not the adapter.                                                                                                                           |

The rules live in `runtimeConformance` (`packages/test-utils/src/runtime-conformance.ts`); the defect-seed proofs are how the checks were shown to discriminate before being trusted — remove C2's guard, declare `supportsSteer: true` on a runtime that cannot steer, and (for C7 and C9) replace claude-code's `canSteerSession` / `canStageSession` with a constant, once `true` and once `false`, each of which turns them red.

**The mocking stance (non-negotiable): CI must never require the backend binary.** Mock the SDK with recorded fixture events and mock the dependency probe so nothing spawns. For local end-to-end verification, add an env-gated live smoke in the _same file_, the way Codex does: hoist a `LIVE` flag with `vi.hoisted(() => process.env.DORKOS_<NAME>_LIVE === '1')`, have each `vi.mock` factory return `importOriginal()` when live, switch `projectDir` to a real temp dir, and raise timeouts. The identical assertions then run against real turns:

```bash
DORKOS_CODEX_LIVE=1 pnpm vitest run src/services/runtimes/codex/__tests__/conformance.test.ts
```

### 5. Add the ESLint SDK-confinement boundary (Hard Rule #2)

`apps/server/eslint.config.js` confines each SDK to its adapter directory. Three edits, all in that file:

1. **Define the ban constant** next to `CLAUDE_SDK_BAN` / `CODEX_SDK_BAN` / `OPENCODE_SDK_BAN`:

   ```javascript
   const MYSDK_BAN = {
     group: ['@vendor/sdk', '@vendor/sdk/*'],
     message:
       'MySDK imports are confined to services/runtimes/<name>/. Import from the AgentRuntime interface instead.',
   };
   ```

2. **Add your directory to the global block's `ignores`** and your ban to its `patterns` array (the block covering `src/**/*.ts`).
3. **Add a per-adapter block** for `src/services/runtimes/<name>/**/*.ts` that bans every _other_ SDK plus `HOMEDIR_BANS` — and add your ban to each existing adapter's block.

Why the restating: flat-config rule entries **replace**, they do not merge. Any block that configures `no-restricted-imports` silently drops every ban it does not restate, which is why the ban objects are defined once as constants. The in-file comments explain this; keep them intact.

### 6. Config block + migration

Add a `runtimes.<name>` object to `UserConfigSchema` in `packages/shared/src/config-schema.ts`, following the existing shape (`enabled`, `binaryPath`, plus backend-specific fields like OpenCode's `port`). Then add a semver-keyed backfill to `CONFIG_MIGRATIONS` in `apps/server/src/services/core/config-manager.ts`; `backfillRuntimesDefaults` (keyed `'0.47.0'`) is the pattern to copy. Key the migration to a NEW version strictly greater than the newest `v*` tag (`git tag -l 'v*' | sort -V | tail -1`), and never extend a key that has already shipped — `conf` runs a key only in `(storedVersion, projectVersion]`, so a key at or below a released version, or a body appended to one, never runs for anybody already on it. A guard compares every key's source text against the newest release and reddens CI if you get this wrong (`apps/server/src/services/core/__tests__/migration-safety.ts`). Full lifecycle: [configuration.md → Append-only rule](configuration.md#append-only-rule) and the `adding-config-fields` skill.

### 7. Register in the composition root (+ teardown)

In `apps/server/src/index.ts`, after the Claude registration block (search for "Codex runtime"):

```typescript
const myConfig = configManager.get('runtimes').myruntime;
if (myConfig.enabled) {
  const myRuntime = new MyRuntime({/* deps: db-backed maps, config */});
  myRuntime.setSessionSettings(runtimeRegistry); // ADR-0260 durable settings port
  runtimeRegistry.register(myRuntime);
  logger.info('[Runtime] MyRuntime registered');
}
```

Two ordering rules, both load-bearing:

- **Register before `sessionListBroadcaster.start(runtimeRegistry.listRuntimes())`** (further down in `index.ts`). Runtimes registered after `start()` are not fanned into the global session-list stream, so their sessions silently never appear in the sidebar.
- **Wire teardown into `shutdownServices()`** if your adapter owns any process or open handle. The OpenCode sidecar's `await openCodeServerManager.shutdown()` (SIGTERM, then SIGKILL after a grace window) is the model; a no-op when never booted.

Also add your runtime type to `AgentRuntimeSchema` in `packages/shared/src/mesh-schemas.ts` (the enum serves both discovery and execution; see its TSDoc).

### 8. Client `RuntimeDescriptor` + icon

`RUNTIME_DESCRIPTORS` in `apps/client/src/layers/entities/runtime/config/runtime-descriptors.ts` is the single source of truth for a runtime's visual identity; every badge, picker, chip, and session-list mark renders through `getRuntimeDescriptor(type)`:

```typescript
myruntime: {
  type: 'myruntime',
  label: 'My Runtime',
  icon: MyRuntimeLogo,                    // from @dorkos/icons/adapter-logos
  accent: 'var(--color-sky-500)',         // pick an unused theme accent
  setup: {                                 // only for user-addable runtimes
    installCommand: 'npm i -g my-runtime && my-runtime login',
    infoUrl: 'https://example.com/docs',
  },
},
```

`label` is one of the strings the status line budgets, so keep it within
`STATUS_VALUE_MAX_CHARS` — see [Labels are budgeted](#labels-are-budgeted-status_value_max_chars).

Add the logo to `packages/icons/src/adapter-logos.tsx` (a 16px-legible mark; alias an existing vendor mark like `CodexLogo = OpenAILogo`, or draw an original glyph like `OpenCodeLogo`) and register it in `ADAPTER_LOGO_MAP`. Unknown types fall back to `DefaultAdapterIcon` with the raw type as label, so a missing descriptor degrades gracefully; it never crashes, it just looks generic.

### 9. `checkDependencies` + the needs-setup UX contract

Implement `checkDependencies(): Promise<DependencyCheck[]>` in `check-dependencies.ts`. Both shipped implementations (`checkCodexDependencies`, `checkOpenCodeDependencies`) follow the same rules; copy them:

- **Two checks: binary, then auth.** Probe with `execFileSync` and an argv array (no shell, no interpolation; spec §Security) under a 5-second timeout.
- **A configured `binaryPath` is authoritative.** If `runtimes.<name>.binaryPath` is set but does not exist, report `missing`; never silently probe a different binary on PATH the user did not choose.
- **The CLI is the source of truth for auth state** (`codex login status`, `opencode auth list`); never parse credential files or read env vars yourself.
- **Every non-`satisfied` check carries `installHint` and `infoUrl`.** This is the UX contract: `RuntimeSetupDialog` (`apps/client/src/layers/entities/runtime/ui/RuntimeSetupDialog.tsx`) renders `installHint` as a copyable command via `DependencyInstallHint` with `infoUrl` as the docs link. When the runtime is registered, the live `DependencyCheck` data is authoritative; when it is not registered at all, the static `RuntimeSetupHint` on the descriptor (step 8) covers the gap. Keep the two in sync.

Results surface through `GET /api/system/requirements`, which aggregates every registered runtime. A runtime with failing checks appears in pickers with a setup affordance, never as a dead option.

### 10. Verify

```bash
pnpm vitest run apps/server/src/services/runtimes/<name>/   # adapter + conformance suite
pnpm vitest run apps/server/src/services/runtimes/__tests__/ # label bound over the real catalogs
pnpm lint                                                    # SDK confinement holds
pnpm typecheck
DORKOS_<NAME>_LIVE=1 pnpm vitest run .../conformance.test.ts # local live smoke
```

Then boot `pnpm dev`, confirm the registration log line, and check the runtime appears in the picker (with the setup dialog when its dependencies fail).

## Common Traps

Lessons paid for during the Codex/OpenCode implementation:

- **The `getInternalSessionId` C1-rekey trap.** Return `undefined` unless your backend genuinely re-keys the canonical session id the way Claude's JSONL store does. Trigger-turn treats a returned id as the _canonical_ id: it re-keys the projector and the 202 response, orphaning the client's subscription. Both new adapters keep their native ids (Codex thread id, OpenCode `ses_*` id) adapter-internal and return `undefined`; see the TSDoc on `CodexRuntime.getInternalSessionId`.
- **The runtime tag is the aggregation key (ADR-0310).** Every `Session` you return must carry `runtime: this.type`; conformance asserts it. The listing layer (`aggregateSessionList`, `apps/server/src/services/session/aggregate-session-list.ts`) merges across runtimes on that tag and degrades per runtime (partial list + `warnings[]`, 2s timeout) - a mis-stamped session lands under another runtime's identity everywhere.
- **Raw wire events vs SDK-typed unions.** The SDK's generated types are a claim, not a guarantee. OpenCode's true text-delta event (`message.part.delta`) is absent from the SDK's 32-member `Event` union (the adapter declares `EventMessagePartDelta` itself); Codex's stream-level `error` is documented "unrecoverable" but live probes show it recovering into a normal turn. Verify against live traces and upstream source, handle unknown event types without crashing, and write down what you verified in `NOTES.md`.
- **Cumulative snapshots masquerading as deltas.** Both SDKs emit cumulative item text. Suffix-diff in the mapper context or the UI renders every paragraph twice.
- **Sidecar lifecycle (if applicable).** A restarted sidecar mints new credentials, so an SDK's internal SSE retry reconnects with stale auth forever; disable it and own reconnection yourself (`global-event-hub.ts` is the pattern - on drop, fail in-flight turns with a typed error, re-obtain a fresh client through the manager's backoff, resubscribe). Bind loopback-only, inject a conservative permission ruleset (`OPENCODE_SIDECAR_CONFIG`), and wire `shutdownServices()` teardown so no orphan survives DorkOS.
- **Registering after `sessionListBroadcaster.start()`.** Sessions exist but never stream into the session list. Register earlier (step 7).
- **Flat-config ESLint replace semantics.** Adding your per-adapter block without restating the other SDK bans silently un-bans them in your directory (step 5).
- **Prose that names a tool the model cannot call.** A system-prompt block written with the tool's registered name instead of the name your runtime exposes reads perfectly and fails at run time; strong models silently correct for it, cheap ones do not. See [Teach tools by the name your runtime actually exposes](#3b-teach-tools-by-the-name-your-runtime-actually-exposes).
- **A `displayName` or `label` nobody told you was bounded.** A hand-written model catalog and the client `RuntimeDescriptor.label` must both fit `STATUS_VALUE_MAX_CHARS` (13), enforced by tests that live outside your adapter directory. Overshoot and you either fail a test you have never heard of or ship a silently truncated status-line label. See [Labels are budgeted](#labels-are-budgeted-status_value_max_chars).

## Anti-Patterns

```typescript
// ❌ NEVER reach into another product's private storage
const rows = sqlite.open('~/.local/share/opencode/...'); // schema is not yours; ADR-0308/0310

// ✅ Read through the SDK; treat native storage as opaque
const sessions = await client.session.list({ directory });

// ❌ NEVER emit `done` from multiple mapper branches
case 'session.status': return [doneEvent()]; // double-terminal when session.idle follows

// ✅ One authoritative turn terminal; a wrapper owns the invariant (mapCodexThread pattern)

// ❌ NEVER let conformance (or any CI test) touch the real binary
runtimeConformance(() => new MyRuntime({}));  // spawns `mytool --version` in checkDependencies

// ✅ Mock the SDK and the dependency probe; gate live smokes behind an env flag

// ❌ NEVER report a fake capability to light up UI
supportsToolApproval: true, // backend auto-cancels approvals; UI shows dead buttons

// ✅ Declare what the backend genuinely does; the UI adapts per capability

// ❌ NEVER write a first-party label longer than STATUS_VALUE_MAX_CHARS (13)
displayName: 'MyRuntime Turbo 2 Preview', // status line renders "MyRuntime Tu…"

// ✅ A name that fits the bound, registered in FIRST_PARTY_CATALOGS so it stays fitting
displayName: 'Turbo 2',
```

## Related Guides

- [architecture.md](architecture.md): where `AgentRuntime` sits in the hexagonal architecture
- [configuration.md](configuration.md): config schema, migrations, precedence
- [api-reference.md](api-reference.md): the routes that consume the registry
- [project-structure.md](project-structure.md): server service domains
