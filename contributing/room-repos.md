# Room Repos

## Overview

A room can own a **git repo** under the DorkOS data directory: one integration tree the server
writes, one standing worktree per participating agent, and work merged back through a serialized,
server-mediated merge. This guide covers the mechanism, the merge contract, the write paths, and the
trust boundary. It is the internal companion to the user-facing
[`docs/concepts/rooms.mdx` → Files a room owns](../docs/concepts/rooms.mdx).

The whole feature is additive. A room with no repo behaves exactly as it did before in every path
this touches, and `config.rooms.repo.enabled = false` makes every surface behave that way for every
room.

Spec: `specs/project-rooms/02-specification.md`. Decisions: `260829-115621`, `260829-115622`,
`260829-115623`, `260829-115625`, `260829-115626`.

## Key Files

| Concept                             | Location                                                            |
| ----------------------------------- | ------------------------------------------------------------------- |
| Sidecar schema, caps, mode union    | `packages/shared/src/room-repo.ts`                                  |
| Files API request/response schemas  | `packages/shared/src/room-files.ts`                                 |
| Enable / repair / home lifecycle    | `apps/server/src/services/rooms/repo/room-repo-service.ts`          |
| Sidecar + cache store (file-first)  | `apps/server/src/services/rooms/repo/room-repo-store.ts`            |
| Cache reconciler (5-min sweep)      | `apps/server/src/services/rooms/repo/room-repo-reconciler.ts`       |
| All raw git, hardened               | `apps/server/src/services/rooms/repo/room-repo-git.ts`              |
| Per-room serialized write queue     | `apps/server/src/services/rooms/repo/room-repo-mutex.ts`            |
| Worktree create / status / reap     | `apps/server/src/services/rooms/repo/room-worktree-manager.ts`      |
| Merge contract + `room_repo_status` | `apps/server/src/services/rooms/repo/room-merge-service.ts`         |
| Read-only listing and file content  | `apps/server/src/services/rooms/repo/room-files.ts`                 |
| Human save path (commit-as-user)    | `apps/server/src/services/rooms/repo/room-file-editor.ts`           |
| Dirty-main detection                | `apps/server/src/services/rooms/repo/room-main-checkout.ts`         |
| `ROOM.md` → prompt block            | `apps/server/src/services/rooms/repo/room-conventions.ts`           |
| `ROOM.md` seed template             | `apps/server/src/services/rooms/repo/room-md.ts`                    |
| Live config reader                  | `apps/server/src/services/rooms/repo/room-repo-config.ts`           |
| HTTP routes                         | `apps/server/src/routes/rooms.ts`                                   |
| Refusal → HTTP status map           | `apps/server/src/routes/room-error-response.ts`                     |
| Agent tools (`rooms` domain)        | `apps/server/src/services/rooms/room-capabilities.ts`               |
| Turn cwd resolution                 | `apps/server/src/services/workspace/resolve-session-cwd.ts`         |
| Context-block files section         | `apps/server/src/services/runtimes/shared/room-context-block.ts`    |
| Unified explorer (sessions + rooms) | `apps/client/src/layers/features/file-explorer/`                    |
| Agent-facing how-to                 | `packages/operating-skills/src/skills/working-in-room-repos.ts`     |
| Cache table + migration             | `packages/db/src/schema/rooms.ts`, `packages/db/drizzle/0081_*.sql` |
| Config schema                       | `packages/shared/src/config-schema.ts` (`rooms.repo`)               |

## On-disk layout

```
{dorkHome}/rooms/<roomId>/
  room-repo.json          # file-first truth for the binding — OUTSIDE the repo
  attachments/            # existing blob store, unchanged
  repo/                   # the integration tree — the server's tree, nobody else's
  worktrees/<agentSlug>/  # standing per-(room, agent) worktrees, branch room/<agentSlug>
```

