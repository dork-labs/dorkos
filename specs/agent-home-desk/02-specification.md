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
19 decisions made under delegation. Not re-litigated here.
**ADRs:** [260926-172251](../../decisions/260926-172251-an-agents-identity-comes-from-its-home-and-its-desk-is-its-home-or-a-private-copy.md)
(home, desk, grants), [260926-172252](../../decisions/260926-172252-people-change-a-rooms-files-through-the-server-and-agents-are-refreshed-at-turn-start.md)
(people's file operations, turn-start refresh).
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
- **I3 — The desk rule.** A turn dispatched as a named agent (room, relay binding, task) runs with
  `cwd` equal to that agent's home, or a folder that resolves to that same home through §3's resolver.
  Otherwise the turn is refused `DESK_NOT_OWN` before the runtime is called (DOR-2356).
- **I4 — Room turns stand at home.** A project-room turn's `cwd` is the agent's home. It is never a
  room worktree, never `repo/`, never another agent's home.
- **I5 — Grants are exact and per turn.** A turn is granted exactly the folders its dispatcher
  computed for it. A grant from an earlier turn in the same session is not handed to a later turn that
  does not carry it.
- **I6 — One writer per room tree.** `repo/` is written only by the server. A room worktree is written
  only by its agent's turns and, between turns under that agent's claim, by the §6 fast-forward.
- **I7 — The refresh cannot lose work.** The server moves a worktree only when it is on its own branch,
  has no tracked or untracked changes, and has no commits `main` lacks; it only fast-forwards; it never
  runs during that agent's turn.
- **I8 — Files never change during a turn.** The refresh happens before the room context is built,
  at the same boundary where the `ROOM.md` pin advances (ADR 260829-115623).
- **I9 — People write through the server.** Every person change is one commit on `main`, authored as
  that person, behind the room's merge mutex, refused `PEOPLE_ONLY` for agents and `FILE_CHANGED` when
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
   a linked worktree). If it is a file `gitdir: <G>`, read `<G>/commondir` to get the common dir `C`;
   when `basename(C) === '.git'` the main worktree is `M = dirname(C)` (a bare repo answers `none`).
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

The result is memoized per `dir` for the life of the server instance, invalidated on mesh
register/unregister (`meshCore.onUnregister` and the register path) and on workspace-store writes.

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

`assertOwnDesk(forAgent: AgentHome, cwd: string)` in `agent-home.ts`: passes when `cwd === forAgent`
or `resolveAgentHome(cwd).home === forAgent`; otherwise throws `DeskNotOwnError` (`DESK_NOT_OWN`).
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

