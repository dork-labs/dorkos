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

Spec: `specs/project-rooms/02-specification.md`, amended by `specs/agent-home-desk/` (room turns
stand at home). Decisions: `260829-115621`, `260829-115622`, `260829-115623`, `260829-115625`,
`260829-115626`, `260926-172251`, `260926-180223`.

## Key Files

| Concept                              | Location                                                            |
| ------------------------------------ | ------------------------------------------------------------------- |
| Sidecar schema, caps, mode union     | `packages/shared/src/room-repo.ts`                                  |
| Files API request/response schemas   | `packages/shared/src/room-files.ts`                                 |
| Enable / repair / home lifecycle     | `apps/server/src/services/rooms/repo/room-repo-service.ts`          |
| Sidecar + cache store (file-first)   | `apps/server/src/services/rooms/repo/room-repo-store.ts`            |
| Cache reconciler (5-min sweep)       | `apps/server/src/services/rooms/repo/room-repo-reconciler.ts`       |
| All raw git, hardened                | `apps/server/src/services/rooms/repo/room-repo-git.ts`              |
| Per-room serialized write queue      | `apps/server/src/services/rooms/repo/room-repo-mutex.ts`            |
| Worktree create / status / reap      | `apps/server/src/services/rooms/repo/room-worktree-manager.ts`      |
| Merge contract + `room_repo_status`  | `apps/server/src/services/rooms/repo/room-merge-service.ts`         |
| Read-only listing and file content   | `apps/server/src/services/rooms/repo/room-files.ts`                 |
| People's file operations             | `apps/server/src/services/rooms/repo/room-file-editor.ts`           |
| Change sets: checks, commit, undo    | `apps/server/src/services/rooms/repo/room-file-ops.ts`              |
| A person's change → room entry text  | `apps/server/src/services/rooms/repo/room-file-change-text.ts`      |
| Dirty-main detection                 | `apps/server/src/services/rooms/repo/room-main-checkout.ts`         |
| `ROOM.md` → prompt block             | `apps/server/src/services/rooms/repo/room-conventions.ts`           |
| `ROOM.md` seed template              | `apps/server/src/services/rooms/repo/room-md.ts`                    |
| Live config reader                   | `apps/server/src/services/rooms/repo/room-repo-config.ts`           |
| HTTP routes                          | `apps/server/src/routes/rooms.ts`                                   |
| Refusal → HTTP status map            | `apps/server/src/routes/room-error-response.ts`                     |
| Agent tools (`rooms` domain)         | `apps/server/src/services/rooms/room-capabilities.ts`               |
| Where a room turn stands, its grants | `apps/server/src/services/rooms/repo/room-turn-place.ts`            |
| App-resumed room session placement   | `apps/server/src/services/workspace/room-session-place.ts`          |
| Context-block files section          | `apps/server/src/services/runtimes/shared/room-context-block.ts`    |
| Unified explorer (sessions + rooms)  | `apps/client/src/layers/features/file-explorer/`                    |
| Agent-facing how-to                  | `packages/operating-skills/src/skills/working-in-room-repos.ts`     |
| Cache table + migration              | `packages/db/src/schema/rooms.ts`, `packages/db/drizzle/0081_*.sql` |
| Config schema                        | `packages/shared/src/config-schema.ts` (`rooms.repo`)               |

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

| Tree                       | Writer                                    | How                                                        |
| -------------------------- | ----------------------------------------- | ---------------------------------------------------------- |
| `repo/` (integration tree) | The server, and only the server           | `merge_to_room_main`, `.../files/*` writes, enable, repair |
| `worktrees/<agentSlug>/`   | That one agent, and only during its turns | Full paths and `git -C`, through its folder grant          |
| Any other agent's worktree | Nobody                                    | There is no code path                                      |

This is DOR-500 applied to rooms. Every write to `repo/` goes through `RoomRepoMutex.run(roomId, …)`,
so merges, human saves, enable, and repair are serialized against each other per room.

**The server writes a worktree only to retire what older releases put there** (below) — and spec
task T5 adds a fast-forward when that cannot lose anything. Syncing is otherwise the agent's own act,
in its own turn, and is plain `git -C <copy> merge main` rather than a tool.