`room-repo.json` sits outside `repo/` so a repo can never rewrite its own grant, pin policy, or
caps. `room_repos` (`room_id` PK/FK, `mode`, `created_at`, `last_merge_seq`) is a **derived cache**
rebuilt from the sidecars by `RoomRepoReconciler`, the same relationship `agents` has to
`.dork/agent.json` (ADR-0043).

Ordering is load-bearing and pinned by tests in both directions:

- **Create:** sidecar first, then the row.
- **Delete:** row first, then the sidecar.

The sidecar is the last word either way, so an interrupted operation leaves a state the reconciler
heals rather than one where the truth vanished and a derived row is the only evidence.

An **orphaned sidecar** (room row gone, directory still there) is counted, logged, and left alone.
That directory holds the room's history, every agent's unmerged work, and its attachments. The
destructive half belongs on the delete path, where the intent is.

## Who may write what

| Tree                       | Writer                                    | How                                                           |
| -------------------------- | ----------------------------------------- | ------------------------------------------------------------- |
| `repo/` (integration tree) | The server, and only the server           | `merge_to_room_main`, `PUT .../files/content`, enable, repair |
| `worktrees/<agentSlug>/`   | That one agent, and only during its turns | Ordinary git and ordinary tools                               |
| Any other agent's worktree | Nobody                                    | There is no code path                                         |

This is DOR-500 applied to rooms. Every write to `repo/` goes through `RoomRepoMutex.run(roomId, …)`,
so merges, human saves, enable, and repair are serialized against each other per room.

**The server never mutates a worktree.** Syncing is the agent's own act, in its own turn, and is
plain `git merge main` rather than a tool.

## When to use what

| You need to…                    | Use                                       | Why                                                               |
| ------------------------------- | ----------------------------------------- | ----------------------------------------------------------------- |
| Read a room's files server-side | `RoomFilesService.list` / `.read`         | Reads a commit, not the checkout, so in-flight state is invisible |
| Let an agent land work          | `merge_to_room_main` → `RoomMergeService` | The only agent write path; validated and serialized               |
| Let a person save a file        | `PUT /api/rooms/:id/files/content`        | Commit-as-user with per-path optimistic locking                   |
| Know if a room has files        | `RoomRepoService.hasRepo(roomId)`         | One predicate over "never enabled" and "switched off"             |
| Decide where a room turn runs   | `resolveSessionCwd` at **turn dispatch**  | Context is built after cwd, and it names attachments by that path |
| Compose the `ROOM.md` block     | `RoomConventions.compose`                 | Reads `main:ROOM.md`, caches on `(roomId, commitSha)`             |
| Add a new git command           | `room-repo-git.ts`                        | One hardened environment; nothing spawns git anywhere else        |

## Turn cwd resolution

`resolve-session-cwd.ts` owns one precedence chain, first match wins:

1. explicit `cwd` on the request
2. **room worktree** — the session is a room turn and the room has a repo
3. the agent's `workspace` binding (`home` → agent path, `managed` → owned Workspace)
4. `DEFAULT_CWD`

**Resolution happens at turn dispatch, in `RoomTriggerDispatcher`, before `buildRoomContext`.** That
ordering is not incidental: the room context names each attachment by an absolute path anchored on
the turn's directory, and the runner then projects the bytes there (DOR-1266). A cwd decided after
the context was built would describe files the model cannot open.

**Rungs 3 and 4 are deliberately not wired for room turns.** A room request resolves on rung 2 or on
the agent's own directory and stops. Falling through would relocate every repo-less room turn
belonging to an agent that opted into `managed` or `none`, the latter into `DEFAULT_CWD`, which is
the shared tree every other agent writes in.

**Identity and files are two values from here down.** `agentPath` keeps carrying identity: it selects
the runtime, keys the claim map and both busy ceilings, and names the worktree. The resolved cwd is
only where the turn stands.

## The merge contract

`RoomMergeService.merge` checks everything server-side and refuses with a specific code. Each code
implies its own remedy, which is why the operating skill can teach recovery without a person.

