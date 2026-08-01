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
- **Emitting an `approval_required`**: include `timeoutMs` — the budget after which the ask is auto-denied and the run continues. The card's countdown is gated on it, so a card raised without one shows no deadline at all.
- **Storage queries** (`listSessions`, `getSession`, `getMessageHistory`, `getSessionSnapshot`, `subscribeSession`, `subscribeSessionList`, `getSessionTasks`, `getSessionETag`, `getLastMessageIds`, `readFromOffset`): serve from your backend's native storage or the EventLog (see the split below). `getSession` returns `Session | null`, never throws, and must stamp `runtime: this.type`.
- **Locking** (`acquireLock`, `releaseLock`, `isLocked`, `getLockInfo`): do not hand-roll. Instantiate the shared `SessionLockManager` from `apps/server/src/services/session/session-lock.ts` and delegate, exactly as both new adapters do:

  ```typescript
  import { SessionLockManager } from '../../session/session-lock.js';

  private readonly locks = new SessionLockManager();
  ```

- **Capabilities** (`getCapabilities`, `getSupportedModels`, `getSupportedSubagents`, `checkDependencies`): see the next two sections.
- **Lifecycle** (`checkSessionHealth`, `getInternalSessionId`): `getInternalSessionId` is a loaded gun; see [Common Traps](#common-traps).
- **Optional DI setters** (`setSessionSettings`, `setMeshCore`, `setRelay`, ...): implement `setSessionSettings` so per-session settings (model, permission mode) hydrate from and write through to the durable `session_metadata` store (ADR-0260). The composition root injects `runtimeRegistry` as the port.

### RuntimeCapabilities

`getCapabilities()` returns a static `RuntimeCapabilities` object. Keep it in a `runtime-constants.ts` (`CODEX_CAPABILITIES`, `OPENCODE_CAPABILITIES` are the models). Two parts deserve care:

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

  Two conformance assertions to know about: `default` must reference a declared descriptor, **and** that descriptor's `stop` must not be `'autonomy'` — a runtime whose fresh sessions start with the keys handed over fails. If yours genuinely must (test doubles), declare `autonomyDefaultReason` in your `runtimeConformance` call; it takes a sentence, not a boolean.

  `reach: 'read'` is load-bearing and narrow: it means no writes, no commands, **and no network**. The derivation rules treat a read-only mode as having nothing to warn about, so a mode that can still fetch a URL must declare `'edit'` or wider.

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

`runtimeConformance(makeRuntime, opts)` registers a `describe` block asserting session lifecycle, StreamEvent well-formedness and the terminal `done`, interrupt semantics, history shape, `RuntimeCapabilities` structure (including the permission-modes contract), and `DependencyCheck` validity. The factory runs once per test; declare legitimate cross-runtime differences via `RuntimeConformanceOpts` (`name`, `projectDir`, `permissionMode`, `expectHistory`, `messageContent`) instead of weakening assertions. `test-mode/__tests__/conformance.test.ts` is the minimal wiring; `codex/__tests__/conformance.test.ts` is the full pattern.

A runtime that declares `logBackedHistory: true` must also pass the `durableHistory` opt — wire it to `driveDurableTurn` (`apps/server/src/services/session/__tests__/durable-turn-harness.ts`), which runs one real turn through the projector → durable store path, drops the projector (the restart analog), and asserts history reconstructs from the store (DOR-189). All three log-backed suites show the wiring.

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

Add a `runtimes.<name>` object to `UserConfigSchema` in `packages/shared/src/config-schema.ts`, following the existing shape (`enabled`, `binaryPath`, plus backend-specific fields like OpenCode's `port`). Then add a semver-keyed backfill to `CONFIG_MIGRATIONS` in `apps/server/src/services/core/config-manager.ts`; `backfillRuntimesDefaults` (keyed `'0.47.0'`) is the pattern to copy. Key the migration to the next unreleased version; `/system:release` detects drift and reconciles the key at tag time. Full lifecycle: [configuration.md → Schema Migrations](configuration.md#schema-migrations) and the `adding-config-fields` skill.

### 7. Register in the composition root (+ teardown)

In `apps/server/src/index.ts`, after the Claude registration block (search for "Codex runtime"):

```typescript
const myConfig = configManager.get('runtimes').myruntime;
if (myConfig.enabled) {
  const myRuntime = new MyRuntime({
    /* deps: db-backed maps, config */
  });
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
