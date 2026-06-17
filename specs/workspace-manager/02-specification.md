---
slug: workspace-manager
number: 259
created: 2026-06-16
status: specified
linearIssue: DOR-84
---

# WorkspaceManager — server-managed isolated workspaces bound to sessions via cwd

**Status:** Draft <!-- Draft | Under Review | Approved | Implemented -->
**Author:** /flow auto (operator: Dorian)
**Date:** 2026-06-16

## Overview

A first-class server subsystem that owns the lifecycle of **isolated
workspaces** — one per unit of work (issue id / spec slug) — and binds agent
sessions to them via the existing `SessionOpts.cwd`. It graduates the
operator-run `gtr` worktree flow into a server entity, adds **server-side
port-block allocation** (eliminating the hash-collision class), runs Symphony's
four lifecycle hooks, enforces conservative cleanup, and reserves a hostname
field for the v2 `.localhost` naming layer. It requires **zero changes to the
`AgentRuntime` interface** — binding is `session.cwd = workspace.path`.

## Background / Problem Statement

DorkOS can already drive parallel agent sessions, but isolation is handled by an
out-of-band shell flow (`gtr` + `.claude/scripts/worktree-setup.sh`) that:

- derives dev ports by hashing the branch name (`cksum % 150`), which collides as
  worktrees multiply (birthday paradox at ~7–8 worktrees), papered over by a
  linear-probe of peer `.env` files;
- lives entirely client-side, so nothing the server orchestrates (the `/flow`
  EXECUTE stage, a Pulse tick) can provision or reason about a workspace;
- has no entity, no persistence, no reconciliation, and no safety contract beyond
  the scripts themselves.

The research (`research/20260611_workspace_strategy_runtimes_symphony.md`)
establishes that the industry has converged on home-rooted, unit-of-work-keyed
workspaces populated by repo-owned hooks, that conservative cleanup is the #1
hard-won lesson (Claude Code #46444 and Cursor both shipped data-loss bugs), and
that **port isolation is an unsolved gap DorkOS can own** because DorkOS has a
persistent server and the competitors do not. The only missing Symphony component
is a WorkspaceManager.

## Goals

- A `Workspace` server entity persisted **file-first write-through** (ADR-0043):
  per-workspace manifest is source of truth, a SQLite `workspaces` table is a
  derived cache, a reconciler syncs them.
- A hexagonal `WorkspaceProvider` port with two v1 implementations: `worktree`
  (git-worktree from a local checkout) and `clone` (fresh clone).
- **Server-side contiguous port-block allocation** per workspace, injected via the
  **existing** env contract (`DORKOS_PORT`/`VITE_PORT`/`SITE_PORT`), with the
  hash-mod-150 derivation retained as an offline fallback.
- Symphony's four hooks (`after_create`/`before_run` fatal,
  `after_run`/`before_remove` logged-ignored; 60 s timeout; cwd = workspace),
  configured in a repo-owned versioned `.dork/workspace.json`.
- The four safety invariants, with **conservative cleanup** (never auto-remove a
  dirty workspace; `pinned` exempt).
- **Wire into the live session/flow path** (operator-confirmed, additive/opt-in):
  session creation accepts an optional `workspaceKey`; when present the server
  provisions/reuses the workspace, binds the session's `cwd`, and allocates +
  injects its port block. The `gtr`/`worktree-setup.sh` flow keeps working and now
  consults the server as the port authority (hash fallback when unreachable).
- An HTTP API + `Transport` methods.
- A **minimal interactive console UI**: a per-project/agent Workspaces view that
  shows each workspace and the sessions attached to it, and — the headline
  element — a **current-workspace indicator in the session view**.

## Non-Goals

- The `.localhost` subdomain naming layer / Portless integration (**DOR-91**, v2).
  v1 only **reserves** `hostname`/`url` on the entity.
- `container` and `remote` (SSH) providers — the interface admits them; out of v1.
- Multi-machine concurrency hardening (heartbeat, fencing token, `SKIP LOCKED`
  atomic multi-claim, stall-detector) — **DOR-89** server residue.