| Code                    | Meaning                                                  | Agent's fix                          |
| ----------------------- | -------------------------------------------------------- | ------------------------------------ |
| `ROOM_REPOS_DISABLED`   | `rooms.repo.enabled` is off install-wide                 | Ask the operator                     |
| `NOT_A_PROJECT_ROOM`    | This room has no repo                                    | Nothing to do here                   |
| `UNCOMMITTED_WORK`      | The agent's worktree is dirty                            | Commit, then retry                   |
| `BEHIND_MAIN`           | Branch does not contain main's tip (answer says how far) | `git merge main`, resolve, retry     |
| `NOTHING_TO_MERGE`      | Branch is level with main                                | Nothing to do                        |
| `SYMLINK_ESCAPES_REPO`  | A symlink targets outside the repo                       | Publish-on-change: copy and commit   |
| `SUBMODULE_NOT_ALLOWED` | The delta adds a submodule                               | Vendor the content instead           |
| `FILE_TOO_LARGE`        | One file over `maxFileBytes` (named)                     | Use an attachment                    |
| `REPO_CAP_EXCEEDED`     | Repo would pass `maxRepoBytes`                           | Prune, or raise the cap (owner-only) |
| `MAIN_CHECKOUT_DIRTY`   | Somebody edited `repo/` out of band                      | Operator repair, then retry          |
| `MERGE_IN_FLIGHT`       | Waited out `mergeQueueWaitMs`                            | Retry (HTTP answers `429`)           |
| `MERGE_CONFLICT`        | Unreachable through the ordinary path                    | Kept for a hand-committed tree       |

On success: `git merge --no-ff room/<agentSlug>` in `repo/`, under the mutex, with the agent's
summary as the merge message. A failure mid-merge aborts cleanly (`git merge --abort`), so `main` is
never left conflicted. Then **one durable, unaddressed, system-voiced room entry**. It stores no
mentions and triggers no turn. `lastMergeSeq` advances and the explorer refreshes off the room
stream.

**The merge path keeps the two "no repo" reasons apart; the read routes fold them.** A merge
answers `ROOM_REPOS_DISABLED` or `NOT_A_PROJECT_ROOM`, because a member agent can act on the
difference. `GET /files` answers one `ROOM_HAS_NO_REPO` for both, deliberately, because there the
caller may be an outsider and the difference is information. Neither read route can return the
merge codes, and the merge tool can return neither `ROOM_HAS_NO_REPO` nor
`ROOM_REPO_GIT_UNAVAILABLE`.

`MERGE_IN_FLIGHT` is the one refusal here that is a `429` rather than a `409`, because it is the only
one that means "waited your turn" rather than "this state is wrong".

**History is append-only from every agent-reachable surface.** No tool, route, or MCP verb can
force-push, reset, or delete a branch. `room-repo-git.ts` does export `deleteMergedBranch`, but it
is called only by the reap, it passes no force flag, and git refuses it for a branch holding
unmerged commits — so it can retire a branch whose commits `main` already has and nothing else.
Adding a rewriting verb to that module would make this paragraph false; do not.

## The two agent verbs, and the one that is missing

| Tool                 | Capability id       | Tier      | Gate       |
| -------------------- | ------------------- | --------- | ---------- |
| `merge_to_room_main` | `rooms.merge`       | `act`     | Membership |
| `room_repo_status`   | `rooms.repo_status` | `observe` | Membership |

Enabling a repo is **not** an agent capability and must not become one. An agent that could give its
own room a repo would hand itself a writable working directory nobody granted: the confused-deputy
shape, same reasoning as `channel-workspace` §3.6's join rule.

**Name tools by their ending in any prompt copy.** Each runtime prefixes tool names differently, so
`room-context-block.ts` says "the tool whose name ends in `merge_to_room_main`". Pinned by
`apps/server/src/services/runtimes/claude-code/messaging/__tests__/context-tool-names.test.ts`.

## Reading files: the commit, never the checkout

