---
slug: workspace-manager
number: 259
created: 2026-06-16
status: ideation
linearIssue: DOR-84
---

# WorkspaceManager — server-managed isolated workspaces bound to sessions via cwd

**Slug:** workspace-manager
**Author:** /flow auto (operator: Dorian)
**Date:** 2026-06-16

---

## 1) Intent & Assumptions

- **Task brief (DOR-84 hypothesis):** If DorkOS manages isolated workspaces (one
  per unit of work, bound to sessions via the existing `SessionOpts.cwd`), users
  can run parallel agent sessions across any runtime without file collisions —
  with **zero changes to the `AgentRuntime` interface**. This graduates the
  current operator-run `gtr` worktree flow into a first-class server entity, adds
  server-side port-block allocation (DOR-85, folded in), and reserves a hostname
  field so the v2 `.localhost` naming layer (DOR-91) joins without migration.

- **Assumptions (logged for the review gate — calibration ladder trail):**
  1. **Scope (operator-confirmed, 2026-06-16):** v1 reaches **all the way into the
     live session/flow path** — not just a standalone service. The wiring is built
     **additive and opt-in**: the existing `gtr`/`worktree-setup.sh` flow keeps
     working unchanged, and the server becomes the _port authority_ with the
     hash-mod-150 derivation retained as a fallback when the server is unreachable.
     No existing session breaks.
  2. **`projectKey` = sanitized repo directory name** (`core`), matching the
     existing `~/.dork/workspaces/core/` gtr layout. Collision-proofing to
     `<name>-<shortRootSha>` is noted as a non-breaking upgrade (the key is
     opaque to consumers). _Assumption — not separately confirmed._
  3. **Port contract is preserved:** the server allocates a contiguous block and
     injects the **existing** env names (`DORKOS_PORT`, `VITE_PORT`, `SITE_PORT`),
     so no app's env-reading changes. _Assumption — not separately confirmed._
  4. **Plan-approval checkpoint:** because wiring touches the live dispatch path
     (a material-scope change → calibration floor trigger), the decomposed plan
     gets one explicit go/no-go before any code, even though `gates.planApproval`
     is `false` by default.

- **Out of scope (v2 / deferred):**
  - The `.localhost` subdomain naming layer / Portless integration (DOR-91). v1
    only **reserves** a `hostname`/`url` field on the entity.
  - `container` and `remote` (SSH) providers — the interface admits them; v1 ships
    `worktree` + `clone` only.
  - Concurrency hardening for a multi-machine server (heartbeat, fencing token,
    `SKIP LOCKED` atomic multi-claim) — that is DOR-89 server residue.
  - A dedicated console UI for workspaces (research §Open Questions). v1 exposes
    the HTTP API + Transport methods; surfacing in the console is a follow-up.

## 2) Pre-reading Log

