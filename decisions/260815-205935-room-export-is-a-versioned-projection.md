---
id: 260815-205935
title: A room export is a versioned JSONL projection, and the owner's copy ignores the join floor
status: accepted
created: 2026-08-15
spec: room-participation
superseded-by: null
amends: null
---

# 260815-205935. A room export is a versioned JSONL projection, and the owner's copy ignores the join floor

## Status

Accepted. It adds a **fifth** read path to the rooms domain, beside the room's own history page,
the durable stream, `read_room_history` and `search_room_history` — and it is the only one of the
five that does not always apply a member's `joinedSeq` floor. `.claude/rules/room-conduct.md`
carries the exception where it states the floor, so the next agent editing this domain meets both
at once.

## Context

Rooms live only in SQLite. That was decided deliberately and is not in question here: a room is a
membership-scoped durable log with a monotonic `seq`, and a file tree cannot give it the
per-member cursors, the unread counts or the ordering that every other part of the feature reads
off that column.

What it costs them is everything a file gives you for free, and DorkOS gives that away everywhere
else. Agents are file-first (ADR-0043). Skills, plugins and marketplace packages are files. A
session transcript is JSONL on disk, greppable with the tools somebody already has. Rooms are the
one thing a person cannot open, search with `grep`, copy onto a drive, or take with them.

The last of those is a promise, not a preference. **DOR-596 C2 — the community exit promise —
says that leaving a community means your local copy goes with you.** An install that cannot hand
its owner their own conversations has not kept it.

Three shapes were considered:

1. **Write rooms to files as well as SQLite.** Rejected. It makes the database a cache of
   something, and two writers of one truth is the failure mode `.dork/agent.json` already pays a
   reconciler to manage. Rooms would gain a whole class of drift for a benefit an export delivers
   outright.
2. **A POST that writes an export to a path the caller names.** Rejected. It would give any HTTP
   caller a filesystem write through the cockpit — a capability no room route has, and a strange
   one to grow for a read. It also needs boundary validation that a read does not.
3. **A read that answers bytes, and a CLI that decides where they land.** Chosen.

## Decision

### The verb

**`GET /api/rooms/:id/export`**, streamed as `application/x-ndjson` with
`Content-Disposition: attachment` and `nosniff`. `dorkos room export <room>` writes it down. The
server decides WHAT the file says; the CLI, which already runs on the operator's own machine,
decides WHERE it goes.

It is **read-only, and structurally so**: the builder (`services/rooms/room-export.ts`) is handed
data and a page-reader function and holds no store handle, so no amount of misuse can make an
export write to the room it is copying. **Nothing reads one of these files back in**, and nothing
is planned to. The database stays the truth; the file is a copy, never a sync target. An importer
would make a room's history forgeable by whoever holds a text editor.

### The format

One JSON object per line, `type` first — deliberately the same family a session transcript is in,
rather than a new shape to learn. Three line types, always in this order: one
`RoomExportHeader`, then one `RoomExportEntry` per entry in ascending `seq`, then one
`RoomExportSummary`. Schemas live in `@dorkos/shared/room-export-schemas` because the route
returns them.

Four properties are load-bearing:

- **Every author id is resolved inline, on the line that uses it** — the message's author,
  everyone it mentioned, and everyone behind each reaction. It costs repetition, and repetition is
  what makes `grep` work: one line answers who said what to whom, with no reader holding the
  header in memory.
- **Thread replies ride the same stream, in `seq` order.** A thread is a relation between entries
  and not a room of its own (ADR 260728-022013), so `threadRootEntryId` is what re-threads one.
  The export therefore needs a read the timeline does not have — every entry, replies included —
  which is why `RoomStore.listEntriesForExport` exists beside `listEntriesFrom`.
- **Attachments are references, never bytes**: id, name, size, type and URL. A JSONL file that
  carried a 40MB video would stop being the thing this is for.
- **The last line is a receipt.** A download that dies half-way is otherwise a perfectly valid
  JSONL file of the messages that made it, with nothing inside it saying so. `entryCount` and the
  `summary` line's presence are how a reader tells a whole export from a fragment, and
  `dorkos room export` refuses to report success without one.

### The version policy

The header carries `format` and `version` (currently `1`). The policy is stated on the constant
and must stay stated there, because the two halves are easy to get backwards:

- **A new FIELD on an existing line type does not bump.** Readers ignore what they do not know.
- **A new `type` of LINE does bump.** `RoomExportLineSchema` is a discriminated union, so a fourth
  line type makes a strict reader refuse the file and a lenient one silently drop whatever the new
  line carried. Either way it breaks a version-1 reader, so it is versioned as a break.
- The reader's obligation, which is the thing that makes both halves work: **an unrecognized
  `type` means "check the header's `version`", never "this file is corrupt."**

### The join-seq carve-out

**The `joinedSeq` floor is not applied when the install's owner exports a room they are a member
of.** Everybody else — every agent, and any second person on the install — exports strictly above
their own `joinedSeq`, exactly as the two history tools do.

The floor exists so a member does not retroactively read what was said before they arrived. That
is a rule about **one participant's view of a shared conversation**, and it is the right rule for
the four read paths that serve a view. An export is not a view: it is the exit path, and an owner
handed a copy of their own room with the first months missing has not been given their data.

Two things keep the carve-out honest:

- **Membership still gates it**, through the same `requireHistoryFloor` both history tools use. A
  member row is required _even for the owner_, who can already SEE every room on the install —
  reading a room's log is a membership, not a visibility. "Not a member" answers exactly as "no
  such room", so a room id is never a capability.
- **The file says which of the two it is.** `scope.joinFloorApplied` and `scope.fromSeq` are on
  the header, so somebody reading an export a year from now can tell "this is the whole room" from
  "this is my slice of it" without asking the server that made it.

The carve-out is scoped to the OWNER predicate (`isOwnerAuthor`) and not to `kind === 'human'`,
for the reason `seesEveryRoom` was narrowed to the same predicate: a second human author — an
invited person — is not the operator, and must not be handed the room's whole history because
they are not a machine.

## Consequences

### Positive

- **The exit promise is payable.** DOR-596 C2 has something behind it for the first time.
- Rooms become greppable, portable and archivable without giving up the SQLite properties the
  feature is built on — and without a second writer of the truth.
- The format is honest about incompleteness, which almost no download format is.
- The read is one more caller of `requireHistoryFloor`, so the membership rule has one
  implementation and five callers rather than five implementations.

### Negative

- **A fifth read path is a fifth thing to keep true.** Anything that changes what a member may see
  now has five call sites to check, and this one deliberately differs from the other four — which
  is exactly the kind of exception that gets "tidied" by somebody who has not read this record.
  The rules file is the mitigation.
- **The owner's export is the most sensitive artifact this product writes**: one file, plain text,
  containing every message in a room including everything said before the owner joined it. It is
  produced only on request, by the owner, onto their own disk — but it exists now, and a
  misplaced copy is a disclosure no permission system can take back.
- **Attachments do not leave with the export.** The conversation is portable; the files people
  shared in it are not. The manifest names them, which is honest but is not the same as having
  them, and a "take everything" archive is still owed.
- **A version-1 reader will meet a version-2 file**, and the quality of that experience depends
  entirely on third-party readers honouring the unknown-`type` rule above. We can state it; we
  cannot enforce it.
- **The header cannot carry a count**, because the body is streamed and the count is not known
  when the header is written. That is what the trailing summary is for, and it means a reader must
  reach the end of the file before it knows whether it has all of it.