`RoomFilesService` resolves everything against `main`'s commit.

```ts
// ✅ Reads the commit. A half-written agent edit, a merge in flight and a dirty
// main are all invisible; `.git` is unreachable because it is not in the tree.
await filesService.list(roomId, 'docs/');

// ❌ Never list or stat the working directory. It re-introduces every state
// the commit read exists to exclude, and puts `.git` back in reach.
await fs.readdir(path.join(repoDir, 'docs'));
```

Three details worth not rediscovering:

- **Provenance costs three git processes, not one per file.** One `git log --name-only` walk, scoped
  to the directory and newest-first, attributes every entry in a single pass. Pinned by a test that
  counts invocations.
- **The walk's records carry a per-call random nonce, not a fixed marker.** The stream interleaves
  DorkOS's commit fields with member-written _filenames_; a predictable marker lets a committer split
  the stream where they choose and steal a neighbour's provenance. Same reasoning as the per-turn
  nonce in `room-context-block.ts`.
- **Nothing rewrites a path.** A name with a trailing space or a doubled slash is refused with a
  reason, never trimmed into a different file's name. A visible dead end beats a quiet wrong answer.

The disclosure ordering in the routes is a control, not a style choice: **membership is asked first
and answers `404`**, and only then is "does this room have files" asked, which answers `409
ROOM_HAS_NO_REPO`. Reversed, a room id would leak which rooms are project rooms. Pinned by a test
asserting an outsider gets three identical answers for a room with files, a room without, and an
imaginary one.

## Human saves and dirty-main repair

`PUT /api/rooms/:id/files/content` carries `{ path, baseCommit, text }`.

- **People only.** An agent is refused `PEOPLE_ONLY` (403), not 404: it is already a visible member,
  and merging is its write path.
- **Optimistic locking is per path**, not on `main` moving. `409 FILE_CHANGED` fires only when main
  moved _and touched that path_, and the refusal carries `{ path, commit, lastCommit }` so the client
  can name who won and offer reload-or-overwrite.
- **One save is one commit**, authored as the person, through the same mutex merges use.
- The client editor is a **source** editor, not the session canvas. The canvas round-trips markdown
  through ProseMirror and would commit a reformat under a person's name that they never typed. Byte
  fidelity outranks editor reuse in a tree whose whole point is per-line provenance
  (`260829-115626`).

`assertMainCheckoutReady` runs before any server write. A dirty tree, or a tree on a branch other
than `main`, refuses `MAIN_CHECKOUT_DIRTY` and pauses merges and saves for that room.
`RoomRepoService.repairMainCheckout` is the only exit and takes exactly two shapes: `{ action:
'commit' }` (sweeps everything, committed as the operator) or `{ action: 'discard', paths: [...] }`
(1–500 paths, each of which must be a currently-reported stray). **DorkOS never moves a branch it
did not move.**

## `ROOM.md` delivery

- Composed by `RoomConventions.compose` from `git show main:ROOM.md`, cached on
  `(roomId, commitSha)`.
- Delivered on **`systemPromptAppend`**, after the DorkOS base append, so it rides the cacheable
  prefix (ADR-0273). Not `additionalContext`, and a test seeds that swap as a defect.
- **Resolved once at turn start and held for the whole turn.** A merge landing mid-answer takes
  effect at the next turn boundary (ADR `260711-142049`).
- Wrapped in `<dorkos_room_conventions room="…" commit="…">`, whose body states the advisory
  precedence: prohibitions are honoured, direct conflicts resolve to the agent's own instructions,
  and these came from the room's members rather than the operator.
- Over `maxRoomMdBytes` the **whole body** is replaced by a one-line notice naming the overage. Never
  truncated: half a rule reads like a whole one.
- A room with no repo gets no block.

The seam was a **gate, not an assumption**. `runtimeConformance` runs two turns on one session with
two different appends and reports what the _backend_ was handed each time, never the string the suite
passed in. All three runtimes pass, so no `additionalContext` fallback exists. A runtime that can
prove neither must declare `systemPromptAppendUnprovenReason` as a sentence rather than skip.

