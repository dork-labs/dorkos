# Adding a Memory Provider

## Overview

This guide walks through adding a new backend behind the `MemoryProvider` port: the **fifth swappable seam**, beside `AgentRuntime`, `Transport`, `ConnectorProvider` and `CommunityAdapter`. Memory is what an agent durably knows — the facts, preferences and lessons it carries from one conversation into every other one. DorkOS ships one backend, `builtin`, which is a small markdown file beside each agent; the port exists so a vector store or a hosted memory service is a registration and a config value rather than a fork.

If you have read [adding-a-community-adapter.md](adding-a-community-adapter.md) or [adding-a-connector.md](adding-a-connector.md), this will feel familiar: one Zod-first contract, N backends, a server-side registry, capability flags, and a shared conformance suite that gates every implementation.

Spec: [`specs/agent-memory/02-specification.md`](../specs/agent-memory/02-specification.md) §D7. Configuration reference: [configuration.md](configuration.md) → `memory.provider`.

## Key Files

| Concept                         | Location                                                                                           |
| ------------------------------- | -------------------------------------------------------------------------------------------------- |
| The contract                    | `packages/shared/src/memory-provider.ts` (`MemoryProvider`, schemas, five of the six typed errors) |
| The sixth typed error           | `packages/memory/src/paths.ts` (`MemoryPathError` — the engine's, not the port's)                  |
| The engine behind `builtin`     | `packages/memory/` (`createBuiltinMemoryProvider`, the store, the ops, the path jail)              |
| Conformance suite + fake        | `packages/test-utils/src/memory-conformance.ts`, `packages/test-utils/src/fake-memory-provider.ts` |
| Registry, quarantine, fallback  | `apps/server/src/services/memory/registry.ts`                                                      |
| The config key                  | `packages/shared/src/config-schema.ts` (`memory.provider`)                                         |
| Consumer: the injected block    | `apps/server/src/services/runtimes/shared/agent-context.ts` (`buildMemoryBlock`)                   |
| Consumer: the agent's own write | `apps/server/src/services/memory/memory-capabilities.ts` (`memory_write`)                          |

## The four rules

Restated from the port's own docblock, because each means something specific about memory:

1. **One instance serves ONE backend.** Every address is the pair `(provider, AgentMemoryRef)`.
2. **Every method is REQUIRED.** A capability-gated method whose capability is off rejects with `MemoryUnsupportedError` — never a silent no-op, never a partial write. "This backend cannot search" and "I searched and found nothing" are the same sentence to a model unless one of them is an error.
3. **No credential crosses this port** — not as an argument, not on a DTO, not in `info.capabilities`. Resolve yours from a server-side store.
4. **Nothing here executes an agent.** No turn, no session handle. Memory is read and written _around_ a turn, never by one.

**Scope is the agent identity, never a session or a room.** `AgentMemoryRef = { agentId, agentPath }` carries no session id and no room id, so you cannot accidentally shard memory per conversation. A backend that let two refs read each other's memory fails the conformance suite.

## What each method owes

- **`info`** — your id (the value `memory.provider` names) and two capability flags. Static for the life of the instance. No descriptive colour: a flag nobody branches on is a claim nothing can check.
- **`getSnapshot(ref)`** — **three-way honest**: `'present'`, `'absent'`, `'error'`. Never throws for either of the last two. Collapsing `'error'` into `'absent'` is the failure this port exists to prevent: an agent told its memory is empty writes a fresh note over the top of everything it could not read.
- **`write(ref, op)`** — one op union (`add` / `replace` / `remove`), applied atomically with respect to every other writer of the same agent's memory in your process. Every failure is a **refusal, not a partial write**: `MemoryMatchError` when a `replace`/`remove` does not name exactly one editable place, `MemoryNoteShapeError` when the note carries a line break (a forgery defence — see the port's docblock), `MemoryCapExceededError` past your cap, `MemoryIOError` when your own storage failed.
- **`query(ref, q)`** — gated on `search`. Refuse loudly when it is off.
- **`forget(ref, selector)`** — same unique-substring rule as `remove`. Forgetting the wrong note is worse than forgetting none.
- **`consolidate(ref)`** — gated on `consolidate`. A caller must never block a turn on it.

