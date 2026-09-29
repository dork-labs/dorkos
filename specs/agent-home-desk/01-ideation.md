---
slug: agent-home-desk
id: 260926-172253
created: 2026-09-26
status: implemented
---

# Home, desk and shared folders — decision record

**Tracker:** DOR-2355 (also closes DOR-2356, makes DOR-2359 moot for rooms, retires the DOR-1640
patch)
**Author:** Claude (spec author), direction approved by Dorian on 2026-09-26; remaining decisions
delegated and recorded below.
**ADRs:** [260926-172251](../../decisions/260926-172251-an-agents-identity-comes-from-its-home-and-its-desk-is-its-home-or-a-private-copy.md),
[260926-180223](../../decisions/260926-180223-a-turn-reaches-shared-folders-through-per-turn-grants-on-the-runtime-port.md),
[260926-172252](../../decisions/260926-172252-people-change-a-rooms-files-through-the-server.md),
[260926-180308](../../decisions/260926-180308-a-clean-room-worktree-is-fast-forwarded-when-its-agents-turn-launches.md)

This is a short ideation: the direction was settled with the operator before it was written. The
specification is [02-specification.md](02-specification.md).

## The rule

> An agent always knows who it is from its **home**, and never stands in someone else's folder.

| Idea               | Meaning                                                                                                                          | Can change?                                                          |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **Home**           | The registered folder holding `.dork/agent.json` (identity, `SOUL.md`, `NOPE.md`, memory, tool groups, account pin, skills pack) | Never. The only place DorkOS reads identity-bearing config from.     |
| **Desk**           | The folder a turn runs in                                                                                                        | Home by default; may be a private copy of the agent's own home repo. |
| **Shared folders** | Places a turn can reach without standing in them                                                                                 | Granted per turn.                                                    |

## Why not "the working directory never changes"

About 20 of 35 agents live at a repo root (`dorkos/.dork/agent.json` is committed). Git, pnpm,
lefthook, `CLAUDE.md`, `.claude/settings.json` hooks and per-worktree ports all act on the working
directory, so coding in a worktree needs the worktree as the desk. The bug class is DorkOS using the
working directory as the identity **key** — and every worktree of a repo agent carries a committed
copy of `.dork/` that must never count.

## Decisions

Operator-approved (2026-09-26):

1. A project-room turn's desk is the agent's home. Its room worktree is granted `write`, the room's
   integration tree `repo/` is granted `read`. The worktree is still created lazily and still has one
   writer.
2. The `AgentRuntime` port gains per-turn `additionalDirectories: { path, access }[]`, implemented on
   all three runtimes and gated by `runtimeConformance`. ADR 260807-233816's cost objection is
   accepted as the price.
3. People can edit any text file, create, upload, rename and delete files, and save a chat attachment
   into the room's files — each one commit authored as the person, each posting a quiet room entry
   that wakes nobody.
4. At turn start, a clean worktree with nothing ahead of `main` is fast-forwarded; otherwise the turn
   is told what moved and which of its own files overlap.
5. Worksessions (DOR-2161) fit the rule as-is; comment there, don't build.

Decided by the spec author under delegation (reasons in the spec):

6. **Claude read-only is `settings.permissions` deny rules, and grants go through
   `settings.permissions.additionalDirectories`, not `--add-dir`.** The settings form loads neither
   skills nor rules from the granted folder, so room-authored skills cannot enter the agent's tool
   layer unlabelled. `--add-dir` is the fallback only if the settings form does not grant access
   under the SDK (a validation gate in T2).
7. **Skills committed to a room repo are not loaded by any harness.** `ROOM.md` stays the room's one
   instruction channel, labelled with its provenance. Ideation decision 13 of `project-rooms` is
   retired.
8. **The repo's shared git directory (`repo/.git`) is granted `write`** alongside the worktree,
   because a commit in a linked worktree writes objects and refs there. The limit is stated honestly:
   a shell can move `main`'s ref by hand on every runtime, today as before; `MAIN_CHECKOUT_DIRTY`
   catches it.
9. **A linked git worktree of a registered home resolves to that home** (only with git's own
   backlink intact, so a hand-written `.git` pointer claims nothing) (by the `.git` file and the
   common directory, no `git` process), and so does a `managed` workspace whose recorded owner is the
   agent — even when its source is another repo, because an operator bound it to that agent by name.
   Nothing else does.
10. **The desk guard applies to turns dispatched as a named agent** (room, relay binding, task). A
    session a person opens in a folder is "a session about a directory"; the guard does not apply.
    It refuses only another agent's home (or a copy of it) and any room folder: an agent configured
    `workspace.mode: 'none'` still runs at the operator's `DEFAULT_CWD`, with identity from its home
    (review round, orchestrator ruling).
11. **No `.dork/` exclusion in room worktrees.** `info/exclude` cannot hide a tracked file, and hiding
    an untracked `.dork/` would hide a person's work from the reap's dirty check. After this change a
    committed `.dork/` is just a file; negative tests prove it.
12. **Mesh refuses to register an agent under `<dorkHome>/rooms/`.** A room repo is never a home.
13. **Attachments are still projected**, now into the home again; a remote attachment store has no
    local path to grant.
14. **Existing claude-code room transcripts are moved** from worktree transcript folders to the home's
    folder at startup, so the next turn resumes them. Other runtimes are measured; any that lists by
    folder keeps a frozen legacy list instead of the live worktree list.
15. **Legacy worktree plumbing is cleaned exactly:** the seeded skill pack, projection links and old
    attachment projections that DorkOS wrote into existing worktrees are removed when unmodified, and
    the `info/exclude` block goes once no worktree in the repo needs it.
16. **"New folder" has no server route.** Git keeps no empty folders; the folder exists once its first
    file is saved, and saving creates missing parents. No placeholder file is committed.
17. **One room entry per person commit, no coalescing.** Noisy for frequent savers; coalescing would
    need entries that change after they were posted, which the room log never does.
18. **The refresh runs when the turn launches**, not when it is placed, and is skipped while any
    session bound to that (room, agent) has a turn running (an app-resumed turn holds no room claim).
    It also holds when an ignored or untracked file sits where the fast-forward would write, because
    git's fast-forward overwrites an ignored file silently (review round, orchestrator ruling). It
    forgets diff baselines for the paths it moved in that agent's room
    session, so the diff viewer never shows others' changes as the agent's.
19. **A person's commit is authored as the signed-in person** when login is on
    (`person-<authorId>@dorkos.local`, never a real address) and as the operator when it is off;
    every name the app or an agent sees comes from the room log, never from git.
20. **In a room, an agent changes its own code in a private worktree of its own repo**, never in its
    home checkout, because its other turns may be running there. A skill rule, not a mechanism; the
    per-agent concurrency cap stays.
21. **Four ADRs, one decision each:** identity and desk (172251), grants on the runtime port (180223),
    people's file operations (172252), the launch-time refresh (180308).
22. **Tasks are ordered so the agent-facing truth flips in one PR**: the desk change, the grants, the
    context block and the `working-in-room-repos` skill land together (T4).

## Out of scope

Presence in the Files panel ("Ana is editing plan.md"), "Open in my editor" private copies, linked
repos, `projectConfigRoot` for worktree desks (`specs/worktree-project-config-root/`), and building
worksessions or multi-repo projects (DOR-2029) — the port is shaped for the latter.