## Worktrees and the reap

`RoomWorktreeManager.ensureWorktree` lazily creates `worktrees/<agentSlug>/` on branch
`room/<agentSlug>` at the first room turn that resolves cwd for a project room, seeds the agent's
Operating DorkOS pack into it, and runs harness projection there. The worktree is standing: it
persists across turns, and uncommitted work survives.

**The pack is seeded into the WORKTREE, not just the agent's home** (DOR-1640). A turn's cwd is the
worktree and every harness resolves project-scoped skills against the cwd, so a pack that lives only
in `<agentDir>/` is unreachable from the one directory `working-in-room-repos` is about. Widening the
setting-source chain instead is not available: `settingSources` is a closed three-value enum whose
`user` slot is already spoken for by account pinning. Seeding runs before projection, which is what
reaches all three runtimes — codex and opencode read `.agents/skills/` natively, claude-code reads
the projected `.claude/skills/` links.

Two rules follow, and both are pinned by test:

- **The seeded paths are hidden in the repo's shared `info/exclude`, DERIVED from
  `OPERATING_SKILLS_PACK`.** A clean `git status` gates both the reap below and the §3.6 merge, so a
  hand-written list that falls one skill behind leaves every worktree in the install permanently
  dirty. Each entry names the one `SKILL.md` the seeder writes, never `.agents/skills/` — that
  directory is where the room authors skills of its own, and a room-authored skill sharing a pack
  name is preserved, never overwritten. The cost, accepted and documented at the constant: those
  seven names are reserved, so an UNCOMMITTED room-authored file at one of them is hidden from
  `git status` and goes with the tree when the reap takes it.
- **Seeding widened the projection, so the block covers its scaffolds too.** The projection used to
  return early without an `.agents/skills/`; now it always runs, and it writes more than skill
  symlinks — `planInstruction` scaffolds `.claude/CLAUDE.md` whenever the tree root has an
  `AGENTS.md`. That entry is obtained by running the planner, never spelled. Completeness is pinned
  by a test that runs the real planner over a created worktree and asks `git check-ignore` about
  every target, so a new engine target reddens without anybody remembering this page. A room that
  commits a manifest enabling other harnesses is outside the guarantee on purpose: `GEMINI.md` and
  friends are paths a person may author, so they stay visible (dirty ⇒ spared, never deleted).
  Narrow the room projection if that ever needs fixing; do not widen this block.
- **`repo/` is never seeded.** No turn runs in the integration tree, and its contents are the room's
  committed files.

Seeding at create alone would freeze a standing worktree on the pack it was born with, so the first
resolution after a restart re-seeds if `OPERATING_SKILLS_VERSION` moved — once per worktree per
process, since only a new binary can raise that constant. It refreshes the exclude block _before_
writing, or a worktree whose repo carries a pre-DOR-1640 block goes permanently dirty on upgrade.

`reapRoom` removes one only when **four independent gates agree**:

1. The agent is not mid-turn (`busyAgentPaths`). Since the cwd rung shipped, a live turn _runs in_
   that worktree.
2. It is not in `listStrandedWorktrees` — not dirty, not ahead of main, and readable by git.
3. Nothing in it was touched inside `worktreeReapDays` (default 14), read from `HEAD`'s committer
   date.
4. `git worktree remove` (no `--force`) and `git branch -d` (never `-D`) both succeed.

A tree whose branch survives because it holds unmerged commits reports `reapedTreeKeptBranch`, never
`reaped`. **Leaving a room does not remove anything.** The worktree outlives the membership until it
is clean, and is surfaced as stranded work in the meantime.

`worktreeReapDays` has `.min(1)` for a load-bearing reason: a zero would make a commit made this
minute reapable.

## Trust boundary

Read `specs/project-rooms/02-specification.md` §3.11 before changing anything here.