## Steps

### 1. Implement the port

Write the backend anywhere it belongs (a package for an engine, `apps/server/src/services/memory/` for thin wiring). Depend only on `@dorkos/shared/memory-provider`.

### 2. Pass the conformance suite

```typescript
import { memoryConformance } from '@dorkos/test-utils/memory-conformance';

memoryConformance(() => createAcmeMemoryProvider(), {
  name: 'acme MemoryProvider — conformance',
  capChars: ACME_MAX_CHARS,
  makeRef: async () => ({ agentId: await freshAgentId(), agentPath: '/…' }),
  makeUnreadableMemory: async () => ({ provider, ref }), // optional, but provide it
});
```

`makeRef` must mint a **fresh, empty** scope on every call — the suite calls it more than once per test, and a backend that leaked between agents would otherwise pass by reading its own leftovers. `capChars` is required: a backend with no cap cannot promise that the block injected into every turn has a bounded prompt cost.

`makeUnreadableMemory` is the only optional hook. Declining it registers a named `it.skip` rather than a quiet pass — provide it wherever a failure can be arranged (the builtin test puts a directory where the file goes, so the read fails with `EISDIR` rather than `ENOENT`).

The suite is capability-aware and **never weakened**: `search: false` must REFUSE `query` with the typed error, and `search: true` must answer it. Both branches are real assertions.

### 3. Register it

```typescript
registerMemoryProvider('acme', () => createAcmeMemoryProvider());
```

at the composition root. The factory is called at most once per process, on first use — one instance serves every agent, so whatever in-process lock you keep is actually shared.

### 4. Let an operator choose it

`memory.provider` is a plain string, so nothing needs to change for a new id to be selectable. What does need doing is the config lifecycle if you add settings of your own: see the `adding-config-fields` skill.

## The one behaviour the other seams do not have

**Quarantine-and-fallback.** Memory rides every turn, so a memory backend that throws could take down every conversation on the machine. The registry does not allow that:

- A provider that **faults** — throws anything that is not one of the port's own refusals — is **benched for the rest of the process**. `builtin` takes over the call that faulted and every call after it, and **exactly one** warning is logged. One, not one per turn.
- The port's refusals (`MemoryUnsupportedError`, `MemoryMatchError`, `MemoryCapExceededError`, `MemoryNoteShapeError`, `MemoryIOError`, plus the engine's `MemoryPathError`) bench **nobody**. They are the backend working correctly. `MemoryIOError` is on that list deliberately: a full disk is a fact about the machine, not evidence that your backend is broken, and swapping backends would not fix it.
- `builtin` itself is never benched, because there is nothing behind it. When the fallback fails, memory degrades to **nothing injected** and the turn still runs.

Two consequences worth planning for. **The fallback swaps which memory an agent has**, not just which code serves it: `builtin` starts from its own scaffold, so an agent whose notes live in your backend reads an empty file and its next `write` reports `created: true`. To a person watching, that reads as amnesia rather than as an outage, which is why the warning names your backend and the changelog says it out loud. And **a `write` that faults is re-attempted against `builtin`**, so a backend that faults AFTER committing has stored the note twice — once with you, once in the file. Fail before you commit, or make your writes idempotent.

What this means for you as an author: **throw the typed errors.** A backend that wraps a network failure in a `MemoryIOError` keeps serving; the same failure thrown as a bare `Error` benches you for the rest of the run. That is the correct outcome for a genuinely broken backend and an annoying one for a transient blip, and the typed error is how you tell the registry which you had.

If you ship your own copy of `@dorkos/shared`, your errors are different class objects from this server's and `instanceof` cannot see them — so the classification also accepts any `Error` whose `name` is one of the six. Setting `this.name` (which every error here does) is enough; the class identity is not required.

## Verification

```bash
pnpm vitest run <your conformance test>
pnpm vitest run apps/server/src/services/memory/__tests__/registry.test.ts
pnpm --filter @dorkos/server typecheck
```
