---
slug: agent-workspace-binding
id: 260726-162520
created: 2026-07-26
status: implemented
---

# Agent workspace binding — every agent knows where it works

**Status:** Implemented <!-- Draft | Under Review | Approved | Implemented -->
**Author:** Claude (directed by Dorian)
**Date:** 2026-07-26
**Tracker:** [DOR-1589](https://linear.app/dorkspace/issue/DOR-1589), [DOR-1590](https://linear.app/dorkspace/issue/DOR-1590)
**Project:** Agents as First-Class Operators

**Shipped 2026-08-28** as Phase 0 of the `project-rooms` programme, in the compressed phasing that
spec's Implementation Phases section describes: the manifest field and the `owner` discriminator
(DOR-1589), then `resolve-session-cwd.ts` and the re-pointing of the three cwd derivations
(DOR-1590). `resolve-session-cwd.ts` declares a fourth rung, `room-worktree`, which `project-rooms`
§3.5 wired ahead of the agent binding.

**Code references in this document are anchored by file and symbol, not by line
(corrected 2026-08-29, DOR-1602).** Both files originally cited `path.ts:NNN`, and every one of
those numbers had drifted by the time the spec shipped — several onto unrelated code, two past the
end of the file they named. Re-pinning them to today's lines would only re-arm the same trap, so
the numbers are gone and the surrounding prose names the symbol instead.

## Overview

Give an agent a working directory of its own. One optional field on the agent manifest declares where the agent works; one nullable ownership field on the `Workspace` entity records the checkout that was provisioned for it; one resolver turns those into the cwd of every turn, on a three-rung precedence chain — **explicit `cwd` → the agent's binding → `DEFAULT_CWD`**.

This spec does not build workspaces. `WorkspaceManager` shipped with DOR-84 and is unused from the cockpit; this makes an **agent** its first real owner.

## Background / Problem Statement

`AgentManifestSchema` (`packages/shared/src/mesh-schemas.ts`) has no working directory. `SessionOpts.cwd` is optional (`packages/shared/src/agent-runtime.ts`), and when absent every runtime falls through to one process-wide constant, `DEFAULT_CWD` (`apps/server/src/lib/resolve-root.ts`) — claude-code at `claude-code-runtime.ts`, codex at `codex-runtime.ts`, opencode at `opencode-runtime.ts`. **Every agent that does not name a directory works in the same folder as every other one.**

Measured (DOR-500): six concurrent agents in one tree produced pervasive fine-grained write interleaving; splitting them across two trees roughly doubled write survival.

Four facts from the tree, verified at `5a84de271`, shape the design:

1. **Agents already have a stable directory identity.** `agents.project_path` is `.notNull().unique()` (`packages/db/src/schema/mesh.ts`) — no two agents share a directory. It is absent from the manifest because `.dork/agent.json` is located _at_ that path.
2. **Three surfaces already re-derive it, differently.** The task scheduler resolves an agent-linked task's cwd to `getProjectPath` (`task-scheduler-service.ts`); the relay binding router stamps `cwd: projectPath` onto the dispatch payload (`binding-router.ts`); the cockpit inverts the relation entirely and derives _the agent_ from _the selected directory_ (`use-current-agent.ts`), seeded from `GET /api/directory/default` when nothing is chosen (`use-default-cwd.ts`).
3. **`session_metadata.agent_path` is written and read by nothing.** The column exists (`packages/db/src/schema/sessions.ts`), `persistSessionRuntime` writes it first-write-wins (`runtime-registry.ts`), and no code reads it. This spec is its first consumer.
4. **`workspaceKey` has zero client callers.** `POST /api/sessions/:id/messages` accepts it and provisions on it (`sessions.ts`), but nothing in `apps/client/src` passes it. The whole WorkspaceManager subsystem is reachable only from `/api/workspaces` and the `/workspaces` page.

## Goals

- An optional `workspace` field on `AgentManifest` with three modes: `home`, `managed`, `none`; absent reads as `home`.
- One resolver, called once per turn at the session boundary, implementing `explicit cwd → agent binding → DEFAULT_CWD`, with every resolved path boundary-validated and the winning rung logged.
- An `owner` discriminator on `Workspace` so an agent-owned checkout is distinguishable from a unit-of-work one — which makes `sweep` exemption structural rather than conventional.
- Zero behavior change for every caller that already supplies a `cwd`, and for every caller that names no agent at all.
- Subagent inheritance stated as an invariant and protected by a regression test.
- `DEFAULT_CWD` preserved in all three of its current roles.
- One meaning for the phrase "agent workspace" in the codebase after this ships.

## Non-Goals

- **Making `cwd` mandatory.** Considered and rejected: it breaks external MCP callers that have no meaningful path (`session?.cwd ?? deps.defaultCwd`, `mcp-tools/index.ts`), test-mode and e2e sessions, and non-code agents. The defect is that the default is global, not that a default exists.
- **The resource lock / write-locking mechanism.** A separate concern and a lower priority once agents stop sharing a tree by default. It remains the honest answer for concurrent sessions of the _same_ agent, which this work does not address (see Open Questions).
- **Channel workspaces.** A sibling spec, being written concurrently. Related, referenced, not designed here.
- **New `WorkspaceProvider` implementations.** `container`/`remote` remain out of scope (ADR-0283 admits them).
- **Any change to the `AgentRuntime` interface.** Binding stays `cwd = <resolved path>`, as DOR-84 established.
- **Multi-machine coordination.** Unchanged from the WorkspaceManager spec's non-goals.

## Technical Dependencies

Internal only. `@dorkos/shared` (`mesh-schemas.ts`, `workspace.ts`, `schemas.ts`), `@dorkos/db` (`workspaces`, `session_metadata`, `agents`), `@dorkos/mesh` (`MeshCore.getProjectPath`, `onUnregister`), the shipped `services/workspace/` subsystem, `lib/boundary.ts` (`validateBoundary`, `validateBoundaryOrDorkHome`), `lib/dork-home.ts`. No new third-party libraries.

## Detailed Design

### 3.1 The manifest field (intent)

```ts
// packages/shared/src/mesh-schemas.ts
export const AgentWorkspaceBindingSchema = z
  .discriminatedUnion('mode', [
    z.object({ mode: z.literal('home') }),
    z.object({
      mode: z.literal('managed'),
      source: z.string().min(1),
      provider: WorkspaceProviderTypeSchema.optional(),
    }),
    z.object({ mode: z.literal('none') }),
  ])
  .openapi('AgentWorkspaceBinding');

// on AgentManifestSchema:
workspace: AgentWorkspaceBindingSchema.default({ mode: 'home' }),
```

- `home` — the agent works in its own directory (its `agentPath`). No entity, no provisioning, no ports, no git requirement. Covers DorkBot at `{dorkHome}/agents/dorkbot/` and every marketplace-installed agent.
- `managed` — the server `ensure`s a `Workspace` from `source` and the agent works in the checkout. The mode that gives N agents on one repo N trees.
- `none` — no binding; the resolver falls to `DEFAULT_CWD`. Explicitly sayable, so "share the default" is a choice rather than the accident of an unset field.

A discriminated union rather than three loose optional fields: `source` is meaningless without `managed`, and the union makes that unrepresentable instead of merely discouraged.

**Why the manifest and not a config leaf or a DB column.** `agent.json` is the source of truth for user-owned agent preferences (persona, traits, `enabledToolGroups`), and this is one. The agent-approval-settings spec rejected `agent.json` for standing grants because file-beats-DB reconciliation lets an agent grant itself trust; that reasoning is correct there and does not transfer here, **and the spec says so explicitly rather than leaving the asymmetry unexplained**: a working directory is not a containment boundary. An agent that can write files can already write anywhere inside `DORKOS_BOUNDARY`; moving its own cwd buys it nothing it did not have. Containment remains `DORKOS_BOUNDARY` plus the tier gate. This is a judgement call, recorded as one, with one invariant making it safe: **every resolved path is boundary-validated at resolution time**, so no binding — however written — can widen reach.

### 3.2 The workspace owner (realization)

```ts
// packages/shared/src/workspace.ts — on WorkspaceSchema
owner: z
  .object({ kind: z.literal('agent'), ref: z.string() })
  .nullable()
  .default(null),
```

`ref` is the agent's **`agentPath`**, never its ULID. This follows DOR-446 exactly, for the reason its schema states: the `agents` table is a derived cache the reconciler is licensed to delete and rebuild, "re-registering every agent under a fresh ULID" (`packages/db/src/schema/agent-identity.ts`). `agentPath` is what survives a rebuild, and `agents.project_path` being `unique` makes it a legitimate key.

Two columns on the `workspaces` table (`owner_kind TEXT`, `owner_ref TEXT`), both nullable. `NULL` means unit-of-work — today's semantics — so existing rows and existing sidecar manifests need no backfill. The sidecar manifest stays the source of truth (ADR-0043 write ordering unchanged: manifest before DB, manifest deleted before row).

Keying an agent workspace inside the existing `(projectKey, key)` uniqueness:

- `projectKey` = `sanitizeWorkspaceKey(path.basename(source))` — unchanged from `sessions.ts`.
- `key` = `agent-${sanitizeWorkspaceKey(manifest.name)}-${sha256(agentPath).slice(0, 8)}`.

The name makes the directory legible on disk and in the `/workspaces` list; the path digest makes it stable and collision-free when two agents in different directories share a slug. The alternative — a reserved `projectKey` such as `"agents"` with a bare slug key — was rejected as stringly-typed reserved-prefix magic (a Hard No in `.claude/rules/conventions.md`) and because it would put every agent's checkout under one project key regardless of which repo it came from.

**`sweep` exemption is structural.** `WorkspaceService.sweep()` today removes every non-pinned, non-dirty workspace (`workspace-service.ts`); it has no production caller and its `retentionCap` config is threaded in and never read (`workspace-service.ts`). Agent-owned rows are skipped with `reason: 'owned'` (a new `SweepResult.skipped` reason) rather than being protected by setting `pinned: true`, because a convention someone must remember is not a safety property. The unread `retentionCap` is a pre-existing gap noted here and left alone — fixing it is not this spec's job, but a sweep that silently ignores its own cap should not also be silently deleting agent homes.

### 3.3 The resolver

```ts
// apps/server/src/services/workspace/resolve-session-cwd.ts
export interface ResolvedCwd {
  cwd: string;
  // `room-worktree` is DECLARED here and returned by nothing: the project-rooms
  // programme (spec `project-rooms` §3.5) wires it in its task 2.2. It sits
  // between `explicit` and the agent binding, so the type is the whole chain
  // rather than most of it.
  rung: 'explicit' | 'room-worktree' | 'agent-home' | 'agent-managed' | 'default';
  workspaceId?: string;
  /** Why a lower rung answered than the binding asked for. */
  degraded?: string;
}

export async function resolveSessionCwd(req: {
  cwd?: string;
  agentPath?: string;
  sessionId?: string;
}): Promise<ResolvedCwd>;
```

Order, exactly:

1. **`req.cwd`** present → `{ rung: 'explicit' }`. Nothing else is consulted. This is what keeps every cockpit turn, every already-resolved task, and every relay dispatch byte-for-byte unchanged.
2. **An agent is named** — `req.agentPath`, else `session_metadata.agent_path` for `sessionId`. Read its manifest:
   - `home` → `{ cwd: agentPath, rung: 'agent-home' }`.
   - `managed` → `ensure({ projectKey, key, source, provider, owner })` → `{ cwd: workspace.path, rung: 'agent-managed', workspaceId }`.
   - `none` → fall to 3. No `degraded`: sharing the default folder is what was asked for.
   - manifest unreadable, or a `managed` binding that cannot be provisioned → **stay on rung 2 as `agent-home`, carrying a `degraded` reason.**
3. **`DEFAULT_CWD`** → `{ rung: 'default' }`.

**Degradation goes one rung, not all the way out.** An earlier draft of this spec sent every rung-2 failure to `DEFAULT_CWD`. That is wrong, and the reason is DOR-500: reaching rung 2 at all means the caller ALREADY KNOWS the agent's directory, so answering with the shared default would move that agent's work into the tree every other agent is also writing in — over an unreadable file. The interleaving this whole chain exists to prevent would be reintroduced by its own error path.

So an unreadable manifest reads as `home`, on exactly the same rule as an ABSENT `workspace` field, and a `managed` binding that cannot be provisioned falls back to the agent's own folder rather than to the vault root. `DEFAULT_CWD` is reached from rung 2 in one case only: the agent's own folder is itself refused by the boundary, so there is nothing nearer left to fall back to.

The result is boundary-validated before use: `validateBoundaryOrDorkHome` for the agent-home rung (an agent home under `{dorkHome}/agents/*` is legitimate by design — see `lib/boundary.ts`), `validateBoundary` for a managed checkout, which always lives under the workspace root. Rung 1 is deliberately NOT validated — an explicit `cwd` reaches the runtime exactly as it did before this resolver existed, and the surfaces that must confine a person-supplied path (file reads, terminal, git, the directory browser) validate at their own edges. Validating here would 403 turns that run today, which is the one thing this change promised not to do.

**Failure never fails the turn.** A `managed` binding whose provisioning throws — port pool exhausted (`port-allocator.ts`), git failure, source repo missing — degrades as above with a warning, mirroring the existing `try`/`catch` in the `workspaceKey` block. A turn that cannot get its preferred tree still runs; it does not 500.

**One spelling per directory.** The agent path is canonicalized (`fs.realpath`, falling back to `path.resolve` when the directory does not resolve) before it is digested into the workspace key and before it is stored as `owner.ref`. `/tmp/x`, `/private/tmp/x` and `/tmp/x/` are one folder; without this they would be three digests, giving one agent up to three checkouts and up to three ownership records of which at most one could ever match.

**Call site.** `POST /api/sessions/:id/messages`, replacing the current `workspaceKey` block (`sessions.ts`). `workspaceKey` survives untouched and takes precedence over the agent binding when supplied — it is a per-turn unit-of-work override, a strictly more specific statement than a standing per-agent preference.

**Observability.** Each turn logs one line naming the rung, the resolved cwd, and any `degraded` reason. Without it, "why is my agent writing there" is unanswerable, and a three-rung chain that cannot be interrogated is worse than the one-rung chain it replaces.

### 3.4 Subagents inherit — the invariant

**The binding resolves exactly once per turn, at the session boundary, before the runtime is invoked. Nothing inside a turn may call `resolveSessionCwd`.**

A claude-code subagent is an SDK sidechain running inside the parent's `query` and inherits the parent process's cwd by construction — nothing in the subagent path re-enters session creation (`transcript-parser.ts`, `message-event-mapper.ts` merely map its output). Codex and opencode behave the same way. So the invariant is currently true for free; the risk is that a future "resolve per tool call" convenience quietly breaks it.

This is the distinction that makes the whole model coherent, and it should be readable as one sentence in the code comment: **a subagent is the same agent doing the same task, so it stays in the tree; a peer agent reached over Relay or Mesh is a different agent, so it gets its own session, its own `agentPath`, and its own binding.** Delegation down stays put; delegation across moves.

Protected by a regression test that spies on the resolver and asserts exactly one call across a turn containing a subagent (`FakeAgentRuntime` + a scenario with a Task-tool sidechain).

### 3.5 Lifecycle

| Event                     | Behavior                                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent created             | Binding defaults to `home`. Nothing is provisioned.                                                                                                                                   |
| Mode set to `managed`     | Nothing is provisioned yet. Intent is recorded.                                                                                                                                       |
| First turn, `managed`     | `ensure` provisions or reuses. Idempotent on `(projectKey, key)`.                                                                                                                     |
| Later turns               | Same workspace, reused. `lastUsedAt` bumped. A workspace outlives every session bound to it.                                                                                          |
| Agent renamed             | `key` contains the name, so the derived key changes. The old row is **not** orphaned: lookup is by `owner.ref` (the path), which did not move; the stored `key` stays as provisioned. |
| Agent directory moved     | `owner.ref` no longer matches any agent. The workspace becomes unowned and appears on `/workspaces` as an ordinary row. Same limitation as DOR-446 identity tokens.                   |
| Agent unregistered        | `onUnregister` (`apps/server/src/index.ts`) clears `owner`. The checkout is **never** auto-deleted.                                                                                   |
| `sweep()`                 | Skips `owner.kind === 'agent'` with `reason: 'owned'`.                                                                                                                                |
| Workspace deleted by user | Existing dirty-gated `DELETE /api/workspaces/:id`, unchanged. The binding stays `managed`; the next turn re-provisions.                                                               |

Never auto-deleting is not caution for its own sake — it is research finding 5 of `20260611_workspace_strategy_runtimes_symphony.md`, which documents Claude Code #46444 (ten days of uncommitted work destroyed) and Cursor's force-deleted branches. Unregistering an agent says nothing about the code in its tree.

### 3.6 What `DEFAULT_CWD` keeps doing

Unchanged, in all three roles. It is not deprecated, and it is not merely a lazy fallback:

1. **The directory browser's start point.** `GET /api/directory/default` returns it (`routes/directory.ts`). It stays agent-unaware — a deliberate non-change, written down because someone will otherwise "fix" it. Where the folder picker opens is a UI affordance about the machine, not a statement about where work happens.
2. **Tied to the security boundary.** The CLI clamps `DORKOS_DEFAULT_CWD` to the boundary root, and the route returns the clamped value for the documented reason (`directory.ts`): the unclamped `process.cwd()` handed clients a directory that boundary-enforced routes then rejected with 403.
3. **The MCP fallback for external callers with no meaningful path.** `session?.cwd ?? deps.defaultCwd` (`mcp-tools/index.ts`) is unchanged.

The only thing that changes is its position: from "rung 1 for everything" to "rung 3 for callers who genuinely have no better answer", which is what it was always for.

### 3.7 Ports

- `home` — no `Workspace`, no port block, no `.env`.
- `managed` — a real workspace on the same terms as any other. The server remains the port authority (ADR-0284); blocks are disjoint by construction, so collision is impossible.

**Ceiling.** With shipped defaults (`portBase` 4250, `portBlockSize` 10, ceiling 65535) the pool holds ≈6,128 blocks. Agent count is not the binding constraint; disk and git worktrees are. **Exhaustion** throws from `lowestFreeBlock`, `ensure` marks the workspace `failed`, and §3.3's degradation returns rung 3 with a warning — the turn runs.

`ensure` continues to cut a `dork/<key>` branch and to upsert `DORKOS_PORT`/`VITE_PORT`/`SITE_PORT` into the checkout's `.env` (`port-env.ts`). Accepted unchanged: an agent-owned checkout of a source repo is the same kind of object as a unit-of-work checkout, and forking the code path to suppress a harmless file would be the more expensive of the two mistakes. Noted rather than hidden.

### 3.8 Terminology

`createAgentWorkspace` (`apps/server/src/services/core/agent-creator.ts`) already means "scaffold `.dork/agent.json`, SOUL.md, and NOPE.md into a directory" — its module doc opens "Agent workspace creation service". Shipping this spec without settling that leaves two meanings of "agent workspace" in one server, which is exactly the tolerated legacy AGENTS.md forbids.

Renamed to **`scaffoldAgentHome`**, with its module doc updated. Three call sites: `routes/agents.ts`, `apps/server/src/index.ts`, `marketplace/flows/install-agent.ts` (plus the `AgentCreatorDeps` type at `install-agent.ts`). Mechanical, and it is the difference between a codebase that gets cleaner and one that accretes homonyms.

### 3.9 Code structure

```
packages/shared/src/mesh-schemas.ts            # AgentWorkspaceBindingSchema + manifest field
packages/shared/src/workspace.ts               # owner on WorkspaceSchema; 'owned' sweep reason
packages/db/src/schema/workspace.ts            # owner_kind, owner_ref columns
apps/server/src/services/workspace/
  resolve-session-cwd.ts                       # NEW — the three-rung resolver
  workspace-service.ts                         # owner threading; sweep exemption
  workspace-store.ts                            # owner in the sidecar manifest
apps/server/src/routes/sessions.ts             # call the resolver instead of the inline block
apps/server/src/services/core/agent-creator.ts # createAgentWorkspace → scaffoldAgentHome
apps/client/src/layers/entities/agent/         # binding in the agent query/mutation types
apps/client/src/layers/features/agent-hub/     # the Workspace control
```

### 3.10 API changes

- `AgentManifest` gains `workspace`, so every surface that READS a manifest carries it for free through the existing Zod schema — `GET/POST /api/agents`, the mesh registration payloads, the `create_agent` MCP tool. OpenAPI regenerates.
- **`PATCH /api/agents` does NOT carry it, and that is deliberate.** The PATCH surface is an explicit `.pick()` allowlist on `UpdateAgentRequestSchema`, and `workspace` is not in it — nothing rides that route "for free". Phase 1 leaves it out rather than answering the open question below ("should an agent be able to change its own binding?") by accident: adding it to the allowlist is a one-line, reversible decision, while shipping it and then discovering it needed operator-only classification means moving the field out of `agent.json`, which is a migration. **Until Phase 2 adds the Agent Hub control, the only way to set a binding is to edit `.dork/agent.json` directly.**
- The `workspace` field is `.catch()`-degraded on the manifest, on the `model`/`effort` precedent: a binding this build cannot read is logged and read as `{ mode: 'home' }` rather than failing the whole manifest parse. Strictness was tried and reverted — it changed no cwd (an unreadable manifest already resolves to the agent's own folder, which is what `home` means) while costing the agent its entire presence in the fleet over a typo, and bricking forward compatibility when a newer build writes a mode this one has not learned.
- `Workspace` gains `owner` — `GET /api/workspaces`, `GET /api/workspaces/:id`, `GET /api/workspaces/resolve`.
- `POST /api/sessions/:id/messages` — no schema change. `workspaceKey` keeps its meaning and its precedence over the agent binding.
- No `Transport` method is added. The binding rides the agent entity that `Transport` already carries.

## User Experience

An agent gets a "Workspace" control in the Agent Hub with three choices, worded for a person rather than for the schema:

- **Its own folder** (default) — "This agent works in its own directory."
- **Its own checkout of a repo** — "Give this agent a private copy of a repository so it does not collide with your other agents." Asks for the repo.
- **Wherever it is pointed** — "No preference. Uses whatever folder the session is opened in."

The session view's existing workspace indicator (`features/status/GitStatusItem.tsx`) already resolves by path, so an agent working in a managed checkout shows it with no new UI. The `/workspaces` page gains an owner column so an agent's tree is distinguishable at a glance from a unit-of-work tree — and, importantly, so a user can see _why_ a workspace was not swept.

Error and exit paths: a `managed` binding that cannot provision produces a visible warning on the turn ("Couldn't set up this agent's workspace — running in the default folder instead" plus the reason) and the turn proceeds. A user who deletes a managed workspace from `/workspaces` gets it back on the agent's next turn; the deletion is of the checkout, not of the intent.

## Testing Strategy

**Unit.**

- The resolver, as a table: {`cwd` present / absent} × {`agentPath` present / from session metadata / absent} × {`home` / `managed` / `none` / unreadable manifest} → expected `{cwd, rung, degraded}`. Every row must be able to fail — the `explicit`-wins rows are the ones that catch a regression in the migration guarantee.
- Boundary validation applied to every rung, including a case where an agent's `home` path resolves outside the boundary and must be refused rather than used.
- Key derivation: two agents with the same slug in different directories produce different `key`s; the same agent produces the same `key` twice.
- `sweep` skips an agent-owned workspace and reports `reason: 'owned'` — with a seeded-drift variant proving the test fails if the exemption is removed.
- Manifest round-trip: a manifest with no `workspace` field reads as `{ mode: 'home' }` and survives a write-read cycle unchanged.

**Integration (server routes).**

- `FakeAgentRuntime` + `@dorkos/test-utils` scenarios: a turn with `cwd` runs in that cwd whatever the binding says; a turn with only `agentPath` runs in the agent's home; a turn with neither runs in `DEFAULT_CWD`.
- A `managed` binding provisions on the first turn and reuses on the second (`ensure` called twice, one workspace).
- Provisioning failure degrades to `DEFAULT_CWD` and returns 202, not 500.
- `workspaceKey` still overrides an agent binding.
- **The subagent invariant:** one resolver call across a turn containing a Task-tool sidechain.

**Migration / no-regression.** A fixture set of pre-change `agent.json` files and pre-change `workspaces` rows loads, resolves, and lists identically for every caller that supplies a `cwd`. This is the test that proves "must not break anyone's current setup".

**E2E (`apps/e2e`).** One flow: set an agent to a managed workspace, send a turn, assert the session-view workspace indicator names the checkout. Browser-verified per `.claude/rules/testing.md` — jsdom cannot see the indicator's real resolution.

**Mocking.** The resolver takes its manifest reader and workspace manager as injected collaborators, so no test touches git or the filesystem except the provider tests that already exist.

## Performance Considerations

Rung 1 costs nothing — the common cockpit path returns before reading anything. Rung 2 costs one `session_metadata` primary-key lookup (only when the request omits `agentPath`) plus one `agent.json` read, both on the turn-trigger path, which already does a manifest read for runtime resolution (`resolveRuntimeTypeForNewSession`, `sessions.ts`) — the two should share one read rather than doing two. Rung 2 in `managed` mode costs an `ensure`, which is a cache hit after the first turn.

No new hot-path work for any caller that supplies a `cwd`, which is every interactive turn.

## Security Considerations

- **Every resolved path is boundary-validated before it reaches a runtime**, on every rung. This is the invariant that makes storing the binding in `agent.json` acceptable: an agent that rewrites its own manifest still cannot resolve to a path outside `DORKOS_BOUNDARY`.
- `validateBoundaryOrDorkHome` is used only for the agent-home rung, matching its documented agent-registry carve-out (`lib/boundary.ts`); it is not widened to any raw file surface.
- The binding is a **coordination** default, not a containment boundary, and the spec states that plainly so it is never mistaken for one. Containment is `DORKOS_BOUNDARY` plus the capability tier gate, both unchanged.
- An agent-owned workspace is not a trust boundary either: an agent with a shell can still reach its peers' trees. What changes is that it no longer does so by accident.
- No new credential, token, or config surface. Nothing is added to `UserConfigSchema`, so no `config-write-policy` classification is required.

## Documentation

- `contributing/workspace-manager.md` — a "Who owns a workspace" section covering the `owner` field, the sweep exemption, and the resolver.
- `contributing/architecture.md` — the precedence chain, in the session/cwd discussion.
- `.claude/rules/agent-storage.md` — the new manifest field and its default.
- `docs/` user guide — "Give an agent its own folder" (writing-for-humans: plain enough for a smart 9th grader who does not code, no em dashes).
- A changelog fragment per PR in `changelog/unreleased/`.

## Implementation Phases

- **Phase 1 — the chain.** Manifest field + `owner` on the entity + `resolveSessionCwd` + the `sessions.ts` call site + `sweep` exemption + the rename in §3.8. Server-only; `home` mode works end-to-end. This phase alone fixes the diagnosed defect for every agent.
- **Phase 2 — the surface.** Agent Hub workspace control, owner column on `/workspaces`, the degradation warning on the turn.
- **Phase 3 — consolidation.** Move the task scheduler's `resolveEffectiveCwd` and the relay binding router's `cwd: projectPath` onto the shared resolver, so the concept has one implementation instead of three (see Open Questions).

## Open Questions

- **Does Phase 3 happen?** Both existing derivations already produce the right answer for `home` mode, so the refactor buys consistency, not correctness — but they will silently produce the _wrong_ answer for an agent in `managed` mode, which is a correctness argument after all. Leaning yes, in Phase 3, once Phase 1 has proven the resolver. **Unsettled.**
- **Concurrent sessions of the same agent still share one tree.** That is the reuse property working as designed (the research's finding 2: a workspace outlives any one session), not a bug in it — but it means this work reduces interference _between agents_ and not _between sessions_. If DOR-500's six writers were six sessions of one agent rather than six agents, this spec does not help them. The honest answer for that case is the resource lock, deliberately out of scope. **Stated, not solved.**
- **Should an agent be able to change its own binding through the MCP `update_agent` path?** Today it can, because the manifest is agent-writable and this is a manifest field. §3.1 argues that is acceptable because the binding is not a containment boundary. A reviewer who disagrees should say so before Phase 1 lands, because retrofitting an operator-only classification later means moving the field out of `agent.json`, which is a migration. **Deliberately surfaced for challenge.**
- **Does the Agent Hub control ship in Phase 2 or does `PATCH /api/agents` suffice for alpha?** Leaning ship it: a binding that can only be set through the API is a binding Kai will not discover.
- **What does `GET /api/sessions` say about an agent's workspace?** The session-view indicator resolves by path already, so nothing may be needed. Deferred to Phase 2.

## Related ADRs

- **ADR-0043** — file-first agent storage. Establishes why intent goes in `agent.json` and why the realization must not key on the ULID.
- **ADR-0283** — `WorkspaceProvider` hexagonal port. Unchanged; no new provider.
- **ADR-0284** — the server is the port authority. Unchanged; agent-owned workspaces allocate on the same terms.
- **ADR-0255** — per-session runtime binding, first-write-wins. The mechanism that makes `session_metadata.agent_path` a trustworthy identity source for rung 2.
- **ADR-0310** — runtime-owned session storage. Context for why cwd is the only binding seam available.

**Draft ADR candidates** (not written here — extraction touches `decisions/manifest.json`, a shared file this spec was scoped away from):

1. _An agent's working directory is a manifest field, not an operator-only config leaf_ — records the asymmetry with the agent-trust/standing-grants decision and the coordination-vs-containment line.
2. _Workspace ownership keys on `agentPath`, not the agent ULID_ — the DOR-446 precedent generalized.
3. _Session cwd resolves on a three-rung precedence chain_ — the durable statement of what `DEFAULT_CWD` is for.

## References

- `research/20260611_workspace_strategy_runtimes_symphony.md` — findings 2, 5, 6.
- `specs/workspace-manager/02-specification.md` — the entity and safety invariants inherited here.
- `specs/agent-approval-settings/01-ideation.md` §A — the `agent.json` rejection this spec deliberately diverges from.
- `packages/db/src/schema/agent-identity.ts` — the DOR-446 keying precedent, stated in full.
- `contributing/workspace-manager.md` — the shipped subsystem's key seams.
- DOR-500 — the interleaving measurement.