- **Permission posture is member-owned and unreachable from any room content**: permission mode,
  settings, capability tiers, standing grants. A room can never widen what an agent may do.
- **Nothing in a repo executes at sync or merge time.** `git init` runs with
  `-c init.templateDir=` so the machine's global template cannot seed hooks, and the server's own
  commits use `--no-verify` so a hook that arrived some other way does not decide whether they land.
  Git does not clone hooks.
- **Symlinks out of the repo are refused at merge**, never resolved. A committed symlink dangles on
  another machine, exposes one agent's private tree to every member, and bypasses commits,
  provenance and the merge queue. In-repo relative links are fine. The operating skill teaches
  publish-on-change.
- **Commit identities are stripped on the way in.** A worktree carries whatever `user.name` it was
  given, so control characters are removed at `commitAll` where the ambiguity is created, and the
  provenance parser also validates that a record's head really is a sha and a timestamp.
- **Previews render member-written content** and go through the same untrusted-text handling as
  message bodies. No HTML execution.
- **Injection-to-execution is named rather than hidden.** A room message or a repo file can try to
  steer an agent holding Bash. The mitigations are the fenced untrusted block with its per-turn
  nonce, the provenance-labelled conventions block, the operating skill's warning about
  run-this-script asks, and the fact that every gate below the instruction layer stays member-owned.
  Residual risk, stated in the user docs too: joining a shared room is trust in who can write to it.

## Config

`config.rooms.repo`, read live through `room-repo-config.ts`:

| Field              | Default | Write policy                      |
| ------------------ | ------- | --------------------------------- |
| `enabled`          | `true`  | Operator-only (`reach` stake)     |
| `worktreeReapDays` | `14`    | Operator-only                     |
| `maxFileBytes`     | 5 MB    | Operator-only (`resources` stake) |
| `maxRepoBytes`     | 500 MB  | Operator-only                     |
| `maxRoomMdBytes`   | 24 KB   | Operator-only                     |
| `mergeQueueWaitMs` | `30000` | Agent-writable                    |