## When to use what

| You need to…                    | Use                                       | Why                                                               |
| ------------------------------- | ----------------------------------------- | ----------------------------------------------------------------- |
| Read a room's files server-side | `RoomFilesService.list` / `.read`         | Reads a commit, not the checkout, so in-flight state is invisible |
| Let an agent land work          | `merge_to_room_main` → `RoomMergeService` | The only agent write path; validated and serialized               |
| Let a person change files       | `PUT`/`POST /api/rooms/:id/files/*`       | One commit as the person, per-path lock, one quiet room entry     |
| Know if a room has files        | `RoomRepoService.hasRepo(roomId)`         | One predicate over "never enabled" and "switched off"             |
| Decide where a room turn runs   | `resolveRoomTurnPlace` at **dispatch**    | Always the home; grants and the files section come with it        |
| Compose the `ROOM.md` block     | `RoomConventions.compose`                 | Reads `main:ROOM.md`, caches on `(roomId, commitSha)`             |
| Add a new git command           | `room-repo-git.ts`                        | One hardened environment; nothing spawns git anywhere else        |

## Where a room turn stands

A room turn stands in its agent's **home** — always (spec `agent-home-desk` §5.1, invariant I4). Its
persona, `SOUL.md`, `NOPE.md`, memory and skills are the ones it has everywhere, and it can change
its own code in the same turn it works on the room's files. `resolveRoomTurnPlace`
(`room-turn-place.ts`) answers, at dispatch, before `buildRoomContext`:

- `cwd` — the agent's home;
- `additionalDirectories` — for a room with files, the per-turn folder grants below; none otherwise;
- `worktree` and `files` — the agent's copy of the room's files, and what the context block says
  about it.

The grants are exactly what a commit and a `git merge main` in a linked worktree write, and no more:

| Folder                                  | Access  | Why                                       |
| --------------------------------------- | ------- | ----------------------------------------- |
| `<room>/worktrees/<slug>`               | `write` | the agent's own copy                      |
| `<room>/repo`                           | `read`  | reading `main` and everybody's files      |
| `<room>/repo/.git/objects`              | `write` | a commit writes its objects               |
| `<room>/repo/.git/refs/heads/room`      | `write` | …moves its `room/<slug>` branch           |
| `<room>/repo/.git/logs/refs/heads/room` | `write` | …and that branch's reflog                 |
| `<room>/repo/.git/worktrees/<slug>`     | `write` | …and the copy's own index, `HEAD` and log |

**Never all of `repo/.git`.** That would hand every agent the room's shared `hooks/`, `config` and
`info/`, which run for the other agents' commits and can name programs git executes, so a file tool
or a sandboxed shell in one agent's turn could plant code for another's commit. The server's own git
in a worktree is pinned to the room's storage (`GIT_DIR`/`GIT_COMMON_DIR`/`GIT_WORK_TREE`, set in
`room-repo-git.ts` from the layout), so a rewritten `.git` pointer or `commondir` in an
agent-writable folder cannot hand the server a config the agent wrote. A shell that is not sandboxed
can still write anywhere its permission mode allows; that limit is the user docs' too.

**The desk guard** (`assertOwnDesk`, spec §3.4) runs in the runner before the runtime is called: a
room turn whose cwd is not its agent's home is refused `DESK_NOT_OWN` and the room gets the ordinary
failure notice. Relay bindings and scheduled tasks run the same guard at their dispatch.

