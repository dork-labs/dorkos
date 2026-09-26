---
id: 260926-172252
title: People change a room's files through the server, and agents are refreshed at turn start
status: proposed
created: 2026-09-26
spec: agent-home-desk
superseded-by: null
amends: [260829-115626, 260829-115621]
---

# 260926-172252. People change a room's files through the server, and agents are refreshed at turn start

## Status

Proposed (spec `agent-home-desk`). It amends two accepted records, which stay `accepted`:

- **260829-115626** — extended, not reversed. Its write path (a request to the server, one commit to
  `main` authored as the person, behind the merge mutex, per-path optimistic locking, `PEOPLE_ONLY`)
  now covers every text file, new files, uploads, renames, deletes and saving a chat attachment into
  the room's files. Its Negative bullet "Editing is markdown-only today" is retired; binary files stay
  read-only in the editor.
- **260829-115621** — retires one sentence of its Decision: "The server never reaches into a
  worktree", and the matching Alternatives bullet ("The server syncing worktrees for agents"). The
  server now fast-forwards an agent's worktree between turns when that cannot lose anything. Pull-based
  propagation otherwise stands: a worktree with work in it is never touched.

## Context

A person can only edit markdown in a room's files today, one file at a time; they cannot add a file,
drop in a screenshot, rename, delete, or keep an attachment someone posted. The server already accepts
any text file on the save route (the markdown limit is client-only) but cannot create a folder, and a
person's save posts nothing into the room, so agents and other people never hear about it.

Agents, meanwhile, only see `main` move when they run `git merge main` themselves. An agent that has
done nothing in a room since the last merge still starts its next turn on old files, and the room
context only says "N commits behind" — not who changed what, and not whether the agent's own work
overlaps.

## Decision

We will give people the full set of file operations, each **one commit to `main` authored as the
person**, serialized behind the room's merge mutex, refused `PEOPLE_ONLY` for agents and
`FILE_CHANGED` (naming who got there first) when the path moved since the person loaded it:

- save any text file, creating missing parent folders (git keeps no empty folders, so "new folder" is
  a folder made by saving its first file — DorkOS never commits a placeholder nobody typed);
- upload one or more files into a folder, binaries included, within `FILE_TOO_LARGE` and
  `REPO_CAP_EXCEEDED`;
- rename or move a file or folder;
- delete a file or folder (the app confirms first);
- save a chat attachment from this room into the room's files.

Every such commit posts one **quiet, unaddressed, system-voiced room entry** in the shape merges
already use ("Dorian edited ROOM.md", "Dorian added 3 files to designs/"). It stores no mentions and
wakes nobody. A person who wants an agent to react @mentions it.

We will also **refresh an agent's room worktree at the start of its turn**, under the agent's claim,
before the room context is built. If the worktree is on its own branch, has no changes (tracked or
untracked) and no commits `main` lacks, the server runs `git merge --ff-only <main tip>` in it. Nothing
can be lost, because a fast-forward of a clean tree only adds what `main` already holds. Otherwise the
worktree is left exactly as it is, and the turn's room context says what moved on `main` since the
agent's branch point — who, which files, merges and people's edits alike — and names any file the agent
has also changed ("sync before you merge"). Files never change during a turn; the refresh happens at
the same boundary where the `ROOM.md` pin advances.

## Consequences

### Positive

- A person can run a room's files from the app without a terminal, and every change still has a named
  author and an honest diff.
- Agents that are not mid-work always start on current files, with no git ceremony.
- An agent that is mid-work is told exactly what it is racing, before it tries to merge and is
  refused `BEHIND_MAIN`.
- Nobody's attention is spent: edits and merges are visible history, never wake-ups.

### Negative

- The server is now a writer of a worktree, in one narrow case. The safety argument rests on three
  checks read from git at the moment of the refresh; a bug in any of them could move a tree that held
  work. Each is pinned by a negative test.
- One entry per commit makes the timeline noisier for a person who saves often. There is no coalescing.
- A refresh changes files between turns, so a diff baseline captured in an earlier turn of the same
  session could show others' changes as the agent's. The refresh forgets baselines for the paths it
  moved.
- Upload and attachment copies put binaries into git history forever, bounded only by the caps.
- "New folder" behaves unlike a file manager: an empty folder cannot exist in the room's files.

## Alternatives rejected

- **Give people worktrees.** Rejected again for the reasons in 260829-115626.
- **Wake members on every edit.** The over-participation failure `meta/agent-etiquette.md` exists to
  prevent.
- **Refresh by merging, not fast-forwarding.** A merge in someone else's tree can conflict and needs a
  commit author; that is the agent's job in its own turn.
- **Refresh mid-turn when `main` moves.** Files would change under a running agent.
- **Commit a `.gitkeep` for new folders.** DorkOS would author a file under a person's name that they
  never made.

## Related

- `specs/agent-home-desk/02-specification.md` §5 and §6.
- `260829-115625` — the merge contract and quiet merge entry this mirrors.
- `260829-115623` — the turn-start `ROOM.md` pin whose boundary the refresh shares.
- `260926-172251` — the desk rule that made the worktree a granted folder.