**Two of the three caps freeze; one does not.** `maxFileBytes` and `maxRepoBytes` are **copied onto
each room's `room-repo.json` at creation**, so a room keeps the bounds it was made under and a later
config change cannot retroactively make existing contents illegal. Config seeds those two; the
sidecar remembers them. `maxRoomMdBytes` is read **live** every turn (`index.ts` wires
`RoomConventions`'s `maxRoomMdBytes()` to `readRoomRepoConfig()`, never to the sidecar), because it
bounds what a turn may carry rather than what a room may contain.

`enabled` plus the three caps are `PROTECTIVE_CARRYOVERS`: an off switch and three tightened ceilings
survive a config wipe. Full rationale in `contributing/configuration.md` § `rooms.repo`; the
user-facing table is `docs/getting-started/configuration.mdx` § Room files.

## Adding a git command

1. **Add it to `room-repo-git.ts`.** Nothing else in the codebase may spawn git for a room repo. One
   module means one environment: the ceiling dirs, the stripped `GIT_DIR` family, and the
   hooks/fsmonitor overrides apply to every command or to none.
2. **Pick `runGit` or `runGitRaw`.** `runGit` trims and decodes, which is right for porcelain and
   wrong for file bytes: it would drop a trailing newline somebody typed and turn a binary into
   mojibake. `runGitRaw` returns bytes.
3. **Do not add a history-rewriting verb.** No force-push, reset, or `branch -D`. If you believe you
   need one, the answer is somewhere else.
4. **Verify:** `pnpm vitest run apps/server/src/services/rooms/repo/__tests__/`.

## Anti-patterns

```ts
// ❌ Reading the working directory to answer a files question.
const entries = await fs.readdir(repoDir);
// ✅ Read the commit. Half-written edits and `.git` stay invisible.
const listing = await filesService.list(roomId);

// ❌ Repairing a caller's path so it resolves to something.
const clean = raw.trim().replace(/\/+/g, '/');
// ✅ Let normalizeRoomFilePath refuse it. It consults a trimmed copy only to
//    decide the refusal, and passes the caller's bytes through untouched:
//    `notes ` and `notes` are two files, and rewriting one into the other
//    serves a decoy under a `path` that names neither honestly.
//    Throws RoomError `ROOM_FILE_PATH_INVALID` with the reason.
const filePath = normalizeRoomFilePath(raw);

// ❌ Writing into an agent's worktree from the server.
await fs.writeFile(path.join(worktree, 'note.md'), text);
// ✅ Nothing. Syncing is the agent's own act, in its own turn.

// ❌ Asking "does this room have files" before asking "is the caller a member".
if (!repo.hasRepo(roomId)) return res.status(409)…
// ✅ Membership first (404), repo second (409). The order is a disclosure control.

// ❌ Truncating an over-cap ROOM.md.
block = body.slice(0, cap);
// ✅ Replace the whole body with a notice naming the overage.
```

## Testing

| Layer       | Where                                                                 |
| ----------- | --------------------------------------------------------------------- |
| Unit        | `apps/server/src/services/rooms/repo/__tests__/`                      |
| Routes      | `apps/server/src/routes/__tests__/` (room files, repo, repair, merge) |
| Conformance | `packages/test-utils/src/runtime-conformance.ts` (systemPromptAppend) |
| Migration   | `packages/db/src/__tests__/room-repos-migration.test.ts`              |
| Client      | `apps/client/src/layers/features/file-explorer/**/__tests__/`         |

Fixtures that build a real repo **disable git's auto-gc**: teardown once raced a detached `git gc`
(DOR-1603). The enclosing-repository trap is worth knowing too: with a `repo/` holding no `.git`, a
ceiling-less git walks up and serves the _enclosing_ repository's files as the room's, which is why
every command sets a ceiling and why the missing-repo case short-circuits before git runs.

## Troubleshooting

### `ROOM_REPO_GIT_UNAVAILABLE` on a machine that clearly has git

**Cause:** `execFile` reports a missing **cwd** as `ENOENT`, the same code a missing git binary has.
A room whose sidecar was written before its checkout existed (an interrupted enable) reaches it.
**Fix:** the guard now stats `repo/.git` as well as the binding and answers `ROOM_HAS_NO_REPO`
instead. If you see the git-unavailable code, git really is missing.

### Merges in one room all refuse `MAIN_CHECKOUT_DIRTY`

**Cause:** something wrote to `{dorkHome}/rooms/<id>/repo/` outside DorkOS, or left it on another
branch.
**Fix:** `POST /api/rooms/:id/repo/main/repair` with `{ action: 'commit' }` or `{ action: 'discard',
paths }`. A wrong branch is never moved for you; put it back on `main` yourself.

### A worktree that should have been reaped is still there

**Cause:** any one of the four gates said spare it. Most often the branch is ahead of `main`, or the
agent was mid-turn during the sweep.
**Fix:** `room_repo_status` (or `GET /api/rooms/:id/repo/status`) names what is being held. Nothing
holding work is ever removed by the sweep; that is by design.

### A changed `ROOM.md` did not reach an agent

**Cause:** the block is read from a commit and pinned per turn. An uncommitted edit in `repo/`
reaches nobody, and a merge landing mid-turn applies at the next turn boundary.
**Fix:** commit it, then wait for the agent's next turn. If it still does not arrive, check whether
the file is over `maxRoomMdBytes`, which sends a notice instead of the body.

## Related

- `docs/concepts/rooms.mdx` — the user-facing version of everything here.
- `contributing/configuration.md` § `rooms.repo` — the config verdicts in full.
- `contributing/workspace-manager.md` — the other checkout system, and why a room repo is not one.
- `contributing/harness-sync.md` — what runs in a worktree at create and after a sync.
- `specs/channel-workspace/` — superseded by `project-rooms`; read its supersession note for what
  carried over.