**Launch-time work** rides `DispatchMessageOpts.prepareLaunch`, which the dispatcher runs under the
session's write lock when the turn launches — never at placement or while it waits in the queue.
`roomTurnLaunchStep` builds it: nothing touches the copy while another session bound to the
(room, agent) has a turn in flight (`isTurnInFlight`, which reads the runtime's lock as well as the
dispatcher's slot). Today it retires legacy plumbing; T5 adds the refresh.

An app-resumed room session (`POST /api/sessions/:id/messages`) is placed the same way through
`resolveSessionCwdWithRoom`: the home, the room's agent as `forAgent`, and the same grants. A `cwd`
naming the agent's copy is replaced by the home; any other `cwd` must pass the desk guard or the
launch answers `409 DESK_NOT_OWN`. An OpenCode session created in the copy before room turns moved
home cannot move, so its launch answers `409 ROOM_SESSION_MOVED` and points the person back to the
room; its transcript stays readable. Independently, `dispatchSessionMessage` refuses any launch whose
folder is inside the rooms directory, and `getGitStatus` never runs git there — a room's shared git
settings are only read through `room-repo-git.ts`, which audits them first
(`ROOM_REPO_CONFIG_UNSAFE`).

## The merge contract

`RoomMergeService.merge` checks everything server-side and refuses with a specific code. Each code
implies its own remedy, which is why the operating skill can teach recovery without a person.

| Code                      | Meaning                                                                              | Agent's fix                               |
| ------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------- |
| `ROOM_REPOS_DISABLED`     | `rooms.repo.enabled` is off install-wide                                             | Ask the operator                          |
| `NOT_A_PROJECT_ROOM`      | This room has no repo                                                                | Nothing to do here                        |
| `UNCOMMITTED_WORK`        | The agent's worktree is dirty                                                        | Commit, then retry                        |
| `BEHIND_MAIN`             | Branch does not contain main's tip (answer says how far)                             | `git merge main`, resolve, retry          |
| `NOTHING_TO_MERGE`        | Branch is level with main                                                            | Nothing to do                             |
| `SYMLINK_ESCAPES_REPO`    | A symlink targets outside the repo                                                   | Publish-on-change: copy and commit        |
| `SUBMODULE_NOT_ALLOWED`   | The delta adds a submodule                                                           | Vendor the content instead                |
| `ROOM_REPO_CONFIG_UNSAFE` | The room's shared git settings name a program (a filter, driver, include, hook path) | Ask the operator to remove the named keys |
| `FILE_TOO_LARGE`          | One file over `maxFileBytes` (named)                                                 | Use an attachment                         |
| `REPO_CAP_EXCEEDED`       | Repo would pass `maxRepoBytes`                                                       | Prune, or raise the cap (owner-only)      |
| `MAIN_CHECKOUT_DIRTY`     | Somebody edited `repo/` out of band                                                  | Operator repair, then retry               |
| `MERGE_IN_FLIGHT`         | Waited out `mergeQueueWaitMs`                                                        | Retry (HTTP answers `429`)                |
| `MERGE_CONFLICT`          | Unreachable through the ordinary path                                                | Kept for a hand-committed tree            |

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

## People's file operations and dirty-main repair

A person changes a room's files through five routes (spec `agent-home-desk` §7.1). Each is one
commit on `main`, through the same mutex merges use, after `assertMainCheckoutReady`:

| Route                                       | Body                                                       | Commit subject               |
| ------------------------------------------- | ---------------------------------------------------------- | ---------------------------- |
| `PUT /api/rooms/:id/files/content`          | `{ path, baseCommit, text }` (text only)                   | `Edit <path>` / `Add <path>` |
| `POST /api/rooms/:id/files/upload`          | multipart `files[]` (≤ 20), `dir`, `baseCommit`, `replace` | `Upload N files to <dir>/`¹  |
| `POST /api/rooms/:id/files/move`            | `{ from, to, baseCommit }`, file or folder                 | `Rename <from> to <to>`      |
| `POST /api/rooms/:id/files/delete`          | `{ path, baseCommit }`, file or folder                     | `Delete <path>`              |
| `POST /api/rooms/:id/files/from-attachment` | `{ attachmentId, dir, name?, baseCommit }`                 | `Add <path> from the chat`   |

¹ `Upload N files to the top folder` for the root; the room entry says "the top folder" too.
`baseCommit` is required for move and delete — nobody moves or deletes files they have not seen.

- **People only.** An agent is refused `PEOPLE_ONLY` (403), not 404: it is already a visible member,
  and merging is its write path. An upload is refused before multer reads a byte.
- **Optimistic locking is per path**, not on `main` moving. `409 FILE_CHANGED` fires only when a
  path the change touches moved — the file a save or a replacing upload names, every file under a
  moved or deleted folder — and carries `{ path, commit, lastCommit }` so the client can name who
  won and offer reload-or-overwrite. A new path that already exists is `409 ROOM_FILE_EXISTS`,
  naming it; an upload overwrites only the names listed in `replace`.
- **Authored as the person.** With login on, the signed-in person's display name and
  `person-<authorId>@dorkos.local`; with login off, the operator. `gitAuthorName` falls back to
  `DorkOS operator` for a name git refuses (`<>`, `"`, empty). Names shown anywhere come from the
  room entry, never from git.
- **One quiet entry per commit.** `RoomService.postFileChangeEvent` posts `body.fileChange` in the
  room's own voice with `mentions: []` and a spent cascade, so it wakes nobody (I10). Its `text` is
  built from sanitized path segments, each path set in a markdown code span (`codeSpan`, backtick-
  safe), because the app draws post text as markdown; clients render `fileChange.paths` as plain
  text.
- **Every change is a change set** (`room-file-ops.ts`): a list of `{ path, content | null }` written
  (removals first, so a case-only rename works on APFS), staged by exact `:(literal)` path and
  committed once — or rolled back entirely. A rollback removes only files and folders the set
  itself created; a "new" path that already exists on disk (another spelling of a real file) is
  refused `ROOM_FILE_EXISTS` before anything is written.
- **Missing folders are created; a case clash is refused per folder segment.** `Notes/plan.md` when
  `notes/` exists names `notes/`, because APFS and NTFS would write into `notes/` while git records
  `Notes/`. A folder segment that is a file is `ROOM_FILE_PATH_INVALID`.
- **Unicode spellings resolve to the tree's.** `RoomTreeIndex.canonicalize` maps each segment that
  equals an existing name once both are NFC onto that name, and a new segment to NFC (what git with
  `core.precomposeunicode` records). An NFD `café.md` therefore finds the NFC `café.md` the tree
  holds — it meets the lock and `ROOM_FILE_EXISTS` — instead of silently overwriting it on APFS.
- **Every `.git` door is refused** (`assertWritablePath`): any case, trailing dots and spaces,
  HFS-ignorable characters, `git~<digit>`, and any colon at all (NTFS streams such as
  `.git::$INDEX_ALLOCATION`).
- **Uploads use multer disk storage** in a per-request folder under `<dorkHome>/.temp/room-uploads/`,
  capped per file at the room's frozen `maxFileBytes`, removed before the response is sent.
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
`room/<agentSlug>` at the first room turn placed in a project room. Nothing is written into it: the
agent's pack and instructions are in its home, where the turn stands. The worktree is standing: it
persists across turns, and uncommitted work survives.

**Legacy plumbing.** Releases that stood room turns in the worktree seeded the Operating DorkOS pack
there (DOR-1640), projected `.claude/skills/` links, a harness manifest and a `.claude/CLAUDE.md`
scaffold, and projected attachments under `.dork/.temp/room-attachments/` — all hidden by a marker
block in the repo's shared `info/exclude`. `retireLegacyPlumbing` removes them once per worktree per
process, at the worktree's next turn launch and only when no bound session is busy: an untracked,
block-hidden file is deleted only when DorkOS provably wrote it (an unmodified seeded skill, a link
into the pack or the agent's home, the scaffolds byte for byte, anything under the attachment
folder). Anything else is somebody's own file and stays. The block goes only when no worktree of the
repo still holds an untracked file it hides — removing it earlier would make that tree read dirty,
never reaped and never mergeable.

`reapRoom` removes one only when **four independent gates agree**:

1. The agent is not mid-turn (`busyAgentPaths`). A live turn is granted that worktree and works on
   it by path.
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

// ❌ Granting a room turn all of the room's git storage.
grants.push({ path: path.join(repo, '.git'), access: 'write' });
// ✅ roomTurnGrants: objects, the room branch refs and reflogs, the copy's own
//    admin folder. Never the shared hooks, config or info.

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
- `contributing/harness-sync.md` — what runs in an agent's home at create and after a sync.
- `specs/agent-home-desk/02-specification.md` — home, desk and shared folders.
- `specs/channel-workspace/` — superseded by `project-rooms`; read its supersession note for what
  carried over.