- `research/20260611_workspace_strategy_runtimes_symphony.md` — the authoritative
  source. §3.2 is effectively the architecture; §1.2 is the Symphony workspace
  model (hooks + safety invariants); §5 is the naming-layer assessment (verdict:
  ship port blocks only, design for a `url` field). Key lessons: home-rooted
  layout (6/7 tools), unit-of-work keying (not per-session), conservative cleanup
  (CC #46444 / Cursor data-loss incidents), ports are an unsolved gap DorkOS can
  own (only Conductor solves it).
- `packages/shared/src/agent-runtime.ts:174-203` — `SessionOpts.cwd?` and
  `MessageOpts.cwd?` **already exist**. Binding is `session.cwd = workspace.path`;
  **no interface change required** (confirms the hypothesis).
- `apps/server/src/services/core/runtime-registry.ts:62-338` — the singleton
  registry + late-DB-injection idiom (`setDb(db)`) the WorkspaceManager mirrors.
- ADR-0043 + `packages/shared/src/manifest.ts` + `packages/mesh/src/agent-registry.ts`
  - `packages/mesh/src/reconciler.ts` — the file-first write-through pattern
    (atomic temp+rename write, `onConflictDoUpdate` cache, 300_000 ms reconciler)
    the `Workspace` entity copies.
- `apps/server/src/lib/boundary.ts:63-132` — `validateBoundary` / `expandTilde` /
  `isWithinBoundary`: realpath symlink resolution + canonical-prefix check with
  `path.sep` + null-byte rejection. This **is** safety invariants #2/#3 — reuse it.
- `.gtrconfig` + `.claude/scripts/worktree-setup.sh:37-82` — the current
  hash-mod-150 port derivation (DORKOS_PORT 4250-4399, VITE_PORT 4400-4549,
  SITE_PORT 4550-4699) + linear-probe collision avoidance. This is what
  server-side block allocation replaces.
- `apps/server/src/lib/dork-home.ts` — `resolveDorkHome()`; `os.homedir()` banned
  (`.claude/rules/dork-home.md`). Workspace root = `<dorkHome>/workspaces/`.

## 3) Codebase Map

- **Primary components/modules (new + touched):**
  - `packages/shared/src/workspace.ts` (new) — `Workspace` entity + `WorkspaceProvider`
    port interface + `WorkspaceManager` interface + Zod schemas. (hexagonal port
    lives in `shared`, like `agent-runtime.ts`/`transport.ts`.)
  - `apps/server/src/services/workspace/` (new) — `WorkspaceService` (the manager),
    `providers/worktree.ts`, `providers/clone.ts`, `port-allocator.ts`,
    `hooks.ts`, `workspace-store.ts` (DB cache), `workspace-reconciler.ts`.
  - `packages/db/src/schema/` (new `workspace.ts` table) — derived cache, mirrors
    `agents`.
  - `apps/server/src/routes/workspaces.ts` (new) — HTTP API.
  - `packages/shared/src/transport.ts` (touched) — add workspace verbs.
  - `apps/server/src/index.ts` (touched) — bootstrap + register + reconciler start.
  - Session-create path (`routes/sessions.ts` / `services/session/`) (touched) —
    opt-in `workspaceKey` → provision/bind → `cwd` + injected ports.
  - `.claude/scripts/worktree-setup.sh` (touched) — consult the server port
    authority; keep hash as fallback.
- **Shared dependencies:** `dork-home.ts`, `boundary.ts`, `config-schema.ts`
  (`conf`), `@dorkos/db`, the runtime registry.
- **Data flow:** session-create request (`{ workspaceKey?, provider? }`) →
  `WorkspaceService.ensure(key)` → provider `create`/reuse → `after_create` hook →
  port block allocated + injected → entity written file-first then DB-cached →
  session bound with `cwd = workspace.path`. Cleanup: unit-of-work terminal state
  → `before_remove` hook → dirty-tree refusal → provider `remove`.
- **Feature flags/config:** new `workspace` section in `UserConfigSchema`
  (root override, port-block size, retention cap, enabled). Defaults make it inert
  until a `workspaceKey` is supplied (backward compatible).
- **Potential blast radius:** the session-create path and `worktree-setup.sh` are
  the only **live** surfaces touched; both changes are additive/opt-in with
  fallbacks, so existing behavior is preserved when no workspace is requested.

## 5) Research

- **Potential solutions:**
  1. **Server-managed `Workspace` entity + `WorkspaceProvider` port (recommended,
     research §3.2).** Hexagonal, mirrors `AgentRuntime`/`Transport`; file-first
     persistence; two providers (`worktree`, `clone`); Symphony's four hooks with
     exact names/semantics; server-side contiguous port-block allocation.
     - _Pros:_ matches the industry convergence and Symphony 1:1; zero
       `AgentRuntime` change; reuses every existing pattern (ADR-0043, boundary,
       config); kills port-hash collisions outright; designed for the v2 naming
       layer and container/remote providers without migration.
     - _Cons:_ large surface; touches the live session path (mitigated by opt-in).
  2. **Keep the gtr-only operator flow, no server entity.** _Rejected_ — the
     hypothesis is precisely that server ownership unlocks runtime-agnostic
     parallel sessions + collision-free ports; gtr alone can't allocate ports
     server-side or bind arbitrary-runtime sessions.
  3. **Adopt Symphony's workspace module wholesale.** _Rejected_ — Symphony pins
     the Codex app-server protocol (§10); DorkOS's `AgentRuntime` is the
     generalization Symphony lacks. We adopt its **workspace model**, not its
     agent coupling.
- **Recommendation:** Solution 1, with the operator-confirmed maximal scope
  (wire into the live session/flow path), built additive/opt-in.

## 6) Decisions

| #   | Decision                           | Choice                                                                                                                                                                  | Rationale                                                                                                                                                       |
| --- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | v1 reach into the running system   | **Wire into the live session/flow path** (operator-confirmed)                                                                                                           | Maximal value: sessions can actually provision+bind workspaces and get collision-free ports. Built additive/opt-in with gtr + hash fallbacks so nothing breaks. |
| 2   | Workspace unit                     | **Unit of work** (issue id / spec slug), not session                                                                                                                    | Research finding #2; sessions _attach_, a workspace outlives any session; matches Symphony reuse-across-attempts.                                               |
| 3   | Layout                             | `<dorkHome>/workspaces/<projectKey>/<key>/`                                                                                                                             | Research #1 (6/7 industry); via `dork-home.ts`; matches existing gtr `.gtrconfig` relocation.                                                                   |
| 4   | `WorkspaceProvider` providers (v1) | `worktree` (git worktree) + `clone`                                                                                                                                     | worktree = fast shared object store (what gtr does); clone = repos not checked out locally. `container`/`remote` deferred.                                      |
| 5   | Hooks                              | Symphony's four — `after_create`/`before_run` **fatal**, `after_run`/`before_remove` **logged-ignored**, 60s timeout, cwd=workspace                                     | Name+semantics compatibility makes future Symphony adoption a config copy, not a migration (research §1.2/§3.2).                                                |
| 6   | Hook config file                   | repo-owned versioned `.dork/workspace.json`                                                                                                                             | Mirrors the `.dork/agent.json` precedent; committed to the source repo.                                                                                         |
| 7   | Persistence                        | **File-first write-through** (ADR-0043): per-workspace manifest = truth, SQLite `workspaces` table = derived cache, reconciler syncs                                    | Reuse the exact agent-storage idiom; survives restart; recoverable.                                                                                             |
| 8   | Path safety                        | Reuse `lib/boundary.ts` (`validateBoundary`/`expandTilde`) + sanitize keys to `[A-Za-z0-9._-]`                                                                          | Invariants #2/#3 already implemented; symlink-escape detection included.                                                                                        |
| 9   | Cleanup                            | **Conservative** — refuse to remove dirty (uncommitted/untracked/unpushed) workspaces; `pinned` exempt; trigger on unit-of-work terminal state + optional cap/age sweep | The industry's #1 failure mode (CC #46444, Cursor). Hard refusal, never auto-destroy work.                                                                      |
| 10  | Port allocation                    | Server-side **contiguous block** per workspace, injected as the **existing** env names; hash-mod-150 kept as offline fallback                                           | Conductor model; eliminates birthday-paradox collisions; preserves the `DORKOS_PORT`/`VITE_PORT`/`SITE_PORT` contract → no app changes.                         |
| 11  | v2 naming layer readiness          | Entity **reserves** `hostname`/`url` alongside `portBase`; no Portless dependency now                                                                                   | Research §5 verdict (c)+(a): ship ports, design for names; pre-1.0 root daemon is not a v1 dependency.                                                          |
| 12  | `AgentRuntime` interface           | **Unchanged**                                                                                                                                                           | `cwd` already on `SessionOpts`/`MessageOpts`; binding needs no interface change (the hypothesis's core claim).                                                  |

_Open mechanical decisions deferred to SPECIFY (logged, not blocking): exact
`workspaces` table columns; whether `.dork/workspace.json` subsumes `.gtrconfig`
or the worktree provider translates between them (research §Open Questions);
whether the per-workspace entity manifest is named distinctly from the repo-owned
hook config to avoid the `.dork/workspace.json` name clash._

## 7) Recommended Next Step

**Proceed to SPECIFY.** This is a partial-spec/fast-track item: the research +
codebase discovery + the 12 decisions above are sufficient to freeze a
specification. SPECIFY will pin the entity schema, the `WorkspaceProvider`
contract, the port-allocation algorithm, the hook execution contract, the HTTP +
Transport surface, the session-binding wiring, and draft the ADRs (the new
hexagonal port; the server-as-port-authority decision). The three validation
criteria from DOR-84 become the acceptance tests:

1. Two sessions on different runtimes work the same repo concurrently without collisions.
2. A workspace survives across sessions and run attempts for the same issue/spec.
3. Cleanup refuses to remove dirty workspaces.