- **Integrating with, depending on, or replacing runtime-native worktree movement**
  (Claude Code's `EnterWorktree`/`ExitWorktree`). See "Runtime-native worktree
  tools — boundary & non-goals" below.

## Technical Dependencies

- `@dorkos/db` (Drizzle + better-sqlite3) — new `workspaces` table.
- `conf` v15.1.0 + Zod (`UserConfigSchema`) — new `workspace` config section.
- `apps/server/src/lib/dork-home.ts` — `resolveDorkHome()` (workspace root).
- `apps/server/src/lib/boundary.ts` — `validateBoundary`/`expandTilde` (path safety).
- `simple-git` / `git` CLI (already used) — worktree/clone operations.
- No new third-party libraries.

## Detailed Design

### Architecture changes

A new hexagonal port (`WorkspaceProvider`) and a `WorkspaceManager` service,
mirroring the `AgentRuntime` + `runtimeRegistry` idiom: interface in
`packages/shared`, implementations + service in `apps/server/src/services/workspace/`,
a singleton constructed at boot with late DB injection.

### Data model: the `Workspace` entity

`packages/shared/src/workspace.ts` (Zod schema + inferred type):

```ts
Workspace {
  id: string;                 // ULID
  projectKey: string;         // sanitized repo/project identifier, e.g. "core"
  key: string;                // sanitized unit-of-work key (issue id / spec slug), [A-Za-z0-9._-]
  path: string;               // absolute checkout dir, canonical, under workspace root
  source: string;             // origin repo path (worktree) or URL (clone)
  branch: string | null;      // e.g. "dork/<key>"
  provider: 'worktree' | 'clone';
  status: 'provisioning' | 'ready' | 'failed' | 'removing';
  portBase: number;           // first port of the allocated contiguous block
  portBlockSize: number;      // block size (default 10)
  hostname: string | null;    // RESERVED for v2 naming layer (DOR-91) — always null in v1
  url: string | null;         // RESERVED for v2 naming layer — always null in v1
  pinned: boolean;            // exempt from all automatic cleanup
  createdAt: string;          // ISO 8601
  lastUsedAt: string;         // ISO 8601
}
```

**The three named dev ports derive from the block by fixed offset** (Conductor
model): `DORKOS_PORT = portBase + 0`, `VITE_PORT = portBase + 1`,
`SITE_PORT = portBase + 2`. The remaining slots in the block are reserved for
future services. v1 ships `portBlockSize = 10`.

### Layout & the manifest name-clash resolution

- **Workspace checkout (directory):** `<root>/<projectKey>/<key>/` where
  `root = config.workspace.rootPath ?? <dorkHome>/workspaces`. This directory is
  the git worktree/clone. Matches the existing `.gtrconfig`
  `gtr.worktrees.dir = ~/.dork/workspaces/core`.
- **Entity manifest (file-first source of truth):** a **sidecar file** next to the
  checkout — `<root>/<projectKey>/<key>.workspace.json`. Deliberately a sibling
  _file_, never inside the checkout, so it can never be accidentally committed and
  never clashes with the repo-owned `.dork/workspace.json` (which lives inside the
  source repo). Resolves the ideation open question on the name clash.
- **Repo-owned hook config:** `.dork/workspace.json` in the **source repo**
  (committed), mirroring the `.dork/agent.json` precedent.

### `WorkspaceProvider` port interface

`packages/shared/src/workspace.ts`:

```ts
interface WorkspaceProvider {
  readonly type: 'worktree' | 'clone';
  create(req: WorkspaceCreateRequest): Promise<ProviderResult>; // provision the checkout
  remove(ws: Workspace, opts: { force: boolean }): Promise<void>; // delete the checkout
  isDirty(ws: Workspace): Promise<DirtyState>; // uncommitted/untracked/unpushed
}
```

- `worktree` — `git worktree add <path> -b dork/<key>` from `source` (an existing
  local checkout); fast shared object store; what gtr does today. `remove` =
  `git worktree remove` (+ optional branch delete). `isDirty` = `git status
--porcelain` + `git log @{upstream}..` (unpushed) + untracked check.
- `clone` — `git clone <source-url> <path>` then checkout `dork/<key>`. `remove` =
  `rm -rf` after the dirty check. `isDirty` = same git checks.

### `WorkspaceManager` service

`packages/shared/src/workspace.ts` interface; impl in
`apps/server/src/services/workspace/workspace-service.ts`:

```ts
interface WorkspaceManager {
  ensure(req: EnsureWorkspaceRequest): Promise<Workspace>; // reuse-or-create (idempotent on key)
  list(filter?: { projectKey?: string }): Promise<WorkspaceWithSessions[]>;
  get(id: string): Promise<Workspace | null>;
  resolveByPath(absPath: string): Promise<Workspace | null>; // cwd → workspace (powers the indicator)
  remove(id: string, opts: { force: boolean }): Promise<RemoveResult>; // dirty-refusal
  setPinned(id: string, pinned: boolean): Promise<Workspace>;
  sweep(): Promise<SweepResult>; // terminal-state + cap/age, all gated on the dirty check
}
```

`ensure()` is the heart of reuse semantics (validation criterion #2): keyed by
`(projectKey, key)`, it returns the existing `ready` workspace if present (touching
`lastUsedAt`), else provisions a new one: sanitize key → compute path → allocate
port block → write manifest (`provisioning`) → provider `create` → `after_create`
hook → patch workspace `.env` with the block → manifest+DB → `ready`.

### Port allocation

`apps/server/src/services/workspace/port-allocator.ts`:

- A pool starting at `config.workspace.portBase` (default `4250`), step =
  `portBlockSize` (default `10`). Workspace _n_ gets `portBase = base + n*size`.
- Allocation finds the **lowest free block** by reading allocated `portBase`s from
  the `workspaces` table (the DB cache is sufficient here; ties broken
  deterministically). No hashing, no probing — collisions are structurally
  impossible because each block is disjoint.
- The block is written into the workspace's `.env` as `DORKOS_PORT`/`VITE_PORT`/
  `SITE_PORT` (same patch logic `worktree-setup.sh` uses today), so dev servers
  the agent starts read them via turbo/dotenv. The session/runtime itself only
  needs `cwd`.
- **Offline fallback:** `worktree-setup.sh` gains a server-consultation step
  (`POST /api/workspaces/ports` with `{ path }` → returns a block); on any failure
  (server unreachable / non-200 / timeout) it falls back to the existing
  hash-mod-150 derivation unchanged. The server is the authority **when present**;
  the script never hard-depends on it.

### Hooks contract

Repo-owned `.dork/workspace.json` (Zod-validated):

```jsonc
{
  "provider": "worktree", // default provider for this repo
  "copy": [".env", ".mcp.json"], // files copied into a fresh checkout
  "hooks": {
    "after_create": ["pnpm install", ".claude/scripts/worktree-setup.sh"],
    "before_run": [],
    "after_run": [],
    "before_remove": [],
  },
}
```

Execution (`apps/server/src/services/workspace/hooks.ts`): each command run via
`sh -lc` with cwd = workspace path, **60 s** default timeout, env carrying the
allocated port block. `after_create` and `before_run` are **fatal** (failure aborts
provisioning / dispatch and marks the workspace `failed`); `after_run` and
`before_remove` are **logged-and-ignored**. Hook stdout/stderr is sanitized and
**truncated to 2 KB** before logging (Symphony §1.3).

### Safety invariants

1. **Session cwd MUST equal the workspace path** — validated at **bind time**
   (when the server sets `SessionOpts.cwd`). It is _not_ continuously enforced
   against a runtime that self-relocates (see the worktree boundary section).
2. **Workspace path MUST canonicalize inside the workspace root** — reuse
   `validateBoundary()` (realpath symlink resolution + `path.sep` prefix check +
   null-byte rejection). A path that expands inside-root but canonicalizes
   outside-root (symlink escape) is a distinct, rejected error.
3. **Keys sanitized to `[A-Za-z0-9._-]`**, all others → `_` (Symphony §9 / research).
4. **Never auto-remove a workspace with uncommitted changes, untracked files, or
   unpushed commits** — `remove`/`sweep` call the provider's `isDirty` and **refuse**
   (returning a structured "dirty, blocked" result) unless `force: true` is passed
   explicitly. `pinned` workspaces are exempt from `sweep` entirely.

### Session-binding wiring (the live-path change)

Additive and opt-in, so no existing session changes behavior:

- `SendMessageRequestSchema` / session-create input gains optional
  `workspaceKey?: string` and `provider?: 'worktree' | 'clone'`.
- In the session-create / `triggerTurn` path
  (`apps/server/src/routes/sessions.ts` → `services/session/trigger-turn.ts`): if
  `workspaceKey` is present, call `workspaceManager.ensure(...)`, then set the
  effective `cwd = workspace.path` (overriding any supplied `cwd`) and run
  `before_run`. If absent, the path is **byte-for-byte unchanged** (direct `cwd`
  still honored).
- The `/flow` EXECUTE stage (autonomous Pulse) provisions through
  `workspaceManager.ensure(...)` instead of an out-of-band `gtr` call, getting the
  port block for free. (Spec-level statement; the EXECUTE skill is harness prose,
  not code in this PR — the **wiring point in code** is the session path above.)

### Runtime-native worktree tools — boundary & non-goals

Claude Code's `EnterWorktree`/`ExitWorktree` let a session relocate its **own** cwd
mid-session (creating worktrees under in-repo `.claude/worktrees/`, or entering an
existing one by `path`). This is a **different actor and a different layer** from
the WorkspaceManager, and v1 deliberately does not integrate with it:

- **Distinct stores.** Managed workspaces live under `<dorkHome>/workspaces/…`;
  `EnterWorktree`'s default live in-repo under `.claude/worktrees/…`. No collision.
- **Hooks don't fire on runtime-native worktrees** (Claude bug #36205) → such a
  worktree gets no port block and no setup and is invisible to the manager. This is
  a core reason the manager must own provisioning, and a reason **never to build on
  runtime-native worktree tools** (research §3.2 finding #7, §4.6).
- **`EnterWorktree`'s `path` mode is empirically inconsistent with our
  `~/.dork/workspaces` worktrees** (DOR-121 field notes: sometimes enters,
  sometimes rejects with `.claude/worktrees does not exist`), so bridging is
  unreliable too.
- **Rule:** the WorkspaceManager _composes with_ but never _integrates or competes
  with_ runtime-native movement. A workspace-bound **orchestrated** session treats
  its bound cwd as authoritative and **must not** call `EnterWorktree` (it would
  silently break invariant #1 and escape the allocated ports/hooks). Disabling
  `EnterWorktree` via the runtime's disallowed-tools for orchestrated
  workspace-bound sessions is noted as a **hardening follow-up**, not built in v1.
  **Interactive harness sessions keep using `EnterWorktree`/gtr freely** — untouched.

### API changes

New routes (`apps/server/src/routes/workspaces.ts`), mounted under `/api/workspaces`:

| Method & path                       | Purpose                                                     |
| ----------------------------------- | ----------------------------------------------------------- |
| `GET /api/workspaces`               | List (opt `?projectKey=`), each with attached sessions      |
| `GET /api/workspaces/:id`           | Get one                                                     |
| `POST /api/workspaces`              | Ensure `{ projectKey, key, source, provider }`              |
| `DELETE /api/workspaces/:id`        | Remove (refuses if dirty unless `?force=true`)              |
| `POST /api/workspaces/:id/pin`      | Set/clear `pinned` (`{ pinned: boolean }`)                  |
| `GET /api/workspaces/resolve?path=` | Resolve a cwd → containing workspace (powers the indicator) |
| `POST /api/workspaces/ports`        | Allocate/return a port block for a path (script fallback)   |

`Transport` (`packages/shared/src/transport.ts`) gains the read+write verbs;
`HttpTransport` and `DirectTransport` implement them (the latter calls the service
in-process). "Attached sessions" = sessions whose resolved `cwd` is under
`workspace.path` (computed from session metadata; path-prefix match).

### Persistence & reconciliation

- **Drizzle table** `workspaces` (`packages/db/src/schema/workspace.ts`): columns
  mirror the entity (`id` PK, `projectKey`, `key`, `path` unique, `source`,
  `branch`, `provider`, `status`, `portBase`, `portBlockSize`, `hostname`, `url`,
  `pinned`, `createdAt`, `lastUsedAt`); a new Drizzle migration is generated.
- **Write-through** (ADR-0043): every mutation writes the sidecar manifest **first**
  (atomic temp+rename, à la `manifest.ts`), then upserts the DB row
  (`onConflictDoUpdate`). Removal deletes the manifest first, then the DB row.
- **Reconciler** (`workspace-reconciler.ts`), started at boot on the existing 5-min
  cadence: for each DB row, if the checkout dir is gone → mark `failed`/remove the
  stale row; if the manifest differs from the row → sync manifest → DB. Never
  deletes a checkout (cleanup is `sweep()`'s job, dirty-gated).

### Config schema additions

New `workspace` section in `UserConfigSchema`
(`packages/shared/src/config-schema.ts`):

```ts
workspace: z.object({
  enabled: z.boolean().default(true),
  rootPath: z.string().nullable().default(null),       // null → <dorkHome>/workspaces
  portBase: z.number().int().min(1024).max(65535).default(4250),
  portBlockSize: z.number().int().min(3).max(100).default(10),
  defaultProvider: z.enum(['worktree', 'clone']).default('worktree'),
  retentionCap: z.number().int().min(0).nullable().default(null), // null → no cap
}).default(() => ({ ... }))
```

A semver-keyed config migration is added per the `adding-config-fields` skill (the
section is additive with defaults, but a backfill migration keeps `conf`'s tracked
version honest).

### Code structure & file organization

```
packages/shared/src/workspace.ts                 # entity + provider + manager interfaces + Zod
packages/db/src/schema/workspace.ts              # Drizzle table (+ generated migration)
apps/server/src/services/workspace/
  ├── workspace-service.ts                        # WorkspaceManager impl
  ├── providers/worktree.ts                       # WorkspaceProvider: worktree
  ├── providers/clone.ts                          # WorkspaceProvider: clone
  ├── port-allocator.ts                           # contiguous-block allocation
  ├── hooks.ts                                     # Symphony 4-hook executor
  ├── workspace-store.ts                           # file-first manifest + DB cache
  ├── workspace-reconciler.ts                      # 5-min sync
  └── index.ts                                     # singleton export
apps/server/src/routes/workspaces.ts             # HTTP API
apps/server/src/index.ts                          # bootstrap + register + reconciler start (touched)
apps/server/src/routes/sessions.ts                # opt-in workspaceKey binding (touched)
apps/server/src/services/session/trigger-turn.ts  # ensure+bind cwd (touched)
.claude/scripts/worktree-setup.sh                 # server-consult + hash fallback (touched)
packages/shared/src/transport.ts                  # workspace verbs (touched)
apps/client/src/layers/shared/lib/transport/*     # HTTP + Direct adapters (touched)
apps/client/src/layers/entities/workspace/        # model, query hooks, WorkspaceBadge
apps/client/src/layers/features/workspace-*/       # pin/remove/create actions
apps/client/src/layers/widgets/workspaces-view/    # per-project list + attached sessions
# session-view indicator: consumed in the existing session widget
```

## User Experience

Three surfaces, all minimal-interactive:

1. **Current-workspace indicator (headline).** In the session view, a compact
   badge shows the workspace the session is bound to — `key` + project, with
   provider and port block on hover; clicking opens that workspace in the
   Workspaces view. Resolved via `GET /api/workspaces/resolve?path=<session.cwd>`.
   When the session's cwd is not a managed workspace, the badge reads "main
   checkout" (honest, not hidden).
2. **Workspaces view (`/workspaces`), grouped per project/agent.** Each row: `key`,
   provider, status, allocated port block, `pinned`/dirty state, and the **list of
   attached sessions** (each linking to its session view). Actions: pin/unpin,
   remove (the dirty-refusal surfaces as a confirm-with-explicit-force dialog —
   never a silent destroy).
3. **Empty/error states.** No workspaces → an explanatory empty state. Provider
   failure → the `failed` status with the truncated hook error.

The exact component visuals are designed in a dedicated **visual-companion
(`/design-sync`) pass** before implementation (see Implementation Phases).

## Testing Strategy

The three DOR-84 validation criteria become acceptance tests:

- **Unit:** `port-allocator` (lowest-free-block, disjointness, exhaustion); key
  sanitization; `validateBoundary` integration for path safety; hook executor
  (fatal vs logged-ignored, 60 s timeout, 2 KB truncation); dirty-state parsing.
- **Integration (`workspace-service`):**
  - **VC#1 — no collisions:** `ensure` two distinct keys → two distinct paths and
    two **disjoint** port blocks; concurrent `ensure` calls never overlap.
  - **VC#2 — survival/reuse:** `ensure` the **same** key twice → the **same**
    workspace id and path (reuse, `lastUsedAt` bumped), across simulated sessions/
    attempts.
  - **VC#3 — dirty refusal:** `remove`/`sweep` on a workspace with uncommitted /
    untracked / unpushed changes **refuses**; succeeds only with `force: true`;
    `pinned` is skipped by `sweep`.
  - Session binding: `workspaceKey` present → `cwd` overridden to `workspace.path`
    - ports injected; absent → unchanged path.
  - Write-through: manifest written before DB; reconciler syncs a hand-edited
    manifest; a removed checkout dir is reconciled.
- **Client:** `entities/workspace` query hooks (mock `Transport`); `WorkspaceBadge`
  resolves + renders the bound workspace and the "main checkout" fallback;
  `workspaces-view` lists workspaces with attached sessions; pin/remove actions
  call the transport; dirty-remove shows the force-confirm dialog.
- **Mocking:** git operations behind the provider interface are faked in
  integration tests (a temp git repo fixture for the real-git paths); `Transport`
  mocked client-side per `.claude/rules/testing.md`.

Each test carries a purpose comment and a failable assertion (no always-green
tests).

## Performance Considerations

Provisioning cost is dominated by the provider (git worktree add ≈ cheap; clone ≈
network-bound) and the `after_create` hook (`pnpm install`), both already paid by
the current gtr flow. Port allocation is an in-memory/DB scan over a small set.
The reconciler reuses the existing 5-min unref'd timer. No hot-path impact: the
session send-message path adds a single `ensure` lookup only when `workspaceKey`
is supplied.

## Security Considerations

- **Path traversal / symlink escape:** every workspace path passes
  `validateBoundary` against the workspace root before any filesystem write.
- **Hook execution is arbitrary code** from the **repo-owned, version-controlled**
  `.dork/workspace.json` — same trust model as `.gtrconfig` postCreate hooks today
  (committed, reviewed). Hooks run with cwd = workspace and a bounded timeout;
  output is truncated before logging (no secret-bleed via huge logs).
- **Destructive operations are dirty-gated** and require explicit `force` — the
  invariant that prevents the Claude Code/Cursor data-loss class.
- Route inputs are Zod-validated; `force` is never inferred.

## Documentation

- `contributing/` guide for the WorkspaceManager (entity, providers, hooks,
  port allocation, the session-binding seam).
- Update `contributing/development-workflow.md` / the worktree memory to note the
  server is now the port authority (hash = fallback).
- `/api/docs` picks up the new routes automatically.

## Implementation Phases

- **Phase 1 — core service (server, no UI):** entity + Zod, Drizzle table +
  migration, `workspace-store` (file-first + cache), both providers,
  `port-allocator`, `hooks`, `workspace-service`, `workspace-reconciler`, bootstrap
  registration. Unit + integration tests for the 3 validation criteria. _(This
  alone satisfies DOR-84's acceptance.)_
- **Phase 2 — API + wiring:** `/api/workspaces` routes, `Transport` verbs + both
  adapters, opt-in `workspaceKey` session binding, `worktree-setup.sh`
  server-consult + fallback.
- **Phase 3 — UI:** the **visual-companion (`/design-sync`) design pass** for the
  components, then `entities/workspace` + `WorkspaceBadge` (the session-view
  indicator), the `/workspaces` widget (per-project list + attached sessions), and
  the pin/remove features. Client tests.

## Open Questions

- ~~Entity-manifest vs repo-hook-config name clash~~ **(RESOLVED:** entity manifest
  is a sidecar `<key>.workspace.json` next to the checkout dir; repo hook config is
  `.dork/workspace.json` inside the source repo.**)**
- ~~`projectKey` identity~~ **(RESOLVED:** sanitized repo dir name (`core`) for v1;
  `<name>-<shortRootSha>` is a non-breaking upgrade since the key is opaque.**)**
- Should `.dork/workspace.json` eventually subsume `.gtrconfig`, or should the
  worktree provider translate one into the other? (Deferred — v1 reads
  `.dork/workspace.json`; `.gtrconfig` continues to drive interactive gtr.)
- Exact placement of the Workspaces view (dedicated `/workspaces` route vs a tab in
  `/agents`) — finalized in the visual-companion pass.

## Related ADRs

Two ADRs to be drafted (DECOMPOSE → `/adr:from-spec`):

1. **`WorkspaceProvider` — a hexagonal port for isolated workspaces** (the new
   interface; why it mirrors `AgentRuntime`/`Transport`; why binding is `cwd`).
2. **The DorkOS server is the port authority** (contiguous block allocation
   replaces branch-name hashing; gtr hash is the offline fallback).

Builds on **ADR-0043** (file-canonical source of truth) — referenced, not
re-decided.

## References

- `research/20260611_workspace_strategy_runtimes_symphony.md` (§1 Symphony, §2
  industry survey, §3 the DorkOS architecture, §4 near-term compatibility, §5
  naming layer).
- DOR-84 (this), DOR-85 (ports, folded in), DOR-91 (v2 naming, blocked by this),
  DOR-88 (Flow server edition, blocked by this), DOR-89 (server residue).
- `packages/shared/src/agent-runtime.ts` (the `cwd` seam), `runtime-registry.ts`
  (registry idiom), `manifest.ts` + `agent-registry.ts` + `reconciler.ts`
  (ADR-0043 pattern), `lib/boundary.ts` (path safety), `.gtrconfig` +
  `.claude/scripts/worktree-setup.sh` (the gtr/port flow being graduated).
- Claude Code worktree bug #36205 (hooks don't fire), #46444 (cleanup data loss);
  Cursor data-loss incidents (research §Key Findings #5).