A nested grant is legal (the room's `repo/.git` inside `repo/`); where a backend's rules are
path-prefix denies, a `read` ancestor wins for file tools and only shell processes write inside it —
which is the intended outcome for `repo/.git` (§5.2).

Validation, in one place (`packages/shared/src/directory-grants.ts`, new, exported as
`@dorkos/shared/directory-grants`): absolute, normalized, no duplicates, not equal to or inside the
cwd, not `/` or the user's home directory itself. A runtime receiving an invalid set throws before
the backend is launched; the dispatcher is the only producer, so this is a programming error, not a
user-facing one.

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
- **Validation gate (blocks T2 merging).** One live claude-code run (no paid key needed beyond the
  operator's own sign-in) proves, in `default` permission mode: (a) `Read` and `Edit` inside a
  `write` grant proceed with no `canUseTool` call; (b) `Edit` inside a `read` grant is refused;
  (c) a `.claude/skills/probe/SKILL.md` inside a grant is absent from the session's reported skills;
  (d) a `CLAUDE.md` inside a grant is not loaded. If (a) fails, the adapter switches to
  `Options.additionalDirectories`, and if (c) then fails too, the spec is amended to record that
  room-committed skills load on claude-code (I11 downgraded honestly, with the docs saying so) —
  never silently.
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
the workspace in `read-only` and `workspace-write`. Under `danger-full-access` (bypass mode) nothing is
enforced — the same as today for everything else.

### 4.4 opencode

The sidecar config (`opencode/server-manager.ts:52`) stays as it is. Per session, before each prompt
whose grant set differs from the last one applied to that session, the adapter calls
`client.session.update({ body: { permission } })` with a `PermissionRuleset`
(`@opencode-ai/sdk` 1.18.30 v2 `types.gen.d.ts:58-63`, `SessionUpdateData.body.permission`):

```ts
[
  ...grants.flatMap((g) => [
    { permission: 'external_directory', pattern: g.path, action: 'allow' },
    { permission: 'external_directory', pattern: `${g.path}/**`, action: 'allow' },
  ]),
  ...grants
    .filter((g) => g.access === 'read')
    .map((g) => ({ permission: 'edit', pattern: `${g.path}/**`, action: 'deny' })),
];
```

New module `opencode/sessions/directory-grants.ts`; the call sits in the turn path after
`ensureSession` (`sessions/session-mapper.ts:478`). **Validation gate:** a mocked-client test proves
the ruleset is sent; one live free-model run (`DORKOS_OPENCODE_LIVE=1`, the free local smoke) proves
an external read inside a grant does not raise an `external_directory` ask. If session rules do not
override the sidecar's `ask`, the fallback is the adapter's existing ask handler
(`opencode/messaging/approvals.ts`): it answers `external_directory` asks for paths inside a grant
with `allow` and `edit` asks inside a `read` grant with `deny`. The fallback is recorded in
`opencode/NOTES.md` either way.

### 4.5 test-mode and the fake runtime

`runtimes/test-mode/test-mode-runtime.ts` declares `directoryGrantsUnprovenReason` (it has no backend).
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
options' `settings.permissions`; codex reads the mocked `startThread`/`resumeThread` options;
opencode reads the mocked `session.update` calls.

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
  refresh: WorktreeRefreshOutcome; // §6
}
```

For a project room: `ensureWorktree` (unchanged lazy creation, minus seeding and projection, §5.6),
then the §6 refresh, then grants:

| Grant                     | Access  | Why                                                                                               |
| ------------------------- | ------- | ------------------------------------------------------------------------------------------------- |
| `<room>/worktrees/<slug>` | `write` | The agent's own copy                                                                              |
| `<room>/repo`             | `read`  | Reading `main` and the room's other files                                                         |
| `<room>/repo/.git`        | `write` | A commit in a linked worktree writes objects, its index and its ref here (01-ideation decision 8) |

The dispatcher keeps its load-bearing order (spec project-rooms §3.5): place → refresh → build context
→ runner. `resolve-session-cwd.ts` loses the `room-worktree` rung (`:271`, `roomWorktree()`
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
not the room's). `OPERATING_SKILLS_VERSION` is bumped so the every-boot backfill reaches existing
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
the room turn's grants** (from `resolveRoomTurnPlace`, without the refresh — a person resuming is not
a room turn and holds no claim), and the message route passes them into `sendMessage`. An explicit
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
grant), the claim map and both busy ceilings keyed on `agentPath` (DOR-2359 is moot for rooms because
the key and the cwd are the same value again), the merge service and `room_repo_status`.

### 5.9 Legacy worktree plumbing (T4)

Existing worktrees hold files the old code wrote: the seeded pack (`.agents/skills/<name>/SKILL.md`),
projection links (`.claude/skills/*`, `.agents/harness.manifest.json`, scaffolded `.claude/CLAUDE.md`)
and attachment projections (`.dork/.temp/room-attachments/`), all hidden by a marker block in the
repo's shared `info/exclude`. Removing the block would make every such worktree dirty (never reaped,
merges refused `UNCOMMITTED_WORK`). So, once per worktree per process, at the worktree's next turn
placement under its agent's claim (T4, `room-worktree-manager.ts` `retireLegacyPlumbing`):

- delete a seeded `SKILL.md` only when its bytes equal a pack version DorkOS shipped (the seeder's
  own manifest of hashes), a projection path only when it is a symlink into the agent's home or the
  pack, `.dork/.temp/room-attachments/` always (DorkOS-owned, rebuildable);
- anything else at those paths is a person's or agent's own file and is left alone;
- when no worktree of the repo still holds a DorkOS-written path, remove the marker block from
  `info/exclude`. Until then the block stays, frozen at its last contents.

## 6. Turn-start refresh and heads-up (T5)

### 6.1 The refresh

`apps/server/src/services/rooms/repo/room-worktree-refresh.ts` (new), called by
`resolveRoomTurnPlace` after `ensureWorktree`, under the turn's claim:

```ts
export type WorktreeRefreshOutcome =
  | { kind: 'current' } // already at main's tip, or just created
  | { kind: 'refreshed'; from: string; to: string; paths: string[] }
  | { kind: 'held'; reason: 'changes' | 'ahead' | 'off-branch' | 'unreadable'; moved: MainMoved };

export interface MainMoved {
  commits: {
    sha: string;
    author: string;
    subject: string;
    kind: 'merge' | 'person';
    files: string[];
  }[];
  overflow: number; // commits beyond the cap, for "and N more"
  overlap: string[]; // files changed on main since the branch point AND by this agent
}
```

Steps, each a git query under `--no-optional-locks` except the one write:

1. `HEAD` must be the symbolic ref `refs/heads/room/<slug>`; otherwise `held: off-branch`.
2. `git status --porcelain=v1 --untracked-files=all` must be empty; otherwise `held: changes`.
3. `git rev-list --count <mainTip>..HEAD` must be `0`; otherwise `held: ahead`.
4. Capture `mainTip = git rev-parse refs/heads/main` once; if `HEAD === mainTip`, `current`.
5. `git merge --ff-only <mainTip>` in the worktree (the only write). A failure answers `held:
unreadable` and logs; nothing else is attempted.

A refresh forgets diff baselines for the moved paths in every live session of this agent in this room
(`services/diff/edit-baseline.ts` gains `forget(sessionId, absPaths)`; I8 plus ADR 260711-142049's
first-touch-wins would otherwise report others' changes as the agent's).

### 6.2 What moved

For `held`, `MainMoved` is computed from `merge-base HEAD main`: commits on `main` after it (cap 8,
newest first), each classified `merge` (a merge commit made by the merge service) or `person` (a
person's commit from §7, recognised by the operator author email), with up to 8 files each; `overlap`
is the intersection of files changed on `main` since the base with files the agent changed (committed
ahead of the base plus working-tree changes). All git reads are bounded by the existing repo git
timeout.

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

Names and subjects render through `sanitizeIdentity` like every label outside the untrusted fence;
commit subjects are member-authored text and go inside the fence as untrusted content.

## 7. People's file operations (T6 server, T7 app)

### 7.1 Routes

All in `apps/server/src/routes/rooms.ts`, all `assertCanWriteFiles` (people only, room not archived,
`services/rooms/service/room-visibility.ts:353`), all serialized through `RoomRepoMutex.run` and
`assertMainCheckoutReady` first, all one commit authored as the person
(`room-file-editor.ts:377-384`), all refusing with the existing codes plus two new ones.

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
`assertNoLinkOnDisk`. Uploads and attachment copies may be binary (the editor stays text-only);
`assertText` applies only to the text save. Multer limits the upload to the room's frozen
`maxFileBytes` per file and 20 files, so the 1 MB JSON cap does not apply. A multi-file commit rolls
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

Agents see these in the room context like any system entry; the §6.2 heads-up also names them.

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

`apps/server/src/services/runtimes/claude-code/sessions/migrate-room-transcripts.ts` (new, built in
T3) runs at startup, before the room dispatcher starts, and only if its marker is absent. **T4 wires
it**, in the same PR that moves the desk: run while room turns still stood in worktrees, it would move
transcripts out from under the sessions resuming them.

1. For every room worktree folder on disk (`<dorkHome>/rooms/*/worktrees/*`), find its agent by the
   name's digest suffix against the registered agents (`digestFor(agentPath)`, the scheme
   `listWorktreesForAgent` already uses). Skip a worktree whose agent is not registered.
2. For every Claude config directory DorkOS launches with (the default and every account pin's
   directory, from `claude-config-dir.ts` and the accounts store), move
   `projects/<slug(worktree)>/<id>.jsonl` and its sibling `<id>/` folder to
   `projects/<slug(home)>/`. Same filesystem, so a rename. An existing destination is never
   overwritten; the source stays and is logged.
3. Write `<dorkHome>/migrations/agent-home-desk-transcripts.json` with counts and the frozen list of
   worktree folders it saw.

**Measured before T3 merges:** that a moved claude-code room session resumes with its history at the
home (live, operator sign-in), and — for codex (threads resumed by id) and opencode (sessions scoped
by directory) — whether a room session filed at the worktree is still listed and resumable at the
home. For any runtime where listing depends on the worktree folder, `extraDirs` is kept but fed from a
**frozen list** (the worktree folders that existed when the marker was written, stored in it), never
from the live manager. Where a runtime cannot resume at the new desk, the next turn of that (room,
agent) starts a fresh session and the old one stays listed; the room log carries the conversation
either way. The measurement result is written into this section in the T3 PR.

### 8.2 ADR status

T8 flips 260926-172251 and 260926-172252 to `accepted` once T4-T7 have shipped and the code matches.

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
  turns only, under the claim.
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
- **Grant validation (T2).** Relative, duplicate, cwd-equal, cwd-inside, `/`, user home → rejected.
- **claude-code mapping (T2).** `settings.permissions` merged with `fastMode`; `//` rule form;
  `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` stripped; fingerprint relaunch on a changed set, no
  relaunch on the same set in a different order.
- **codex / opencode mapping (T2).** `write` → `additionalDirectories`; `read` → nothing (codex);
  ruleset sent only when the set changes (opencode).
- **Room placement (T4).** A project-room turn: `cwd === agentPath`; grants exactly §5.1's three; a
  no-files room: no grants; files section rendered with the new copy (pinned).
- **Desk guard (T4).** A room turn whose computed cwd is another agent's home, a room worktree,
  `repo/`, or `DEFAULT_CWD` → `DESK_NOT_OWN`, the runtime's `sendMessage` never called; the same for a
  relay binding and a task whose cwd resolves to a different agent; the agent's own linked worktree
  and own managed workspace pass.
- **Canvas (T4).** An absolute source path inside the worktree → `worktree` label with ahead count;
  inside `repo/` → `room-main`; elsewhere → `agent-cwd`.
- **Legacy plumbing (T4).** A worktree with an unmodified seeded `SKILL.md`, a projection symlink and an
  old attachment projection → all removed, tree clean, block removed when it was the last; a modified
  `SKILL.md` and a real file at a projection path → kept, block kept.
- **Refresh (T5).** Each `held` reason red-before/green-after: untracked file only; staged change;
  one commit ahead; detached `HEAD`; another branch checked out. `current` when at tip. `refreshed`
  moves exactly to the captured tip even if `main` advances during the refresh. Never runs while the
  agent holds a live turn (claim asserted). Baselines forgotten for moved paths only.
- **Heads-up (T5).** Merge and person commits classified; caps and "and N more"; overlap from
  committed-ahead and working-tree changes; subjects inside the fence.
- **File ops (T6).** Each route: happy path is one commit authored as the person with the pinned
  subject; `PEOPLE_ONLY` for an agent caller; `FILE_CHANGED` when a locked path moved; `ROOM_FILE_EXISTS`;
  caps; `.git` paths; a symlink on disk; `MAIN_CHECKOUT_DIRTY`; queued behind a running merge;
  multi-file rollback leaves `main` and `repo/` unchanged; save creates parents; a parent that is a
  file is refused; an attachment from another room is 404.
- **Room entry (T6).** One entry per commit, `mentions: []`, no dispatch (cascade-guard assertion as
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
colliding destination → moved, skipped and kept as specified; marker written; second run is a no-op.
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

- **Claude settings-form grants may not grant access under the SDK** (§4.2 gate). Fallback costs I11 on
  claude-code if `--add-dir` loads skills; the spec says so rather than hiding it.
- **Codex commits in a linked worktree** need `repo/.git` writable; granting it is the design, but it
  has only been reasoned, not run. A live codex room turn that commits is part of T4's dogfood check.
- **OpenCode session rules vs sidecar `ask`** precedence is unverified; the ask-handler fallback is
  specified.
- **Agents writing into their home by mistake** when they mean the room's copy. The context block and
  skill carry exact paths; an eval case in `packages/evals` (room turn edits a room file) is added in T4
  and must join the policed tier array.
- **Transcript resume across a desk change** is measured, not assumed (§8.1).
- **The refresh is the server writing into a worktree** — narrow, and every precondition has a
  negative test; still the one place I6's exception lives.
- **Relay and task dispatch gain the desk guard**; a misconfigured `managed` binding that used to run
  unattributed now refuses loudly. That is intended and is called out in the T4 changelog fragment.
