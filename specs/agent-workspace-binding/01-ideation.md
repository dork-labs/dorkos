---
slug: agent-workspace-binding
id: 260726-162520
created: 2026-07-26
status: implemented
---

# Agent workspace binding: an agent should know where it works

**Author:** Claude (directed by Dorian)
**Date:** 2026-07-26
**Tracker:** [DOR-1589](https://linear.app/dorkspace/issue/DOR-1589), [DOR-1590](https://linear.app/dorkspace/issue/DOR-1590)
**Project:** Agents as First-Class Operators

**Code references are anchored by file and symbol, not by line (corrected 2026-08-29, DOR-1602).**
See the same note in `02-specification.md` for why.

## The problem

An agent in DorkOS has a name, a persona, traits, a runtime, a colour, an icon, a namespace, a tier ceiling, and a set of tool groups. It does not have a place to work.

`AgentManifestSchema` (`packages/shared/src/mesh-schemas.ts`) carries seventeen fields. None of them is a working directory. `SessionOpts.cwd` is optional (`packages/shared/src/agent-runtime.ts`), and when it is absent every runtime falls through to the same constant:

```ts
export const DEFAULT_CWD: string = env.DORKOS_DEFAULT_CWD ?? path.resolve(thisDir, '../../../');
```

— `apps/server/src/lib/resolve-root.ts`. One value, process-wide, for every agent. claude-code takes it in its constructor (`claude-code-runtime.ts`), codex as `defaultCwd` (`codex-runtime.ts`), opencode at the end of its per-turn chain (`opencode-runtime.ts`). So an agent that does not name a directory works in whatever directory the server happens to consider default — which is the same directory every other such agent works in.

The measurement (DOR-500) ran six concurrent agents in one tree and observed pervasive fine-grained interleaving of writes. Splitting them across two trees roughly doubled write survival. The defect is not that a default exists. It is that the default is **global**.

### What is actually in the tree

Verified against `5a84de271` on `main`. Three findings sharpen the framing, and one contradicts it.

**1. Agents already have a stable directory identity — it just is not on the manifest.** Every registered agent has a `projectPath`, and the column is `.notNull().unique()` (`packages/db/src/schema/mesh.ts`): two agents can never be registered at the same directory. It is absent from `AgentManifestSchema` because the manifest is _located at_ that path — `.dork/agent.json` is self-locating. `MeshCore.getProjectPath(agentId)` (`packages/mesh/src/mesh-core.ts`) exposes it.

**2. Two dispatch paths already resolve cwd from that identity. The interactive one does not.**

- Tasks: `resolveEffectiveCwd` (`apps/server/src/services/tasks/task-scheduler-service.ts`) resolves an agent-linked task's cwd to `meshCore.getProjectPath(task.agentId)` and throws if the agent is gone.
- Relay bindings: `binding-router.ts` looks up the same `projectPath` and stamps it onto the dispatch payload as `cwd`.
- The cockpit does the reverse. `useCurrentAgent(selectedCwd)` (`apps/client/src/layers/entities/agent/model/use-current-agent.ts`) derives _the agent_ from _the directory_, and `useDefaultCwd` seeds `selectedCwd` from `GET /api/directory/default` when nothing is chosen (`use-default-cwd.ts`). In the cockpit, "which agent" and "which folder" are the same choice, and when the user has not made it, the answer is `DEFAULT_CWD` for everyone.

So the missing piece is not the concept. It is that the concept is re-derived, differently, in each of three places, and absent in the fourth.

**3. `session_metadata.agent_path` is written on every session and read by nothing.** The column exists (`packages/db/src/schema/sessions.ts`), `persistSessionRuntime` writes it first-write-wins (`apps/server/src/services/core/runtime-registry.ts`), and `SendMessageRequestSchema` documents it as recorded "for provenance" (`packages/shared/src/schemas.ts`). A grep for readers returns none. The seam this work needs is already there, already persisted, already immutable — it has just never had a consumer.

**4. The contradiction: `createAgentWorkspace` already exists and means something else.** `apps/server/src/services/core/agent-creator.ts` is named `createAgentWorkspace`, its module doc opens "Agent workspace creation service", and what it does is scaffold `.dork/agent.json`, SOUL.md, and NOPE.md into a directory. In this codebase "agent workspace" today means _the agent's home folder_, not a `Workspace` entity. Shipping a feature called "agent workspace" without settling that leaves two meanings of one term in one server. That is the tolerated-legacy rot AGENTS.md forbids, and it has to be resolved by this work, not after it.

### What WorkspaceManager already gives us

`WorkspaceManager` shipped (DOR-84; ADRs 0283, 0284): a `Workspace` entity, a `WorkspaceProvider` port with `worktree` and `clone`, file-first persistence with a sidecar manifest as truth, collision-free contiguous port-block allocation, Symphony's four hooks, dirty-gated cleanup, `/api/workspaces`, a `/workspaces` page, and a session-view indicator. Binding to a session is already just `cwd = workspace.path` — no `AgentRuntime` change, by design.

Its opt-in entry point is `workspaceKey` on `POST /api/sessions/:id/messages` (`apps/server/src/routes/sessions.ts`). **Nothing in the client passes it.** A grep for `workspaceKey` across `apps/client/src` returns zero hits; the only production caller of `getWorkspaceManager().ensure` outside the workspaces route is that one block. The subsystem is built, wired, and unreachable from the cockpit. Agent binding would be its first real consumer.

Two loose ends found while reading it, both relevant here:

- **`WorkspaceService.sweep()` has no caller.** No route, no cron, no `Transport` method. And as written it removes _every_ non-pinned, non-dirty workspace (`workspace-service.ts`) — the `retentionCap` config field is threaded through `WorkspaceServiceConfig` (`workspace-service.ts`) and never read. So the cap does nothing and the sweep would be indiscriminate the day someone calls it.
- **`ensure` always writes a `.env`.** `writePortEnv` (`port-env.ts`) upserts `DORKOS_PORT`/`VITE_PORT`/`SITE_PORT` into `<workspace>/.env` unconditionally, and `create` always cuts a branch named `dork/<key>`. Both are right for a unit-of-work checkout of a dev repo. Both need a verdict when the workspace is an agent's long-lived home.

## What we are deciding

1. Where the binding lives, given that `agent.json` is truth and the SQLite cache is rebuildable under fresh ULIDs.
2. When an agent's workspace is created, what happens when the agent is deleted, and whether it is reused across sessions.
3. Which agents get one, what the default is, and whether `isSystem` agents differ.
4. How a subagent relates to its parent's workspace.
5. What happens to every agent that exists today.
6. What `DEFAULT_CWD` keeps doing.
7. Whether an agent-owned workspace gets a port block, and what the ceiling is.

## Options considered

### A. Where does the binding live?

**A1. A column on the `workspaces` table keyed by `agentPath`, with nothing on the manifest.** Rejected as the _whole_ answer, kept as half of it. Keying on `agentPath` is right and there is a precedent to follow exactly: DOR-446 put identity tokens in their own table keyed on `agentPath` rather than the agent ULID, and the schema doc explains why in terms that apply verbatim here — the `agents` table "is a DERIVED cache (ADR-0043)… the mesh reconciler is licensed to delete the table and rebuild it from files, re-registering every agent under a fresh ULID" (`packages/db/src/schema/agent-identity.ts`). A binding keyed on the ULID dies at the next rebuild. `agentPath` survives it.

What A1 cannot express is _intent_. A row in `workspaces` says a workspace was provisioned. It cannot say "this agent should work in its own directory and does not need a checkout", because there is no row for that case. Storing intent only as the presence of a provisioned artefact means you cannot ask for one before it exists, and you cannot say no.

**A2. A field on `AgentManifestSchema`, with nothing in the workspaces table.** Rejected for the mirror reason. The manifest is user-owned config and the right home for a preference, next to persona, traits, and `enabledToolGroups`. But a provisioned checkout has a path, a branch, a port block, a dirty state, and a status — that is operational state, and the agent-trust spec already settled that shape of question: "approvals are operational state like tasks runs, not identity like `agent.json`" (`specs/agent-trust/02-specification.md:99`).

**A3. Intent on the manifest, realization in the workspaces table keyed on `agentPath`.** Chosen. `agent.json` answers "where should this agent work?"; the `workspaces` row answers "and here is the checkout that got made for it." The split is the same one the codebase already draws between a Task's definition and its runs.

**The security objection, and why it does not land the way it did for trust.** The agent-approval-settings spec rejected `agent.json` for standing grants because an agent with a Write tool edits its own manifest and the reconciler makes the file win within five minutes — a self-granted escalation with no integrity check. That reasoning is sound and it is worth asking whether it applies to a working directory.

It does not, and the reason is that a working directory is not a containment boundary. An agent that can write files can already write anywhere inside `DORKOS_BOUNDARY` today, with or without editing its manifest; moving its own cwd buys it nothing it did not already have. Containment is `DORKOS_BOUNDARY` plus the tier gate, and both stay exactly where they are — every resolved path still passes `validateBoundary` before use. **This is a judgement call and it should be stated as one:** the binding is a _coordination_ default, not a security control, and the spec says so out loud so nobody later mistakes it for one. The invariant that keeps it honest is that a binding can never widen reach beyond the boundary, which is enforced by validation at resolution, not by who wrote the field.

### B. What are the modes?

The question underneath the framing is whether "the agent's own workspace" means a directory or a checkout. It has to mean both, because DorkBot lives at `~/.dork/agents/dorkbot/`, which is not a git repository, and `git worktree add` against it fails.

**B1. One mode: every bound agent gets a managed `Workspace`.** Rejected. It forces provisioning on agents that need a folder, not a checkout, and it fails outright for every agent whose home is not a git repo — which includes the system agent and every marketplace-installed agent under `{dorkHome}/agents/*`.

**B2. One mode: every bound agent works in its own `agentPath`.** Rejected as the whole answer. It fixes the shared-`DEFAULT_CWD` defect for free, with no provisioning, no git, and no ports — and for a large fraction of agents it is the correct and complete answer. What it does not fix is the case the measurement actually exercised: several agents working the same repository. Their homes would be different directories only if they were registered at different directories, and `projectPath` being unique means at most one agent can be registered at the repo root.

**B3. Three modes: `home`, `managed`, `none`.** Chosen.

- `home` — the agent works in its own directory (`agentPath`). No entity, no provisioning, no ports, no git requirement.
- `managed` — the server `ensure`s a `Workspace` from a named source repo and the agent works in the checkout. This is the mode that solves N-agents-one-repo.
- `none` — no binding; fall through to `DEFAULT_CWD`. Explicitly available so "share the default" stays sayable rather than being only the accident of an unset field.

Three modes is more than two and each has to earn its place. `home` earns it by covering non-repo agents at zero cost. `managed` earns it by being the only mode that gives two agents on one repo two trees. `none` earns it by making today's behavior an explicit, choosable state rather than a hole.

### C. When is a workspace created?

**C1. At agent creation.** Rejected. At creation time the source repo is frequently unknown (`createAgentWorkspace` is called from the HTTP route, the MCP tool, and the marketplace install flow), and it charges every agent — including chat-only and research agents — a `git worktree add` it may never use.

**C2. Lazily, at the first turn that resolves to `managed`.** Chosen. `WorkspaceService.ensure` is already idempotent reuse-or-create on `(projectKey, key)`, which is exactly the semantics wanted, and it is already how `workspaceKey` behaves at `sessions.ts`. An eager "Provision now" action in the Agent Hub is the _same call_, triggered by a button, not a second code path.

**C3. On agent deletion, remove the workspace.** Rejected. Research finding 5 of `20260611_workspace_strategy_runtimes_symphony.md` is unambiguous: cleanup is the industry's biggest failure mode, with documented data-loss incidents in both Claude Code (#46444, ten days of uncommitted work) and Cursor. Unregistering an agent is not a statement about the code in its tree. Deletion clears the ownership and leaves the workspace listed on `/workspaces`, where the existing dirty-gated `DELETE` already asks the right question. The hook to attach to exists: `meshCore.onUnregister((agentId, projectPath) => …)` (`apps/server/src/index.ts`).

Reuse across sessions is yes, and it is the point: the research's second finding is that a workspace outlives any one session. Every session of an agent shares that agent's tree.

### D. Which agents get one, and what is the default?

`isSystem` agents (DorkBot) cannot be renamed, deleted, or unregistered — enforced at routes, MCP tools, and the client UI. That protection is about identity, and a working directory is not identity, so the mode stays editable for DorkBot like any other agent. Its default lands on `home`, which is the mode that needs no git and therefore the only one that works at `{dorkHome}/agents/dorkbot/` without special-casing.

Default for a manifest with no `workspace` field: `home`. **But the rung only applies to a turn that names an agent.** That containment is what makes the default safe, and it is the crux of the migration answer below.

### E. Do subagents inherit?

There is no option here, only an invariant to write down and a test to prevent its erosion. A claude-code subagent is an SDK sidechain inside the parent's `query` — it inherits the parent process's cwd by construction (`transcript-parser.ts`, `message-event-mapper.ts` handle its output; nothing re-enters session creation). Codex and opencode behave the same way. The binding must therefore resolve **once per turn, at the session boundary**, and nothing inside a turn may call the resolver again.

The reason this is the distinction that makes the model coherent: a subagent is _the same agent doing the same task_, so it stays in one tree. A peer agent reached over Relay or Mesh is _a different agent_, so it gets its own session with its own `agentPath` and resolves its own binding. Delegation down stays put; delegation across moves. Without that contrast, "one workspace per agent" reads as "one workspace per unit of concurrency", which is neither true nor achievable.

### F. What happens to agents that exist today?

**F1. Backfill every manifest with an explicit mode.** Rejected. It is a write to every user's `agent.json` for a field whose default already says the right thing, and file-first write-through means the Zod default is persisted the next time anything legitimately writes the manifest anyway.

**F2. Default to `none` so nothing changes.** Rejected as too timid. It would ship the field and leave the defect in place for everyone who does not go and turn it on, which is everyone.

**F3. Default to `home`, gated on the turn naming an agent.** Chosen. Trace the blast radius honestly:

- Cockpit turns always carry `cwd` (`selectedCwd`) → rung 1 wins → unchanged.
- Agent-linked tasks already resolve to `projectPath` → same answer → unchanged.
- Relay-bound turns already stamp `cwd: projectPath` → same answer → unchanged.
- A turn with an explicit `agentPath` and no `cwd` → **moves** from `DEFAULT_CWD` to the agent's directory. This is the change, and it is the fix: the caller named the agent, so the agent's directory is what it asked for.
- A turn with neither a `cwd` nor an agent — external MCP callers with no meaningful path, test-mode and e2e sessions, a bare API POST → falls to rung 3, `DEFAULT_CWD`, unchanged.

Existing `workspaces` rows are untouched: the ownership field is nullable and absent means "unit of work", which is today's semantics.

### G. Ports

An agent in `home` mode gets no `Workspace` and therefore no port block. An agent in `managed` mode gets a real workspace, so it gets a block on the same terms as any other — the server is the port authority (ADR-0284) and blocks never overlap by construction.

The ceiling is not the interesting number. With the shipped defaults (`portBase` 4250, `portBlockSize` 10, ceiling 65535) the pool holds about 6,128 blocks. The binding constraint on how many agents can own checkouts is disk and git worktrees, not ports. What _does_ need a verdict is the failure mode: `lowestFreeBlock` throws on exhaustion (`port-allocator.ts`), `ensure` catches it and marks the workspace `failed`, and the session path must degrade to rung 3 with a visible warning rather than failing the turn — matching the existing `try`/`catch` at `sessions.ts`, which logs and proceeds.

The trap that must be closed structurally: today `sweep()` would delete an agent's workspace, because it removes everything not pinned and not dirty. Requiring agent workspaces to be `pinned: true` by convention is the fragile fix. Making `sweep` skip agent-owned workspaces because the row _says_ it is agent-owned is the durable one, and the ownership field this spec adds is what makes it sayable.

## The shape that wins

One optional field on the agent manifest, one nullable ownership field on the workspace entity, and one resolver.

```ts
// AgentManifestSchema, new optional field
workspace:
  | { mode: 'home' }                                                  // default when absent
  | { mode: 'managed'; source: string; provider?: 'worktree'|'clone' }
  | { mode: 'none' }
```

**The precedence chain**, resolved once per turn, at the session boundary, in `POST /api/sessions/:id/messages`:

1. an explicit `cwd` on the request;
2. the binding of the agent this turn names (`agentPath` on the request, else `session_metadata.agent_path` — this spec is that column's first reader);
3. `DEFAULT_CWD`.

Every resolved value is boundary-validated before it reaches a runtime. Every rung is observable: the turn logs which rung answered and why.

**What `DEFAULT_CWD` keeps doing, unchanged.** It stays the directory browser's start point (`GET /api/directory/default`, `routes/directory.ts`), it stays boundary-clamped by the CLI for the reason its comment gives (`directory.ts`), and it stays the MCP fallback for an external caller with no meaningful path (`session?.cwd ?? deps.defaultCwd`, `mcp-tools/index.ts`). It is not deprecated and it is not a lazy fallback. It moves from being rung 1 for everything to being rung 3 for callers who genuinely have no better answer, which is what it was always for.

**The terminology fix.** `createAgentWorkspace` is renamed to `scaffoldAgentHome` so "agent workspace" has exactly one meaning after this ships. Three call sites (`routes/agents.ts`, `apps/server/src/index.ts`, `marketplace/flows/install-agent.ts`) plus its own module.

## What this does not fix, stated plainly

Agent-owned workspaces reduce interference **between agents**. They do nothing about interference **between concurrent sessions of the same agent**, which all share that agent's tree by design — that is the reuse property, not a bug in it. If the six concurrent writers in the DOR-500 measurement were six sessions of one agent rather than six agents, this work does not help them, and the honest next step for that case is the resource lock, which is deliberately out of scope here.

## Open questions carried into the specification

- Whether `managed` mode should suppress `writePortEnv` and the `dork/<key>` branch for an agent-owned checkout, or accept both as-is. Leaning accept: an agent-owned checkout of a source repo is the same kind of object as a unit-of-work checkout, and suppressing the `.env` would fork a code path to remove a file that is harmless where it lands.
- Whether the Agent Hub gets a workspace tab in this round or the mode is only settable through `PATCH /api/agents`.
- Whether `resolveEffectiveCwd` in the task scheduler and the `cwd: projectPath` stamp in the relay binding router should be refactored to call the shared resolver, or left alone because they already produce the right answer. Leaning refactor, on the "three re-derivations of one concept" argument.
- What `/api/sessions` list surfaces about an agent's workspace, given the session-view indicator already resolves by path.

## References

- `research/20260611_workspace_strategy_runtimes_symphony.md` — findings 2 (workspace is the unit of work, not the session), 5 (cleanup is the #1 failure mode), 6 (port isolation is DorkOS's to own).
- `specs/workspace-manager/02-specification.md` — the entity, the provider port, the safety invariants this work inherits.
- `packages/db/src/schema/agent-identity.ts` — the DOR-446 precedent for keying on `agentPath` instead of the ULID.
- `specs/agent-approval-settings/01-ideation.md` §A — why `agent.json` was rejected for trust, and the line this spec draws differently.
- `.claude/rules/agent-storage.md` — file-first write-through and reconciler behavior.
