---
slug: agent-home-desk
id: 260926-172253
created: 2026-09-26
status: specified
---

# Home, desk and shared folders — specification

**Status:** Specified
**Author:** Claude (spec author), direction approved by Dorian 2026-09-26
**Tracker:** DOR-2355 (closes DOR-2356; DOR-2359 becomes moot for rooms; retires DOR-1640's patch)
**Decision record:** [01-ideation.md](01-ideation.md) — the rule, the operator's decisions and the
decisions made under delegation (22 after the review round). Not re-litigated here.
**ADRs:** [260926-172251](../../decisions/260926-172251-an-agents-identity-comes-from-its-home-and-its-desk-is-its-home-or-a-private-copy.md)
(home and desk), [260926-180223](../../decisions/260926-180223-a-turn-reaches-shared-folders-through-per-turn-grants-on-the-runtime-port.md)
(grants on the runtime port; room turns stand at home), [260926-172252](../../decisions/260926-172252-people-change-a-rooms-files-through-the-server.md)
(people's file operations), [260926-180308](../../decisions/260926-180308-a-clean-room-worktree-is-fast-forwarded-when-its-agents-turn-launches.md)
(the launch-time refresh).
**Amends:** `specs/project-rooms/` ideation decisions 5 and 13, spec §3.4 ("the server never mutates
a worktree"), §3.5 rung 2, §3.7's files section and §3.8; ADRs 260829-115621, 260829-115626,
260807-233816, 260726-022251.
**Tasks:** [03-tasks.json](03-tasks.json)

Every path below is relative to the repo root. Line numbers are as of `origin/main` `441c145d2` and
are hints, not contracts: search by symbol.

## 1. Overview

DorkOS reads who an agent is from the folder a turn runs in. That is right only while the folder is
the agent's home, and three live paths break it: project-room turns run in a room worktree, a git
worktree of a repo agent's home carries a committed copy of `.dork/`, and `managed` workspace turns
run in a checkout. This spec separates **home** (identity, never moves), **desk** (where a turn
stands: home, or a private copy of the agent's own home repo) and **shared folders** (granted per
turn, never stood in). It then moves project-room turns back to the agent's home with the room's
files granted, removes the patches that existed only because a room turn stood in its worktree, gives
people the full set of file operations on a room's files, and refreshes an agent's copy at turn start
when that cannot lose anything.

### Goals

- Every identity-bearing read (persona, `SOUL.md`, `NOPE.md`, memory, tool groups, account pin,
  runtime choice, labels) resolves through the agent's registered home, on every runtime.
- A turn dispatched as a named agent can only stand in that agent's home or a private copy of it.
- The `AgentRuntime` port can grant folders per turn, read or write, on all three runtimes, gated by
  `runtimeConformance`, in a shape DOR-2029 can reuse.
- A room about a codebase can ask that codebase's agent to change its own code in the same turn it
  works on the room's files.
- People can edit, add, upload, rename and delete a room's files, and keep a chat attachment, from
  the app, each change a named commit and a quiet room entry.
- An agent with no work in progress starts every room turn on current files; one with work in
  progress is told what it is racing.
- No history is stranded: existing room transcripts stay listed and resumable.

### Non-goals

Presence in the Files panel, "Open in my editor" private copies, linked repos, building worksessions
(DOR-2161) or multi-repo projects (DOR-2029), `projectConfigRoot` for worktree desks
(`specs/worktree-project-config-root/`), and sandboxing shell commands.

## 2. Invariants

Each invariant has at least one test in §11 that fails if it is broken.

- **I1 — Identity comes from home.** Nothing identity-bearing is read from a path that is not a
  registered agent home. `readManifest`, `readConventionFile`, `buildAgentContextAppend`,
  `buildMemoryBlock` and the account-pin read take an `AgentHome`, never a cwd.
- **I2 — A committed `.dork/` elsewhere is inert.** A `.dork/agent.json`, `SOUL.md`, `NOPE.md` or
  `MEMORY.md` in a worktree of a home repo, a room repo, a room worktree or a managed checkout changes
  nothing any turn sees and registers no agent.
- **I3 — The desk rule.** A turn dispatched as a named agent (room, relay binding, task) never
  stands in another agent's home or a private copy of it, and never in a room's folder
  (`<dorkHome>/rooms/**`). Its desk is its own home, a folder that resolves to that same home through
  §3's resolver, or — only when the agent is configured `workspace.mode: 'none'` or its home is
  refused by the boundary — the operator-configured `DEFAULT_CWD`. Identity comes from the home in
  every case. Anything else is refused `DESK_NOT_OWN` before the runtime is called (DOR-2356).
- **I4 — Room turns stand at home.** A project-room turn's `cwd` is the agent's home. It is never a
  room worktree, never `repo/`, never another agent's home.
- **I5 — Grants are exact and per turn.** A turn is granted exactly the folders its dispatcher
  computed for it. A grant from an earlier turn in the same session is not handed to a later turn that
  does not carry it.
- **I6 — One writer per room tree.** `repo/` is written only by the server. A room worktree is written
  only by its agent's turns (room turns and app-resumed turns on that agent's room sessions, which
  carry the same grant) and, when none of those is running, by the §6 fast-forward.
- **I7 — The refresh cannot lose work.** The server moves a worktree only when it is on its own
  branch, has no tracked or untracked changes, has no commits `main` lacks, and has no ignored or
  untracked file at, inside, or above any path the fast-forward would touch; it only fast-forwards; and it runs at the
  moment a room turn is launched, never while any session bound to that (room, agent) has a turn
  running.
- **I8 — Files never change during a turn.** The refresh happens at launch, before the runtime is
  called and before the room context's files section is rendered, the same boundary where the
  `ROOM.md` pin takes effect (ADR 260829-115623).
- **I9 — People write through the server.** Every person change is one commit on `main`, authored as
  that person (§7.1 authorship rule), behind the room's merge mutex, refused `PEOPLE_ONLY` for agents and `FILE_CHANGED` when
  the path moved since the person loaded it.
- **I10 — Edits wake nobody.** A person's file change posts one entry that stores no mentions,
  addresses nobody and triggers no turn.
- **I11 — No room-authored instructions reach an agent unlabelled.** No harness loads skills, rules
  or `CLAUDE.md` from a granted folder. `ROOM.md` on the provenance-labelled append stays the room's
  only instruction channel.

## 3. Resolving a folder to a home

### 3.1 The resolver

`apps/server/src/services/core/agent-identity/identity-anchor.ts` already answers "which agent does
this folder act as" (DOR-2091), through `resolveIdentityAnchor(cwd, forAgent?)` and the
`WorkingCopyOwnerPort` registered at `apps/server/src/index.ts:1743`. It becomes the one resolver for
homes, and its answer becomes a branded type:

```ts
// apps/server/src/services/core/agent-identity/agent-home.ts (new)
/** A registered agent home. Only {@link resolveAgentHome} and the registry mint one. */
export type AgentHome = string & { readonly __brand: 'AgentHome' };

export type HomeResolution =
  | { kind: 'home'; home: AgentHome; via: 'exact' | 'linked-worktree' | 'managed-workspace' }
  | { kind: 'none' } // no agent: a session about a directory
  | { kind: 'refused'; reason: 'not-the-turns-agent' | 'unregistered-owner' };
```

Owner sources, in order, first match wins:

1. **Exact.** `meshCore.getByPath(dir)` — the registered home itself (today's behaviour).
2. **Linked worktree of a home repo** (new). Pure filesystem, no `git` process:
   walk up from `dir` to the nearest ancestor `W` holding `.git`; if `.git` is a directory, stop (not
   a linked worktree). If it is a file `gitdir: <G>`, require git's own **backlink**: `<G>/gitdir`
   must exist and name `<W>/.git` (realpath-compared). A hand-written `.git` pointer into another
   agent's repo has no backlink and answers `none`. Then read `<G>/commondir`; **missing
   `commondir` answers `none`** (a submodule's `.git` file points at a gitdir with no `commondir`).
   Resolve it to the common dir `C`; when `basename(C) === '.git'` the main worktree is
   `M = dirname(C)` (a bare repo answers `none`).
   The candidate home is `path.join(M, path.relative(W, dir))`; it resolves only if that exact path is
   registered. No walk-up past the relative position: a desk at `W/apps/server` maps to
   `M/apps/server`, the same exact-path rule as source 1. A common dir under `<dorkHome>/rooms/`
   answers `none` without a lookup.
3. **Managed workspace** (new). `apps/server/src/services/workspace/workspace-store.ts`: a workspace
   whose checkout path equals `dir` and whose `owner` is `{ kind: 'agent', ref }` resolves to `ref`
   when `ref` is registered. This holds even when the workspace's `source` is another repo (01-ideation
   decision 9).

The room-worktree owner source (`RoomWorktreeManager.ownerOf`) stays until T4, which removes it: after
T4 a room worktree is never a desk, and a session a person opens inside one resolves to `none`.

`forAgent` keeps its DOR-2091 meaning: when the caller names the agent the turn is for
(`roomTurn.agentPath`, a binding's agent, a task's agent) and the resolution names a different home,
the answer is `refused: 'not-the-turns-agent'`.

Memoization: source 1 (exact) and source 3 (managed) are memoized per `dir`, invalidated on mesh
register/unregister (`meshCore.onUnregister` and the register path) and on workspace-store writes.
Source 2 is memoized keyed on `(dir, contents of W/.git, contents of <G>/gitdir)`, so removing a
worktree and adding another at the same path, or rewriting its `.git` file, is a cache miss. The
three reads cost less than the `stat` calls they replace; nothing is cached across a changed pointer.

### 3.2 Identity readers that change (T1)

From a full census of the call sites (verified on `441c145d2`). "Raw cwd" means the site reads
`<cwd>/.dork/` today.

| #   | Site                                                                                                                                          | Today                                                                | After                                                                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `runtimes/claude-code/messaging/launch-resolver.ts:187` `readManifest(effectiveCwd)` — tool groups, account pin                               | raw cwd                                                              | `readManifest(home)`                                                                                                            |
| 2   | `launch-resolver.ts:248` → `messaging/context-builder.ts:707` → `runtimes/shared/agent-context.ts:413-472` `buildAgentBlock`                  | raw cwd (persona, traits, `SOUL.md`, `NOPE.md`, conventions, memory) | takes `AgentHome`                                                                                                               |
| 3   | `runtimes/claude-code/claude-code-runtime.ts:974` `accountRootForSession` → `readManifest(projectDir)`                                        | raw cwd                                                              | home                                                                                                                            |
| 4   | `runtimes/codex/codex-runtime.ts:700` `buildAgentContextAppend(cwd)`                                                                          | raw cwd                                                              | home                                                                                                                            |
| 5   | `runtimes/opencode/messaging/turn-context.ts:60` `buildAgentContextAppend(cwd)`                                                               | raw cwd                                                              | home                                                                                                                            |
| 6   | `routes/sessions.ts:1037-1050,1195` `resolveRuntimeTypeForNewSession` — `manifest.runtime`                                                    | `verifiedAgentPath ?? cwd`                                           | `verifiedAgentPath ?? resolveAgentHome(cwd)`; no manifest read when `none`                                                      |
| 7   | `services/relay/subject-resolver.ts:64` subject label                                                                                         | `readManifest(session.cwd)`                                          | home                                                                                                                            |
| 8   | `runtimes/claude-code/mcp-tools/core-tools.ts:18-30,130` `get_agent` with `cwd`                                                               | raw cwd                                                              | resolves `cwd` to a home first; `none` answers "no agent lives there"                                                           |
| 9   | `routes/agents.ts:185-202` `GET /agents/current?path` (client `use-current-agent.ts:18`)                                                      | raw path, no mesh check                                              | resolves to a home; the response names the home path so editors write there, never to a worktree's copy                         |
| 10  | `services/tasks/task-provenance.ts:41` proposer name                                                                                          | `describeAgent(session cwd)` exact                                   | through the resolver                                                                                                            |
| 11  | `services/mesh/agent-path-lookup.ts:65` `resolveAgentIdForPath` (notifications, `Task.agentId` joins)                                         | exact                                                                | through the resolver                                                                                                            |
| 12  | `services/tasks/task-scheduler-service.ts:906-917,1404` and `services/relay/binding-router.ts:697-761,1172` — dispatch of a `managed` binding | runtime anchors on the checkout; no `agentPath` sent                 | send `roomTurn`-style `agentPath` identity (a new neutral `forAgent` on `MessageOpts`, §4.1) so the runtime anchors on the home |

Sites already correct and unchanged: execution defaults (`resolve-session-defaults.ts`,
`runtime-registry.ts:312`, `resolve-agent-runtime-type.ts`), per-agent MCP and connectors (keyed by
agent id), operating-skills seeding (`services/harness/project-agent-workspace.ts`, homes only), and
`memory-capabilities.ts` `memory_write` (anchored). The anchored sites (`launch-resolver.ts:176,239`,
`mcp-tools/index.ts:322`, `claude-code-runtime.ts:562`, `relay-helpers.ts:~51`, `codex-runtime.ts:587,1186,1201`,
`opencode-runtime.ts:345,494`, `opencode/mcp/mcp-manager.ts:199`) switch from
`resolveIdentityAnchor` to `resolveAgentHome` with no behaviour change beyond the two new owner
sources.

`AgentHome` makes I1 a compile-time property on the server: the four reader entry points (1-5) take
`AgentHome`, and the only producers are the resolver and `meshCore` reads of a registered
`projectPath`. `packages/shared/src/manifest.ts` `readManifest` keeps its string signature for the
CLI and other packages; the server-side wrappers are the typed door.

### 3.3 Registration guard (T1)

Mesh refuses to register a candidate whose path is under `<dorkHome>/rooms/`
(`packages/mesh/src/mesh-discovery.ts` register path, reason `inside-room-files`). A linked worktree
of a registered home is already refused as `duplicate-id` by `AgentRegistry.upsert`
(ADR 260801-003050); T1 adds a test naming that case so I2 is pinned in both places.

### 3.4 The desk guard (T4, DOR-2356)

`assertOwnDesk(forAgent: AgentHome, cwd: string, binding: 'home' | 'managed' | 'none' | 'boundary-refused')`
in `agent-home.ts`. Checked in this order:

1. `cwd` is inside `<dorkHome>/rooms/` → refuse (a room's folder is never a desk).
2. `resolveAgentHome(cwd)` names a home other than `forAgent` → refuse (another agent's home or a
   private copy of it).
3. `cwd === forAgent`, or the resolution names `forAgent` → pass.
4. `cwd === DEFAULT_CWD` and `binding` is `'none'` or `'boundary-refused'` → pass. This is the
   supported `workspace.mode: 'none'` value (`resolve-session-cwd.ts`; tasks at
   `task-scheduler-service.ts:916`, relay at `binding-router.ts:761,1172`). Identity still comes from
   `forAgent`'s home.
5. Anything else → refuse.

`binding` is a mapping, not a value `resolveSessionCwd` reports: it reports one rung, `'default'`, for
both an agent configured `workspace.mode: 'none'` and an agent whose home the boundary refused (the
refusal carries a `degraded` reason). The caller maps `agent-home` → `'home'`, `agent-managed` →
`'managed'`, `default` with a boundary `degraded` reason → `'boundary-refused'`, and `default`
otherwise → `'none'`; the mapping lives beside `assertOwnDesk` and is unit-tested.

**Step 2 wins over step 4, on purpose.** Outside the CLI and the desktop app, `DORKOS_DEFAULT_CWD` is
unset and `DEFAULT_CWD` falls back to the repo root (`lib/resolve-root.ts:58-59`) — which, in a
DorkOS dev checkout, is the `dorkos` agent's own home. A `none` agent's task or relay turn there
resolves to another agent's home and is refused at step 2, before step 4 could pass it. That is I3
working as intended: standing in the `dorkos` agent's home would read and write that agent's folder.
The refusal names the fix in plain words (set a default folder, or give the agent a home binding). A refusal throws `DeskNotOwnError` (`DESK_NOT_OWN`).
Called at the three named-agent dispatch points, immediately before `runtime.sendMessage`:

- rooms: `apps/server/src/services/rooms/room-turn-runner.ts` before `dispatchMessage` (`:864`);
- relay bindings: `apps/server/src/services/relay/binding-router.ts` dispatch;
- tasks: `apps/server/src/services/tasks/task-scheduler-service.ts` run dispatch.

A refused room turn fails through the runner's existing turn-failure path (the room sees the same
failure notice a runtime error produces, naming the reason in plain words); a refused task run is
recorded as failed with the reason. Sessions a person opens in a folder are not named-agent turns and
are not guarded (01-ideation decision 10).

## 4. The runtime port: directory grants (T2)

### 4.1 Shape

```ts
// packages/shared/src/agent-runtime.ts
/** A folder a turn may reach without standing in it. */
export interface DirectoryGrant {
  /** Absolute, `realpath`-resolved. Never the turn's own cwd, never inside it. */
  path: string;
  /** `write` lets file tools create and change files there; `read` asks the backend to refuse them. */
  access: 'read' | 'write';
}

export interface MessageOpts extends SessionSettings {
  // …existing fields…
  /**
   * Folders this turn may reach beyond its cwd, recomputed by the dispatcher for every turn. A
   * runtime hands exactly this set to its backend on this turn — a grant absent here is absent from
   * the turn, even if an earlier turn of the same session carried it. Absent means none.
   */
  additionalDirectories?: readonly DirectoryGrant[];
  /**
   * (Added by T1, not T2.) The home of the agent this turn is dispatched AS, when a server path names one (room, relay
   * binding, task). Runtimes resolve identity against it exactly as they do `roomTurn.agentPath`
   * today; `roomTurn.agentPath` becomes an alias read from here.
   */
  forAgent?: string;
}
```

**Forwarding through the dispatcher.** `services/session/message-dispatcher.ts` forwards turn fields
**by name** in two places: the `turn: Pick<DispatchMessageOpts, …>` whitelist (`:955-970`) and the
launch spread that rebuilds a queued turn (`:1236-1250`). A field missing from either is silently
dropped for any turn that waited in the queue — and for grants, absent means none (I5). T1 adds
`forAgent` to both, T2 adds `additionalDirectories` to both, and T4 adds `prepareLaunch` (§6.1; T5 is its
first real user) to both; each lands with a test that queues a turn behind a running one and asserts the field reaches
`runtime.sendMessage`.

A `write` grant nested inside a `read` one is legal (the room's `repo/.git` inside `repo/`); where a
backend's rules are path-prefix denies, the `read` ancestor wins for file tools and only shell
processes write inside it — which is the intended outcome for `repo/.git` (§5.2). The reverse, a
`read` grant inside a `write` one, is refused: Codex's `--add-dir` makes the whole `write` folder
writable, so the runtimes would disagree about it.

Validation, in one place (`packages/shared/src/directory-grants.ts`, exported as
`@dorkos/shared/directory-grants`, as built in T2): absolute, normalized and **`realpath`-resolved**
(a grant spelled through a symlink — `/tmp` for `/private/tmp` — failed to match what the backend
compares, and for a `read` grant that is a write let through); no duplicates; not equal to, inside
or **containing** the cwd (a `read` grant above the cwd would refuse edits in the agent's own
folder); not a filesystem root, and not the user's home directory **or anything containing it**; no
`read` grant inside a `write` grant. A runtime receiving an invalid set throws before the backend is
launched; the dispatcher is the only producer, so this is a programming error, not a user-facing one.

### 4.2 claude-code

`apps/server/src/services/runtimes/claude-code/messaging/directory-grants.ts` (new) maps grants to the
`settings` object `launch-resolver.ts` already builds (`:552-556`, merged, never replaced):

```ts
settings.permissions.additionalDirectories = grants.map((g) => g.path);
settings.permissions.deny = [
  ...existingDeny,
  ...grants
    .filter((g) => g.access === 'read')
    .flatMap((g) => [`Edit(/${g.path}/**)`, `Write(/${g.path}/**)`, `NotebookEdit(/${g.path}/**)`]),
];
```

(`/${g.path}` produces the `//abs/path` form: a single leading slash is project-relative in Claude
Code's rule syntax and fails open.) SDK 0.3.280 `Settings.permissions` carries `allow`, `deny`,
`ask`, `defaultMode`, `additionalDirectories` (`sdk.d.ts:6532-6562`); `Options.settings` accepts an
object (`:2144`).

- **Why the settings form and not `Options.additionalDirectories`.** The option becomes `--add-dir`
  (`sdk.mjs`), which loads skills from the granted folder; `permissions.additionalDirectories` loads
  neither skills nor rules (research/20260913_multi-repo-organization-for-agents.md, Claude Code
  docs). I11 needs the latter.
- **Validation gate (blocks T2 merging).** Live claude-code runs on the operator's own sign-in
  prove the grant behaves like the working directory does in each mode, because room turns run in the
  operator's unattended trust stop — `acceptEdits` or `bypassPermissions`, never `default` (DOR-1917,
  `room-turn-runner.ts:333-340`):
  - (a1) `default`: `Read` of a file inside a `write` grant raises no `canUseTool` call (reading
    outside the cwd is what the grant exists to allow; `Edit` asks in `default` everywhere, so it is
    not the test).
  - (a2) `acceptEdits`: `Edit` inside a `write` grant raises no `canUseTool` call.
  - (b) `Edit` inside a `read` grant is refused under **both** `acceptEdits` and `bypassPermissions`
    (a deny rule must beat the bypass).
  - (c) a `.claude/skills/probe/SKILL.md` inside a grant is absent from the session's reported skills.
  - (d) a `CLAUDE.md` inside a grant is not loaded.

  Only if (a1) or (a2) fails does the adapter switch to `Options.additionalDirectories`; if (c) then
  fails too, the spec is amended to record that room-committed skills load on claude-code (I11
  downgraded honestly, with the docs saying so) — never silently. If (b) fails under
  `bypassPermissions`, a `read` grant under bypass is recorded as unenforced for file tools too, in
  §5.2 and the docs.

- **Gate results (run 2026-09-26, T2, DOR-2408).** SDK 0.3.280 with its bundled CLI 2.1.280, model
  `haiku`, the operator's own sign-in, one minimal turn per case, each beside a control without the
  grant; `canUseTool` allowed everything, so a refusal could only come from the rules:
  - (a1) passed: `Read` inside a `write` grant raised no `canUseTool` (the control raised one).
  - (a2) passed: `Edit` inside a `write` grant raised none and changed the file (the control raised
    `Read` and `Edit`).
  - (b) passed under **both** modes: `Edit` and `Write` inside a `read` grant were refused ("denied by
    your permission settings") under `acceptEdits` and `bypassPermissions`; the same `Edit` under
    bypass with no grant succeeded.
  - (c) passed: the grant's `.claude/skills/probe` was absent from the session's skills; the same
    folder as `--add-dir` loaded it.
  - (d) passed: the grant's `CLAUDE.md` was not loaded, even with
    `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`; as `--add-dir` with that variable it loaded.

  So the settings form stands and `--add-dir` is not used; I11 holds on claude-code.

- **Rule paths are globs** (found in T2 review, run live). Claude Code matches the path inside a rule
  as a glob, so an unescaped folder name like `R [x] (y)` named a different folder and the real one
  failed open (`Write` succeeded under `bypassPermissions` and `acceptEdits`). The adapter escapes
  `[ ] { } * !`; escaped, all of them were refused live. Spaces and parentheses need nothing, balanced or not: read grants named `R)`, `R(`, `R) x`, `(R` and `R))` were refused under both modes, and a sibling `write` grant stayed writable (run live after the T2 review). Four
  shapes no escaping was seen to make safe are refused for `read` grants before launch, in plain
  words telling the person to rename or move the folder: `?` (an escaped `\?` still let a write
  through), a backslash (untestable — the CLI refused the write for its own reason), a control
  character, and a folder name ending in whitespace (the CLI trims the rule, so `…/R ok ` failed
  open). A `write` grant needs no rule and takes any name.
- **`CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD`** is removed from the turn environment
  (`runtimeEnvironment('claude-code','turn', …)`) whenever it is present in the server's environment,
  pinned by test.
- **Warm process.** `sessions/launch-fingerprint.ts` `PIN_DISPOSITIONS` gains
  `additionalDirectories: 'relaunch'`, fingerprinted as the sorted `path:access` list, so a changed set
  relaunches the warm CLI (I5). Room sessions carry a stable set, so steady state costs nothing.
- Bash is not restricted by any of this. Stated in the docs and in the skill.

### 4.3 codex

`apps/server/src/services/runtimes/codex/turn-input.ts` `projectThreadOptions(settings, cwd, grants)`
sets `additionalDirectories` to the `write` grants' paths (`@openai/codex-sdk` 0.154.0
`ThreadOptions.additionalDirectories`, turned into `--add-dir` per run, so it is per turn on
`startThread` and `resumeThread` alike). `read` grants hand nothing: the sandbox already reads outside
the workspace in `read-only` and `workspace-write`, so a `read` grant is read-open there and its
write protection is the sandbox's own (a shell write into it was refused). Under `danger-full-access`
(bypass mode) nothing is enforced — the same as today for everything else. Run live on 2026-09-26
against codex 0.154.0 on the operator's sign-in: under `workspace-write`, a shell write into a
`write` grant succeeded with the grant and was refused without it.

### 4.4 opencode

**Built as the ask handler, not session rules (T2 deviation, run live).** The sidecar config
(`opencode/server-manager.ts:52`) stays as it is. The first design — `client.session.update({ body:
{ permission } })` with a per-session `PermissionRuleset` when the grant set changes — was run against
a live 1.18.31 sidecar with a free local model (`ollama/gemma4`) on 2026-09-26, each case beside a
control, and rejected:

- An `external_directory: allow` session rule did stop the ask for a read inside the grant (the
  control asked), so session rules do beat the sidecar default.
- But `session.update` **appends** to the stored ruleset: a later update with a new set, `[]` or
  `null` left every earlier rule in place. Taking a grant away needs a counter-rule appended after
  it (last match wins, also run), the list only grows, and a server restart forgets what was written.
- And an `edit: deny` rule on the absolute folder never matched: the edit tools ask with a path
  **relative to the project's worktree**, so the write was still asked about.

So the adapter answers the sidecar's asks from the grants THIS turn carries
(`opencode/messaging/directory-grants.ts`, consulted by `enforceApprovals` in
`opencode/messaging/approvals.ts` before the session's mode): an `external_directory` ask whose
folders all sit inside a grant is answered `once`; an `edit` ask for a file inside a `read` grant
(`metadata.filepath`, or `metadata.files[]` for `apply_patch` — both absolute) is answered `reject` in
every mode, bypass included. Anything the grants say nothing about goes to the mode as before.
Nothing is written into the sidecar's store, so I5 holds by construction, and a subagent's asks pass
the same handler. A reach is judged on where the path resolves, so a symlink committed inside a
granted folder cannot stretch the grant; a refusal matches either spelling. A refused tool call can
end the turn (observed live). The two live ask payloads are pinned in
`opencode/__tests__/directory-grants.test.ts`, and `opencode/NOTES.md` records the runs. Not run live:
a whole DorkOS turn through `OpenCodeRuntime` with grants.

### 4.5 test-mode and the fake runtime

test-mode declares `directoryGrantsUnprovenReason` in its conformance wiring
(`runtimes/test-mode/__tests__/conformance.test.ts`, beside its append reason); it has no backend, and
`test-mode-runtime.ts` needed no change.
`packages/test-utils/src/fake-agent-runtime.ts` needs no change (a spy records the field).

### 4.6 Conformance

`packages/test-utils/src/runtime-conformance.ts` gains, beside the `systemPromptAppend delivery` case
(`:3557`):

```ts
/** What the BACKEND was handed for each of two turns on one session, never what the suite passed. */
directoryGrantTurns?(
  runtime: AgentRuntime,
  sessionId: string,
  grants: readonly [readonly DirectoryGrant[], readonly DirectoryGrant[]]
): Promise<readonly [HandedGrants, HandedGrants]>;
directoryGrantsUnprovenReason?: string;

interface HandedGrants {
  writable: string[];   // folders the backend will let file tools write
  readOnly: string[];   // folders it can read but refuses file-tool writes to
  readOpen: string[];   // read grants the backend reads with no restriction to hand (codex)
}
```

Case `describe('directory grants (agent-home-desk §4)')`: exactly one of the two options is required;
turn 1 hands `{A: write, B: read}`, turn 2 hands `{C: write}` on the **same live session**
(claude-code: warm, asserted). Assertions: turn 1 hands A as writable and B as read-only or read-open;
turn 2 hands C and **neither A nor B** (I5). Wiring: claude-code reads the FakeCli launch
options' `settings.permissions`; codex reads the mocked `startThread`/`resumeThread` options (a `read`
grant counts as read-open when the options set a sandbox mode); opencode scripts an
`external_directory` and an `edit` ask per folder and reads what the adapter answered. The rules live
in `evaluateDirectoryGrantsDeclaration` and `evaluateHandedGrants` (which also fails a `read` grant
sitting inside a writable folder), proven to reject wrong answers by
`packages/test-utils/src/__tests__/runtime-conformance-directory-grants.test.ts`.

## 5. Room turns stand at home (T4)

### 5.1 Placement

`apps/server/src/services/rooms/room-trigger.ts` `resolveTurnPlace` (`:4053-4067`) and `resolveCwd`
(`:4094-4106`) are replaced by `resolveRoomTurnPlace` in
`apps/server/src/services/rooms/repo/room-turn-place.ts` (new, replacing `room-worktree-cwd.ts`):

```ts
export interface RoomTurnPlace {
  cwd: AgentHome; // always the agent's home (I4)
  additionalDirectories: DirectoryGrant[]; // empty for a room with no files
  files: RoomTurnFiles | null; // what the context block's files section renders
}
export interface RoomTurnFiles {
  worktree: string;
  branch: string;
  repo: string;
  refresh?: WorktreeRefreshOutcome; // §6, set at launch
}
```

For a project room: `ensureWorktree` (unchanged lazy creation, minus seeding and projection, §5.9),
then grants:

| Grant                                                                                 | Access  | Why                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<room>/worktrees/<slug>`                                                             | `write` | The agent's own copy                                                                                                                                                                                                                     |
| `<room>/repo`                                                                         | `read`  | Reading `main` and the room's other files                                                                                                                                                                                                |
| `<room>/repo/.git/{objects, refs/heads/room, logs/refs/heads/room, worktrees/<slug>}` | `write` | A commit and a `git merge main` in a linked worktree write exactly these (01-ideation decision 8). **Amended in T4 (DOR-2410):** never all of `.git`, which would grant the shared `hooks/`, `config` and `info/`; see ADR 260926-180223 |

The dispatcher keeps its load-bearing order (spec project-rooms §3.5): place → build context →
runner. The refresh is **not** part of placement: it runs at launch (§6.1), and fills the files
section's `refresh` field there. `RoomTurnFiles.refresh` is therefore absent in the context the
dispatcher builds and set by `prepareLaunch`. `resolve-session-cwd.ts` loses the `room-worktree` rung (`:271`, `roomWorktree()`
`:318-334`, `ensureRoomWorktree` `:193`); a request naming a room resolves to the agent's home and
stops there, as today's no-repo case does. `RoomTurnRequest.cwd` stays as a field (it is where the
attachment projector writes, §5.4) and always equals `agentPath` for a room turn.

The runner passes `additionalDirectories` and `forAgent: agentPath` into `dispatchMessage`
(`room-turn-runner.ts:864-896`); `services/session/message-dispatcher.ts` forwards both to
`runtime.sendMessage`. `roomTurn.cwd` stays and equals the home; its TSDoc drops "since DOR-1597 is
not where it stands".

### 5.2 Honest limits

Written into the skill (§5.5) and `docs/concepts/rooms.mdx`: a shell command can write anywhere its
permission mode allows, on every runtime — including `repo/` and `main`'s ref in `repo/.git`. That was
already true. The protection is unchanged and server-side: `repo/` found dirty or off `main` stops
every write path with `MAIN_CHECKOUT_DIRTY` and the operator's repair (ADR 260829-115626); merging is
still the only sanctioned write path.

The git grants are folders, and two are shared (amended in T4, DOR-2410): write access to
`repo/.git/objects/` lets an agent overwrite a loose object — git does not re-hash on read, so
`main`'s content can change without a commit — and `refs/heads/room/` plus its reflog folder let one
agent move or erase another agent's `room/<slug>` branch. Neither executes code; closing them needs a
per-agent object store and per-agent refs, which is follow-up work. A shell that is not sandboxed can
also write `repo/.git/config` (a plain `git config` in a copy lands there); the server audits it
before every git command in the room and refuses with `ROOM_REPO_CONFIG_UNSAFE` — never runs — any
filter, diff or merge driver, include, fsmonitor or credential helper it defines.

### 5.3 The room context block

`apps/server/src/services/runtimes/shared/room-context-block.ts` `filesLines` (`:561-591`) is rewritten.
Pinned copy (paths and branch are substituted, sanitized as today):

> This room has files of its own. Your own copy of them is at {worktree}, on branch {branch}. Your
> turn runs in your own folder, not in that copy, so work on the room's files by their full paths,
> and run git there as `git -C {worktree} …` (or `cd {worktree}` first). The room's shared copy is at
> {repo}: read it if you need to, and never write in it.
>
> Sync before you edit: `git -C {worktree} merge main`. When a change is ready, commit it in your
> copy, then use the tool whose name ends in `merge_to_room_main` — whatever you have not committed is
> left behind.

followed by exactly one refresh line from §6.3, then the existing ahead/behind line (silent at 0/0,
omitted on `null`).

### 5.4 Attachments

`apps/server/src/services/rooms/attachments/attachment-projection.ts` is unchanged in mechanism; its
root is `input.cwd`, which is now the home. The header comment at `:94-97` ("the worktree, NOT its
home") is deleted. `room-context.ts` keeps `path.join(input.cwd, relativePath)`.

### 5.5 The `working-in-room-repos` skill

`packages/operating-skills/src/skills/working-in-room-repos.ts` is rewritten around the same words as
§5.3: your turn runs in your own folder; your copy of the room's files is a folder you work on by
path; `git -C <copy>`; absolute paths for edits; the shared copy is read-only; sync, commit, merge.
It adds a short "your own code" paragraph (the new capability: in a room, the agent's own repo is
its desk, so it can change its own code in the same turn — following its own repo's rules for that,
not the room's), with one rule stated as a rule: **when you change your own code, do it in a private
worktree of your own repo, never in your home checkout itself**, because other turns of yours — in
other rooms, or a person's direct session — may be running in that checkout at the same time
(§13). The per-agent concurrency cap (`rooms.maxConcurrentTurnsPerAgent`) stays as it is. `OPERATING_SKILLS_VERSION` is bumped so the every-boot backfill reaches existing
homes. References in `pack.ts`, `operating-dorkos.ts` and `answering-dorkos-questions.ts` are checked
for the old wording.

### 5.6 Canvas file documents

`apps/server/src/services/rooms/canvas/room-canvas-service.ts` `resolveTree` (`:1127-1164`) decides
whose tree a file document came from by the turn's `cwd`. With the cwd at home it would label every
room file "in X's project". It changes to decide from the document's **source path** when that path
is absolute: inside the agent's room worktree → `worktree` (with the ahead count), inside `repo/` →
`room-main`, otherwise → `agent-cwd` against the home. A relative source path resolves against the
cwd (the home) as today. `services/session/browser-seat/ui-control.ts:626,723` keeps passing
`roomTurn.cwd`; the room turn's worktree path is added to `roomTurn` as `roomTurn.worktree?` so the
canvas service needs no rooms lookup.

### 5.7 App-resume (DOR-1624)

`routes/sessions.ts:1177-1187` resolves a room-bound session through
`services/workspace/room-session-cwd.ts` `resolveSessionCwdWithRoom`. It now returns the home **and
the room turn's grants** (from `resolveRoomTurnPlace`), and the message route passes them into
`sendMessage`. An app-resumed turn never refreshes, and because it is a turn on a session bound to
that (room, agent), a room turn launched while it runs skips its own refresh (§6.1). An explicit
`cwd` naming the agent's room worktree is replaced by the home with a debug log;
`vouchForNamedWorktree` (`:127-144`) is deleted. The file is renamed `room-session-place.ts`.

### 5.8 Removal list

Each item is deleted, not deprecated, by the task named.

| What                                                                                                                                                               | Where                                                                                                          | Task |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ---- |
| Room-worktree rung, `roomWorktree()`, `ensureRoomWorktree` default                                                                                                 | `services/workspace/resolve-session-cwd.ts`                                                                    | T4   |
| `ensureRoomWorktreePath`, `roomSessionPlace` as a cwd source                                                                                                       | `services/rooms/repo/room-worktree-cwd.ts` (file replaced by `room-turn-place.ts`)                             | T4   |
| `vouchForNamedWorktree`                                                                                                                                            | `services/workspace/room-session-cwd.ts`                                                                       | T4   |
| Skill-pack seeding, `refreshPack`, projection into worktrees, `SEEDED_PACK_EXCLUDES`, `SCAFFOLDED_INSTRUCTION_EXCLUDES`, `ensureProjectionExcluded` for new writes | `services/rooms/repo/room-worktree-manager.ts` (`:90-102`, `:304-428`, `:874-905`, `:1291-1335`, `:1512-1532`) | T4   |
| The "neither half is only for agent HOMES" paragraph and DOR-1640 notes                                                                                            | `services/harness/project-agent-workspace.ts:38-44,255-266`                                                    | T4   |
| Room-worktree owner source of `WorkingCopyOwnerPort` (`ownerOf` wiring)                                                                                            | `index.ts:1743-1748`, `room-worktree-manager.ts:800-835` (`ownerOf`, `recordOwner`, `owners`)                  | T4   |
| `extraDirs` fed by the live worktree list                                                                                                                          | `index.ts:1754`, `room-worktree-manager.ts:1423-1445` `listWorktreesForAgent`                                  | T4   |
| `resolveTurnPlace`'s files-only-on-`room-worktree` branch                                                                                                          | `services/rooms/room-trigger.ts:4053-4106`                                                                     | T4   |
| DOR-1597 "identity and files are two values" comments                                                                                                              | `room-turn-runner.ts:169,518,646`, `room-context.ts:191`, `room-turn-port.ts:81`, `agent-runtime.ts:821`       | T4   |

Kept on purpose: `busyAgentPaths` as reap gate 1 (a live turn still edits its worktree through the
grant), the claim map and both busy ceilings keyed on `agentPath` (DOR-2359's mismatch between the key and
the cwd is moot for rooms because they are the same value again; the home having several concurrent
writers is a separate, stated risk, §13), the merge service and `room_repo_status`.

### 5.9 Legacy worktree plumbing (T4)

Existing worktrees hold files the old code wrote: the seeded pack (`.agents/skills/<name>/SKILL.md`),
projection links (`.claude/skills/*`, `.agents/harness.manifest.json`, scaffolded `.claude/CLAUDE.md`)
and attachment projections (`.dork/.temp/room-attachments/`), all hidden by a marker block in the
repo's shared `info/exclude`. Removing the block would make every such worktree dirty (never reaped,
merges refused `UNCOMMITTED_WORK`). So, once per worktree per process, at the worktree's next turn
launch, inside `prepareLaunch` and under the same "no bound session busy" check as the refresh
(T4 adds the hook for this, `room-worktree-manager.ts` `retireLegacyPlumbing`):

- delete a seeded `SKILL.md` only when its bytes equal a pack version DorkOS shipped (the seeder's
  own manifest of hashes), a projection path only when it is a symlink into the agent's home or the
  pack, `.dork/.temp/room-attachments/` always (DorkOS-owned, rebuildable);
- anything else at those paths is a person's or agent's own file and is left alone;
- when no worktree of the repo still holds a DorkOS-written path, remove the marker block from
  `info/exclude`. Until then the block stays, frozen at its last contents.

### 5.10 Queued room turns across a restart (T4)

`prepareLaunch`, the grants and `forAgent` live on the in-memory turn. That is safe because the
dispatcher does not persist a queued room turn today: a room's trigger writes no queue row
(DOR-1242), and `adoptQueuedMessages` sweeps any room row an older build left behind rather than
adopting it (`message-dispatcher.ts`, the DOR-1242 comment in `adoptQueuedMessages`). So after a
restart a queued room turn is gone, never resurrected with missing grants, and the room's own
recovery (the claim and hold state it rebuilds) decides whether it is triggered again — at which
point it is placed, granted and refreshed from scratch. T4 pins this with the restart test in §11;
if a later change starts persisting room turns, it must persist `additionalDirectories` and
`forAgent` with the row and re-run the room's `prepareLaunch` on adoption.

## 6. Turn-start refresh and heads-up (T5)

### 6.1 The refresh

`apps/server/src/services/rooms/repo/room-worktree-refresh.ts` (new).

**When it runs.** Not at placement: a room turn can wait in the session queue behind another turn on
the same session (an app-resumed turn holds no room claim), and a refresh done at placement would
move files under that running turn. So the refresh runs at **launch**, through a new
`DispatchMessageOpts.prepareLaunch?: () => Promise<Partial<Pick<DispatchMessageOpts, 'roomContext'>>>`
(added by T4 for legacy clean-up, §5.9)
that `message-dispatcher.ts` awaits at the one point where a turn — immediate or dequeued — is about to
call `runtime.sendMessage`, and merges the result into the turn. It is forwarded by name like every
turn field (§4.1). The room turn runner supplies it; it runs the refresh and sets
`roomContext.files.refresh` (the runtimes format `roomContext` at launch, so the context the model
sees matches the files on disk). Before touching git, it asks the dispatcher whether **any session
bound to this (room, agent)** (`room_sessions`) has a turn in flight other than this one; if so it
answers `held: busy` without a single git call. The question is a new read,
`message-dispatcher.ts` `isTurnInFlight(sessionId)`, asked for each session id `room_sessions` holds
for the (room, author) pair. It is true when **either** the dispatcher's `inFlight` slot is held
**or** the runtime reports a live turn (`AgentRuntime.isLocked(sessionId)` with no client, or the
session is streaming) — the same authority `deliverSteer` uses, because `inFlight` alone is lossy: a
turn launched with its queue budget exhausted runs holding the real session lock with no `inFlight`
entry (`message-dispatcher.ts`, the `deliverSteer` TSDoc and `launchDispatch`).

```ts
export type WorktreeRefreshOutcome =
  | { kind: 'current' } // already at main's tip, or just created
  | { kind: 'refreshed'; from: string; to: string; paths: string[] }
  | {
      kind: 'held';
      reason: 'busy' | 'changes' | 'ahead' | 'off-branch' | 'unreadable';
      moved: MainMoved | null; // null for 'busy' (no git read was made)
    };

export interface MainMoved {
  commits: {
    sha: string;
    who: string; // a display name from the room log, never a git author field (§6.2)
    subject: string;
    kind: 'merge' | 'person' | 'other';
    files: string[];
  }[];
  overflow: number; // commits beyond the cap, for "and N more"
  overlap: string[]; // files changed on main since the branch point AND by this agent
}
```

Steps, each a git query under `--no-optional-locks` except the one write:

1. Capture `mainTip = git rev-parse refs/heads/main` once. Every later step uses this value, never
   `main` by name.
2. `HEAD` must be the symbolic ref `refs/heads/room/<slug>`; otherwise `held: off-branch`.
3. `git status --porcelain=v1 --untracked-files=all` must be empty; otherwise `held: changes`.
4. `git rev-list --count <mainTip>..HEAD` must be `0`; otherwise `held: ahead`.
5. If `HEAD === mainTip`, `current`.
6. **Nothing on disk in the way, in either direction.** Let `P` be `git diff --name-only HEAD
<mainTip>` (every path the fast-forward would add, change or remove) and `U` the ignored and
   untracked paths on disk (`git ls-files -o -i --exclude-standard` together with
   `git ls-files -o --exclude-standard`, listed file by file, never collapsed to folders). Answer
   `held: changes` when any `u` in `U` and `p` in `P` are related at all: `u === p`, `u` is inside `p`
   (`u` starts with `p + '/'`), or `u` is a parent of `p` (`p` starts with `u + '/'`). Git's
   fast-forward silently overwrites an ignored file that `main` now tracks (a private `notes.log`
   overwritten, exit 0), and silently deletes ignored files under a folder `main` turns into a
   tracked file (`.gitignore` has `build/`, the worktree holds ignored `build/keep.txt`, `main`
   commits a file named `build` and drops `build/` from `.gitignore`: `P = {.gitignore, build}`, and
   the ff exits 0 having deleted `build/keep.txt`). This step is the only thing that stops either.
7. `git merge --ff-only <mainTip>` in the worktree (the only write). A failure answers
   `held: unreadable` and logs; nothing else is attempted.

A refresh forgets diff baselines for the moved paths in every live session of this agent in this room
(`services/diff/edit-baseline.ts` gains `forget(sessionId, absPaths)`; I8 plus ADR 260711-142049's
first-touch-wins would otherwise report others' changes as the agent's).

### 6.2 What moved

For `held` (except `busy`), `MainMoved` is computed from `B = merge-base HEAD <mainTip>`:
`git rev-list --first-parent B..<mainTip>` (cap 8, newest first). Merges are `--no-ff`
(`room-repo-git.ts`), so without `--first-parent` every commit an agent made on its branch would be
listed and eat the cap; with it, `main`'s own history is exactly one commit per merge and one per
person change. Each commit is classified and named **from the room log, not from git**: the room entry
whose `merge.commit` or `fileChange.commit` equals the sha gives `kind` (`merge` or `person`) and
`who` (that entry's subject author's display name). A commit with no matching entry (a repair commit,
something committed by hand) is `other`, named "someone". Up to 8 files each
(`git diff --name-only <sha>^1 <sha>`). `overlap` is the intersection of `git diff --name-only B
<mainTip>` with the files the agent changed (`git diff --name-only B HEAD` plus working-tree changes).
All git reads are bounded by the existing repo git timeout.

### 6.3 Refresh lines in the context block

Exactly one, pinned:

- `refreshed`: "Your copy was brought up to date with main at the start of this turn ({n} files
  changed)."
- `held` with no moves since the base: nothing (the ahead/behind line covers it).
- `held` with moves: "Main has moved since your copy branched: {who} {subject} ({files})…" one line per
  commit, then "and {overflow} more" when needed, then, when `overlap` is non-empty: "You have also
  changed {files}. Sync before you merge: `git -C {worktree} merge main`."
- `held: off-branch`: "Your copy is not on {branch}, so it was not updated. Switch back before you
  merge."

- `held: busy`: nothing (the turn says nothing about a refresh it did not attempt).

Names render through `sanitizeIdentity` like every label outside the untrusted fence. Commit subjects
and file paths are member-authored text (a person or agent chose them), so the "what moved" lines —
subjects and paths alike — render inside the untrusted fence with the per-turn nonce.

## 7. People's file operations (T6 server, T7 app)

### 7.1 Routes

All in `apps/server/src/routes/rooms.ts`, all `assertCanWriteFiles` (people only, room not archived,
`services/rooms/service/room-visibility.ts:353`), all serialized through `RoomRepoMutex.run` and
`assertMainCheckoutReady` first, all one commit authored as the person, all refusing with the
existing codes plus two new ones.

**Authorship rule, stated plainly.** Today every person commit is authored `operatorGitName()` /
`operator@dorkos.local` (`room-file-editor.ts:377-384`, `room-repo-git.ts:141-150`), whoever is
signed in. From T6: when login is on and the request carries a signed-in person, the commit author is
that person — name = their display name, email = `person-<authorId>@dorkos.local`, a stable
non-address so no real email lands in the room's history. Git refuses a name made only of characters
it strips (`fatal: name consists only of disallowed characters: <>`), so a display name that is empty
after stripping `<`, `>` and newlines falls back to `FALLBACK_OPERATOR_GIT_NAME` exactly as the
operator path does (`room-repo-git.ts:141`). When login is off, the person is the
operator, and the operator identity is used as today. The server never names anyone from git: the
room entry (§7.2) carries the person's author id and is what every surface — including the §6.2
heads-up — reads names from.

| Route                                   | Body                                                                             | Commit subject               | Locking                                                                                                                                    |
| --------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `PUT /:id/files/content` (existing)     | `{ path, baseCommit \| null, text }`                                             | `Edit <path>` / `Add <path>` | unchanged; **now creates missing parent folders** (`assertParentExists` relaxed; a parent that is a file answers `ROOM_FILE_PATH_INVALID`) |
| `POST /:id/files/upload` (new)          | multipart: `dir`, `baseCommit`, `replace` (JSON list of names), `files[]` (≤ 20) | `Upload N files to <dir>`    | per target: absent at `main`, or listed in `replace` and unchanged since `baseCommit`                                                      |
| `POST /:id/files/move` (new)            | `{ from, to, baseCommit }` — file or folder                                      | `Rename <from> to <to>`      | every path under `from` unchanged since `baseCommit`; `to` absent at `main`                                                                |
| `POST /:id/files/delete` (new)          | `{ path, baseCommit }` — file or folder                                          | `Delete <path>`              | every path under `path` unchanged since `baseCommit`                                                                                       |
| `POST /:id/files/from-attachment` (new) | `{ attachmentId, dir, name?, baseCommit }`                                       | `Add <path> from the chat`   | as upload; the attachment must be bound to an entry of **this** room (else 404 `ATTACHMENT_NOT_FOUND`, the attachments route's rule)       |

New codes in `services/rooms/room-errors.ts` and `routes/room-error-response.ts`: `ROOM_FILE_EXISTS`
(409, names the path; the app offers "replace") and `ROOM_UPLOAD_TOO_MANY_FILES` (400). Unchanged
checks apply to every written path: `assertWritablePath`, `assertOverwritable`, `assertNotIgnored`,
`assertFits` (`FILE_TOO_LARGE`, `REPO_CAP_EXCEEDED`, measured on the resulting tree), and
`assertNoLinkOnDisk`. **Case collisions are checked per path segment**, not only on the whole path:
`assertOverwritable`'s capital-letters check today compares whole paths, so saving `Notes/plan.md`
when `notes/` exists passes it, lands on disk inside `notes/` (APFS and NTFS fold case), and commits a
path the response and the room entry would name wrongly. For save (now that it creates parents),
upload, move's destination and save-from-attachment, every folder segment of the new path is compared
case-insensitively with the existing tree at that level, and a mismatch is refused naming the folder
that is really there. Uploads and attachment copies may be binary (the editor stays text-only);
`assertText` applies only to the text save. Multer uses **disk storage** into a
per-request temp folder under `<dorkHome>/.temp/room-uploads/` (never memory storage, which would hold
up to 20 × `maxFileBytes` in RAM), limits each file to the room's frozen `maxFileBytes` and the
request to 20 files, and the temp folder is removed when the request settles. The 1 MB JSON cap does
not apply. A multi-file commit rolls
back entirely on any failure (the editor's existing rollback, extended to a list).

`FILE_CHANGED` keeps its conflict payload (`packages/shared/src/room-files.ts:292-321`), naming the
first commit that touched a locked path.

Schemas in `packages/shared/src/room-files.ts`: `RoomFileUploadFieldsSchema`,
`RoomFileMoveRequestSchema`, `RoomFileDeleteRequestSchema`, `RoomFileFromAttachmentRequestSchema`, and
one `RoomFileChangeResponseSchema { commit, paths, lastCommit }`. OpenAPI entries in
`services/core/openapi-registry.ts` beside the save route (`:5395`), with the generated API docs
committed in the same PR.

The implementation moves out of `room-file-editor.ts`'s single-file path into
`services/rooms/repo/room-file-ops.ts` (new) that stages a list of `{ path, bytes | null }` changes and
commits once; `save` becomes one caller of it.

### 7.2 The room entry

`services/rooms/messages/room-system-posts.ts` gains `postFileChangeEvent`, same shape as
`postMergeEvent` (`:198`): system author, `kind: 'post'`, `mentions: []`, `sessionId: null`, cascade
derived with `authorKind: 'system'`, appended and published, never dispatched. Body:
`{ text, fileChange: RoomFileChangeEvent, subjectAuthorId }`, with
`RoomFileChangeEventSchema` in `packages/shared/src/room-schemas.ts` beside `RoomMergeEventSchema`
(`:906`): `{ kind: 'edit' | 'add' | 'upload' | 'rename' | 'delete' | 'from-attachment', paths (≤ 20),
pathCount, from?, commit }`. `RoomService` exposes it the way it exposes `postMergeEvent`
(`room-service.ts:530`). The existing text save starts posting too.

Text (plain words, person's display name first): "Dorian edited ROOM.md", "Dorian added notes/plan.md",
"Dorian uploaded 3 files to designs/", "Dorian renamed a.md to b.md", "Dorian deleted old/", "Dorian
saved screenshot.png from the chat to designs/".

Paths in a `fileChange` entry are member-chosen text. The app renders them as plain text (never
markdown or links); in the room context they render inside the untrusted fence like any entry body,
and the entry's `text` is composed server-side from sanitized path segments. Agents see these in the
room context like any system entry; the §6.2 heads-up also names them.

### 7.3 The app

`apps/client/src/layers/features/file-explorer/`:

- `model/room-files-source.ts` becomes `writable: true` (`:89`) and implements create, rename, delete
  and upload through new transport methods; `FileTree`/`FileTreeRow` already drive these for session
  folders via `model/use-file-crud.ts` (optimistic update with rollback).
- `ui/FilePreviewDialog.tsx`: `canEdit()` (`:78-85`) drops `isMarkdownPath`; any text file is editable,
  binary stays read-only with a plain sentence saying so.
- "New folder" asks for the folder and its first file name and opens that file in the editor; the
  folder appears when it is saved.
- Drag files onto the Files panel or a folder row to upload; a name clash shows the `ROOM_FILE_EXISTS`
  choice (replace, or keep both by renaming).
- Delete confirms, naming the file or the folder and how many files are in it, and says the room's
  history keeps it (it is a commit, so it can be brought back by an agent or git).
- `FILE_CHANGED` on any operation shows the same "open theirs / keep mine" choice the editor has
  (`lib/save-errors.ts:40-58`); copy for the new codes in `lib/crud-errors.ts`.
- A chat attachment in a project room gains "Save to room files" (message attachment menu), which
  opens a folder picker over the room's tree.
- The tree refreshes on a `fileChange` entry from the room stream exactly as it does on a merge entry.

Transport: `packages/shared/src/transport-rooms.ts` gains `uploadRoomFiles`, `moveRoomFile`,
`deleteRoomFile`, `saveAttachmentToRoomFiles`; implemented in
`apps/client/src/layers/shared/lib/transport/room-methods.ts`, mocked in
`packages/test-utils/src/mock-factories.ts:526` and `apps/client/src/dev/playground-transport.ts:290`.
(There is no DirectTransport in this tree.)

## 8. Migration

### 8.1 Room transcripts filed under worktree folders (T3 builds, T4 wires)

Claude-code files a transcript under `<configDir>/projects/<slug(cwd)>/` (`sessions/project-slug.ts:126,175`),
so every room turn since DOR-1597 was filed under its worktree's slug, and `extraDirs` keeps them in
the agent's session list. Once turns run at home, resuming such a session would look in the home's
folder and not find it.

`apps/server/src/services/runtimes/claude-code/migrate-room-transcripts.ts` (built in T3; not in
`sessions/`, which is at the 25-file dir-size cap) runs at startup and only if its marker is absent.
**T4 wires it**, in the same PR that moves the desk: run while room turns still stood in worktrees, it
would move transcripts out from under the sessions resuming them. T4 must call it:

- **after the agent registry has loaded.** `agentPaths` decides whose a worktree is; an empty list
  would skip every worktree and still write the marker, which never runs the move again;
- **before the room dispatcher starts**, so no DorkOS turn writes a transcript while it moves;
- **inside a `try`.** It throws on an unexpected filesystem error and on two processes racing to write
  the marker (one fixed temp name). A throw leaves the marker unwritten, so the next start retries;
  it must not stop the server from starting.

1. For every room worktree folder on disk (`<dorkHome>/rooms/*/worktrees/*`), find its agent by the
   name's digest suffix against the registered agents (`digestFor(agentPath)`, the scheme
   `listWorktreesForAgent` already uses). Skip a worktree whose agent is not registered, and a digest
   two registered paths share.
2. Also find the slug folders of worktrees the idle reap already removed (the folder is gone, its
   transcripts are not), by exact shape: `<slug of <dorkHome>/rooms>-<room ULID>-worktrees-<agent
name>-<8 hex digest>`, the name part at most 40 characters. A shape-match whose name part carries a
   known worktree digest (a registered agent's, or one on a worktree folder on disk) is what a path
   NESTED inside a worktree looks like — a dev DorkOS running in a worktree keeps its own
   `rooms/…/worktrees/…` there — so it is not moved; when it ends in a registered agent's digest it
   is logged and listed in the marker's `nearMisses`. A slug the SDK truncated past 200 characters is
   not found this way (a worktree still on disk is found by its path instead).
3. For every Claude config directory DorkOS launches with (`resolveClaudeRootSet()`: the default and
   every account's directory), move `projects/<slug(worktree)>/<id>.jsonl` and its sibling `<id>/`
   folder to `projects/<slug(home)>/`. Files move by `link` then `unlink`, so an existing destination
   is never overwritten, and a pass that crashed between the two is finished (same inode), not
   treated as a conflict. Leaving the source as a second `<id>.jsonl` would put two transcripts with
   one session id in the indexed set, which `jsonl-frontier.ts` treats as contested and stops
   indexing; so a colliding source is set aside in place as `<id>.jsonl.conflict` (then `.2`, `.3`…,
   never replacing an earlier one; not indexed by anything), and a sibling folder meeting an existing
   destination folder as `<id>.conflict`. The log and the marker name both paths for the operator.
4. **A transcript written in the last 15 minutes is skipped**, and the marker is not written, so the
   next start retries. A Claude Code process outside DorkOS appends by path, and moving the file under
   it would recreate `<id>.jsonl` at the old place. Fifteen minutes is past the Bash tool's 10-minute
   ceiling, the longest a turn goes without writing. The window protects a turn in flight only: an
   interactive `claude` session left idle outside DorkOS, or a subagent file still being written under
   `<id>/`, can still split a session; the next pass then sets the recreated file aside as a conflict,
   so nothing is lost.
5. **Only transcripts move.** Claude Code's per-project auto-memory (`memory/`) under a worktree slug,
   and anything else unknown, stays and is listed in the marker's `leftBehind`: several rooms'
   worktrees of one agent each have their own, and merging them would carry one room's notes into
   every other room and into the person's own sessions at home. A move the filesystem cannot do
   (`EXDEV`, a slug folder symlinked to another volume) is recorded once in `unmovable`, not retried
   every start.
6. Write `<dorkHome>/migrations/agent-home-desk-transcripts.json` with counts, conflicts, `unmovable`,
   `leftBehind`, `nearMisses` and the **frozen list** of worktree folders it saw (`worktrees[]`, each
   `{ path, agentPath | null }`).

A moved transcript keeps the worktree as the `cwd` its records carry. Listing accepts it (it sits in
the home's own slug folder, which `listSessionsAcrossAccounts` takes whatever the record says), and a
resume carries its history (below), but a reader must not assume a record's `cwd` is the home. T4's
live check must exercise a resume, not only a listing.

**Measured (T3, 2026-09-26).** No paid call: each CLI was pointed at a local fake model endpoint that
records the request, in temp config directories. The operator's real sign-in was not used: the fake endpoint stands in for it, which is enough to show the full history goes out on resume, and T4's live check covers a real turn.

- **claude-code (Agent SDK 0.3.280 and its bundled CLI): resumes at the home after the move.** A copy of a real room transcript,
  filed under a worktree slug, was moved by the module and resumed with `--resume <id>` at cwd = the
  home: the request carried the full history (44 messages; 47 after one more turn) and the new turn
  was appended to the moved file under the home's slug. The CLI also finds the id from the home
  _before_ the move (it looks in other project folders), but then keeps appending under the worktree
  slug, where DorkOS's own reads (history, listing by slug, crash recovery) never look. So the move is
  still required. **`extraDirs` is not needed for claude-code** once transcripts are moved.
- **codex (SDK/CLI 0.154.0): resumes, but does not list at the home.** `codex exec --cd <home> resume
<threadId>` resumed a thread started in another folder with its history; rollouts are filed by date,
  not by folder, so nothing moves. But `codex_threads.cwd` is first-write-wins, so after every restart
  a room session carries the worktree as its cwd and `CodexSessionRegistry.list(home)` never returns
  it. **`extraDirs` must be kept for codex, fed from the marker's frozen list** (or T4 re-points
  `codex_threads.cwd`).
- **opencode (sidecar 1.18.31, no model call): cannot resume at the new desk.** A session created in
  the worktree is found by id from the home, but every session-scoped call routes by the session's
  stored directory (`/shell` with `?directory=<home>` ran with cwd = the worktree; `/fork` also lands
  there), and the directory cannot be changed (`PATCH /session/{id}` takes only title, metadata,
  permission and time). `GET /session?directory=<home>`, exact and `scope=project`, returns none of
  them. So **the next turn of that (room, agent) must start a fresh opencode session** when the bound
  one's directory is a room worktree, and **`extraDirs` must be kept for opencode, fed from the
  frozen list**, so the old session stays listed. The room log carries the conversation either way.
  Picking that old session up in the app is refused before launch (`ROOM_SESSION_MOVED`, `409`)
  with a sentence pointing back to the room: no turn stands in a room's files, and its transcript
  stays readable. Every app launch is also refused (`DESK_NOT_OWN`) when its folder is inside the
  rooms directory, whatever named it.

### 8.2 ADR status

T8 flips 260926-172251, 260926-180223, 260926-172252 and 260926-180308 to `accepted` once T4-T7 have shipped and the code matches.

## 9. Worksessions, managed workspaces and multi-repo

- **Worksessions (DOR-2161).** A worksession is a room thread with a dedicated session in a worktree
  of the agent's own repo. That desk resolves through §3.1 source 2 with no new code. The orchestrator
  comments this on DOR-2161; nothing is built here.
- **Managed (DOR-84).** Unused today (0 rows). §3.1 source 3 gives it identity from its owner's home;
  the desk guard accepts it.
- **DOR-2029.** A multi-repo project's sibling repos become `write` grants on the same port; nothing
  in §4 is room-specific.

## 10. Security

- **Room content cannot widen a grant.** Grants are computed by the server from the room's layout,
  never from room text, `ROOM.md` or repo content. The sidecar remains outside the repo.
- **No room-authored instructions reach the tool layer** (I11): settings-form grants on claude-code;
  codex and opencode read neither skills nor instruction files from external folders; `ROOM.md` is the
  one labelled channel.
- **Read-only is advisory for shells** on every runtime; the server-side `MAIN_CHECKOUT_DIRTY` stop is
  the real protection for `repo/`, as before.
- **Identity cannot be borrowed through a folder.** A committed `.dork/` never counts (I2); a folder
  resolves to at most one home, by exact registered path through three named sources; a named-agent
  turn in any other folder is refused (I3).
- **The refresh cannot destroy work** (I7): three git-read preconditions, fast-forward only, between
  turns only, at launch, never while any session bound to that (room, agent) has a turn in flight.
- **People's operations** keep every existing path, link, submodule, ignore and size rule; uploads
  are bytes (no symlinks can arrive); the attachment copy is membership- and room-scoped.

## 11. Test plan

### Unit

- **Resolver (T1).** Exact; linked worktree at root and at a matching subfolder; linked worktree at a
  non-matching subfolder → `none`; bare common dir → `none`; common dir under `<dorkHome>/rooms` →
  `none` with no registry lookup; managed workspace owned by the agent (source = own repo, and
  source = another repo); `forAgent` mismatch → `refused`; memo invalidated on unregister.
- **Identity readers (T1).** For each of §3.2 rows 1-11: a worktree of a home repo whose committed
  `.dork/agent.json` has a different persona, `NOPE.md`, tool groups, account pin and `runtime` than
  the home → every output (context block text, launch options, account root, runtime choice, label,
  `get_agent`, `GET /agents/current`) shows the **home's** values. The same worktree with `.dork/`
  deleted still resolves to the agent.
- **Negative, I2 (T1/T4).** A room repo with a committed `.dork/agent.json` + `SOUL.md`: mesh refuses
  to register it (`inside-room-files`); a room turn in that room carries the agent's own persona, not
  the file's; a session a person opens in that room's worktree resolves to `none` (after T4).
- **Grant validation (T2).** Relative, unnormalized, not `realpath`-resolved (a symlinked
  spelling), duplicate, cwd-equal, cwd-inside, containing the cwd, a root, the user home or anything
  containing it, and a `read` grant inside a `write` grant → rejected.
- **claude-code mapping (T2).** `settings.permissions` merged with `fastMode`; `//` rule form;
  `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` stripped; fingerprint relaunch on a changed set, no
  relaunch on the same set in a different order.
- **claude-code rule paths (T2).** Glob characters escaped; a `read` grant naming `?`, a backslash,
  a control character or ending in whitespace refused with a plain-language message.
- **codex / opencode mapping (T2).** `write` → `additionalDirectories`; `read` → nothing (codex);
  the ask handler answers `external_directory` inside a grant `once` and `edit` inside a `read`
  grant `reject` in every mode, from this turn's grants only, including a symlinked spelling
  (opencode, §4.4).
- **Room placement (T4).** A project-room turn: `cwd === agentPath`; grants exactly §5.1's three; a
  no-files room: no grants; files section rendered with the new copy (pinned).
- **Desk guard (T4).** A room turn whose computed cwd is another agent's home, a linked worktree of
  another agent's home, a room worktree, or `repo/` → `DESK_NOT_OWN`, the runtime's `sendMessage`
  never called; the same for a relay binding and a task whose cwd resolves to a different agent. The
  agent's own linked worktree and own managed workspace pass. A task and a relay binding for an agent
  configured `workspace.mode: 'none'` run at `DEFAULT_CWD` and pass, with identity from the home; the
  same agent at `DEFAULT_CWD` with binding `home` is refused. With `DEFAULT_CWD` equal to another
  registered agent's home (the dev-checkout fallback), the `none` agent's task is refused
  `DESK_NOT_OWN` at step 2. The rung-to-binding mapping is tested for all four outcomes, including
  `default` with and without a boundary `degraded` reason.
- **Restart (T4).** A room turn queued behind a running turn is in memory only; after a simulated
  restart nothing re-runs it through queue adoption, and no `runtime.sendMessage` happens without
  that turn's grants and `forAgent` (§5.10).
- **Resolver hardening (T1).** A hand-written `.git` file pointing into another agent's repo's
  `worktrees/<name>` gitdir (no matching backlink) → `none`; a submodule `.git` file (no `commondir`)
  → `none`; `git worktree remove` then `git worktree add` of a different repo at the same path → the
  new owner, not the memoized old one.
- **Queued forwarding (T1, T2, T5).** A room turn queued behind a running turn on the same session
  reaches `runtime.sendMessage` with its `forAgent` (T1), its `additionalDirectories` (T2) and its
  `prepareLaunch` result (T4) — each field removed from the whitelist or the launch spread fails its
  test.
- **Canvas (T4).** An absolute source path inside the worktree → `worktree` label with ahead count;
  inside `repo/` → `room-main`; elsewhere → `agent-cwd`.
- **Legacy plumbing (T4).** A worktree with an unmodified seeded `SKILL.md`, a projection symlink and an
  old attachment projection → all removed, tree clean, block removed when it was the last; a modified
  `SKILL.md` and a real file at a projection path → kept, block kept.
- **Refresh (T5).** Each `held` reason red-before/green-after: untracked file only; staged change;
  one commit ahead; detached `HEAD`; another branch checked out. **An ignored file at a path `main`
  now tracks** (e.g. `notes.log` ignored in the worktree, then committed on `main`) → `held: changes`
  and the file's bytes are unchanged; the same for an untracked file at a parent-folder path.
  `current` when at tip. `refreshed` moves exactly to the captured tip even if `main` advances after
  step 1. **Two-directional overlap:** ignored `build/keep.txt` under a `build/` rule, then `main`
  commits a tracked file `build` and drops the rule → `held: changes` and `build/keep.txt` still
  exists. **Busy:** the (room, agent) has two bound sessions (the room turn's own, and a second one a
  person app-resumed); while a turn runs on the second, a room turn launched on the first answers
  `held: busy` with zero git calls, and refreshes once the second has settled. (A turn on the SAME
  session never overlaps: the room turn only launches after it settles.) **Lossy `inFlight`:** a turn
  on the second session launched with its queue budget exhausted (holding the runtime lock with no
  `inFlight` entry) still makes the refresh answer `held: busy`. The refresh runs at launch, not at placement: a turn placed
  while `main` is at A and launched after `main` moved to B lands on B. Baselines forgotten for moved
  paths only.
- **Heads-up (T5).** With `--first-parent`, a merge of a 12-commit agent branch is one listed commit;
  merge and person commits classified and named from their room entries; a hand commit is `other`
  ("someone"); two people signed in under login are named apart even though neither is the operator;
  caps and "and N more"; overlap from committed-ahead and working-tree changes; subjects and paths
  inside the fence.
- **File ops (T6).** Each route: happy path is one commit authored as the person with the pinned
  subject; `PEOPLE_ONLY` for an agent caller; `FILE_CHANGED` when a locked path moved; `ROOM_FILE_EXISTS`;
  caps; `.git` paths; a symlink on disk; `MAIN_CHECKOUT_DIRTY`; case collisions per segment
  (`Notes/plan.md` when `notes/` exists is refused naming `notes/`, for save, upload, move and
  from-attachment); commit author is the signed-in person with login on and the operator with login
  off; upload temp folder is removed after success and after failure; queued behind a running merge;
  multi-file rollback leaves `main` and `repo/` unchanged; save creates parents; a parent that is a
  file is refused; an attachment from another room is 404.
- **Room entry (T6).** A path containing `</room_context>` and markdown renders inert in the app and
  inside the fence in the context. One entry per commit, `mentions: []`, no dispatch (cascade-guard assertion as
  for merges), text pinned per kind; the existing save now posts one.

### Conformance (T2)

The §4.6 case, on claude-code (mocked CLI, warm session asserted), codex (mocked SDK) and opencode
(mocked client); test-mode declares its reason. Live legs declare reasons exactly as the append case
does.

### Integration (T4, T5)

Real git, `FakeAgentRuntime` + `@dorkos/test-utils` scenarios: enable a repo → two agents take turns →
each turn's `sendMessage` has `cwd` = its home and the three grants → agent A (scenario) commits in its
worktree and merges → agent B's next turn finds its clean worktree fast-forwarded and the context says
so → B, with an uncommitted change to the same file, is held and told about the overlap → a person
edits `ROOM.md` → one quiet entry, no turn triggered, the next turn's heads-up names the person.

### Migration (T3, wired in T4)

A fixture config dir with transcripts under two worktree slugs (one registered agent, one not) and a
colliding destination → moved, skipped, and the colliding source renamed `.jsonl.conflict` and named
in the log and marker (the frontier indexes exactly one transcript for that id); marker written; second run is a no-op.
The live resume check in §8.1.

### Browser (T7)

`apps/e2e`: upload two files by drag, rename one, delete a folder through the confirm, edit a `.ts`
file, save an attachment to the room's files; each shows its room entry and refreshes the tree. Before
pushing, grep `apps/e2e` for the old "markdown only" copy.

## 12. Docs and skills to update (by task)

| File                                                                                | What changes                                                                                                  | Task                                      |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `packages/operating-skills/src/skills/working-in-room-repos.ts` (+ pack references) | §5.5                                                                                                          | T4                                        |
| `contributing/room-repos.md`                                                        | cwd rung section, "server never mutates a worktree", DOR-1640 seeding section, reap gate 1 reason, new routes | T4 (placement), T5 (refresh), T6 (routes) |
| `contributing/adding-a-runtime.md`                                                  | the grant option and its conformance case                                                                     | T2                                        |
| `apps/server/src/services/runtimes/opencode/NOTES.md`                               | `external_directory` is now granted per session; which mechanism won                                          | T2                                        |
| `docs/concepts/rooms.mdx` (`:27-45` and "Files a room owns")                        | where an agent works in a room with files; the read-only limit; people's file operations; turn-start refresh  | T8                                        |
| `specs/project-rooms/02-specification.md` §3.4/3.5/3.7/3.8                          | amendment notes (done in this spec's PR)                                                                      | —                                         |
| ADR statuses                                                                        | §8.2                                                                                                          | T8                                        |

## 13. Risks

- **Claude settings-form grants may not grant access under the SDK** (§4.2 gate). Retired: the gate
  passed in T2, so `--add-dir` is not used and I11 holds.
- **Codex commits in a linked worktree** need `repo/.git` writable; granting it is the design, but it
  has only been reasoned, not run. A live codex room turn that commits is part of T4's dogfood check.
- **OpenCode session rules vs sidecar `ask`.** Settled in T2: session rules grant but only append
  and never matched edits, so the ask handler is what shipped (§4.4). Its residual: a refused tool
  call can end an OpenCode turn.
- **Agents writing into their home by mistake** when they mean the room's copy. The context block and
  skill carry exact paths; an eval case in `packages/evals` (room turn edits a room file) is added in T4
  and must join the policed tier array.
- **Transcript resume across a desk change** is measured, not assumed (§8.1).
- **The refresh is the server writing into a worktree** — narrow, and every precondition has a
  negative test, including the ignored-file case git itself does not protect; still the one place
  I6's exception lives. It depends on the dispatcher answering "is any session bound to this (room,
  agent) busy" truthfully; that read is pinned by the busy test.
- **The home has several writers.** Before this spec, room turns across rooms stood in separate
  worktrees; now every room turn of an agent stands in its home, up to
  `rooms.maxConcurrentTurnsPerAgent` (default 3) at once, beside a person's direct session there — and
  the spec invites a room turn to change the agent's own code. Two turns editing one checkout is the
  DOR-500 interleaving. Mitigations: the skill rule that own-code changes happen in a private worktree
  of the agent's repo (§5.5), the concurrency cap kept as it is, and room files reached only through
  the per-agent worktree. The residual — an agent ignoring the rule — is real and is the same exposure
  a person running two sessions in one folder has today. A mechanical guard (a per-home write lease)
  is a follow-up, not in this programme.
- **Relay and task dispatch gain the desk guard**; a misconfigured `managed` binding that used to run
  unattributed now refuses loudly. That is intended and is called out in the T4 changelog fragment.
