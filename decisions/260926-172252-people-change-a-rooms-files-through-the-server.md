---
id: 260926-172252
title: People change a room's files through the server, one named commit and one quiet entry each
status: accepted
created: 2026-09-26
spec: agent-home-desk
superseded-by: null
amends: [260829-115626]
---

# 260926-172252. People change a room's files through the server, one named commit and one quiet entry each

## Status

Accepted (spec `agent-home-desk`). It extends **260829-115626**, which stays `accepted`: the same
write path now covers every text file, new files, uploads, renames, deletes and saving a chat
attachment into the room's files. Retired there: "It is markdown-first: other text types are read-only
for now" and the Negative bullet "Editing is markdown-only today". Binary files stay read-only in the
editor.

## Context

A person can only edit markdown in a room's files today; they cannot add a file, drop in a screenshot,
rename, delete, or keep an attachment someone posted. A person's save posts nothing into the room, so
nobody hears about it, and every save is authored as the operator whoever made it.

## Decision

We will give people save (any text file, creating parent folders), upload, rename or move, delete, and
save-attachment-to-files, each **one commit on `main`** behind the room's merge mutex, refused
`PEOPLE_ONLY` for agents and `FILE_CHANGED` when a path moved since the person loaded it. The commit is
authored as the signed-in person when login is on, and as the operator when it is off; names shown
anywhere come from the room log, never from git. Every such commit posts one **quiet, unaddressed,
system-voiced room entry** ("Dorian edited ROOM.md") that stores no mentions and wakes nobody.

## Consequences

### Positive

- A person can run a room's files from the app, and every change still has a named author and an
  honest diff.
- Nobody's attention is spent: an @mention is how a person asks for a reaction.

### Negative

- One entry per commit makes the timeline noisier for a person who saves often; there is no
  coalescing.
- Uploads put binaries into git history forever, bounded only by the caps.
- "New folder" is a folder made by saving its first file; an empty folder cannot exist.

## Alternatives rejected

- **Give people worktrees.** Rejected again for the reasons in 260829-115626.
- **Wake members on every edit.** The over-participation failure `meta/agent-etiquette.md` exists to
  prevent.
- **Commit a `.gitkeep` for new folders.** DorkOS would author a file under a person's name that they
  never made.

## Related

- `specs/agent-home-desk/02-specification.md` §7.
- `260829-115625` — the quiet merge entry this mirrors.
