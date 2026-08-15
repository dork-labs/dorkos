---
id: 260815-200159
title: Files own what a person edits, the database owns what concurrency owns, and every ledger owes a backup
status: accepted
created: 2026-08-15
spec: null
superseded-by: null
amends: null
---

# 260815-200159. Files own what a person edits, the database owns what concurrency owns, and every ledger owes a backup

## Status

Accepted.

It generalises a rule two earlier ADRs each reached for their own storage and neither stated
in general — [0013](0013-hybrid-maildir-sqlite-storage.md) for relay messages (which supersedes
the deprecated [0010](0010-use-maildir-for-relay-message-storage.md), where the Maildir half of
the reasoning was first written down), and
[0043](0043-file-canonical-source-of-truth-for-mesh-registry.md) for the agent registry — and
adds the obligation half, which neither carries. This ADR retires nothing in them.

## Context

DorkOS stores durable state in two shapes and has never written down which shape a new store
should take. The decision has been made five or six times from first principles, and the
answers do not agree with each other: agent manifests are files with a rebuildable SQLite index
(ADR-0043), relay messages are Maildir files with a rebuildable SQLite index (ADR-0013), and
rooms are SQLite rows with no file behind them at all. The rooms ADR
([260726-170125](260726-170125-a-room-is-a-membership-scoped-durable-stream.md)) argued the
axis it needed — DorkOS-owned storage versus runtime-owned storage — and settled that a room
log cannot live in a runtime's transcript. It never argued file-versus-database, so the most
valuable thing DorkOS holds ended up in a database by a decision nobody made explicitly.

That omission had a cost, measured on 2026-08-15: **there was no backup machinery anywhere.**
No `VACUUM INTO`, no snapshot, no `~/.dork/backups`, in `packages/db` or in the server. Drizzle
applied migrations at every boot with nobody asked (`packages/db/src/index.ts`), and
`~/.dork/dork.db` held the only copy of every room, DM and thread conversation on the machine.
A file store gets its backup for free — it is in the operator's Time Machine, their `git`, their
Dropbox, their `cp -r`. A database quietly opts out of all of that, and nothing had replaced it.

## Decision

We will place new durable state by asking who the writer is, and we will treat a database as
carrying an obligation that a file does not.

**Files own what humans own and edit.** If a person is expected to open it, hand-edit it, diff
it, or check it into a repository, it is a file and the file is canonical: `.dork/agent.json`
(ADR-0043), `~/.dork/config.json`, skills, task definitions. A derived SQLite index over such a
file is fine and encouraged — it is rebuildable by construction, which is what ADR-0043 and
ADR-0013 both rely on for recovery.

**The database owns what concurrency and wire contracts own.** If correctness depends on
atomic multi-writer append, monotonic sequence numbers, cross-entity foreign keys, or a
transactional read that several processes agree on, it is a database table and there is no file
behind it. Room entries are the clearest case: `(room_id, seq)` is a wire contract that every
SSE reader replays against, and no per-message file scheme delivers it without reimplementing a
transaction.

**Every database ledger owes its owner two things a file store gives away for free: a backup,
and an export.**

1. **A backup** — automatic, unasked-for, and taken with SQLite's own snapshot mechanism, never
   a file copy. Shipped with this ADR: a snapshot before any pending migration runs (kept 10)
   and one per day (kept 7), in `<dorkHome>/backups`, via `VACUUM INTO`. A plain copy of a
   WAL-mode database is not a backup — committed rows can be sitting in `dork.db-wal` with
   nothing of them in `dork.db`, and restoring a stale main file next to live sidecars makes
   SQLite replay the WAL against the wrong base. That is measured, not asserted:
   `backup.test.ts` copies the main file and shows the row missing from the copy and present in
   the `VACUUM INTO` snapshot.
2. **An export** — a way to get the contents out as files, in a format that outlives DorkOS.
   **At the time of this decision no ledger had one**; rooms, the largest, had none, and DOR-1225
   was landing exactly that in parallel — it has since landed, as ADR `260815-205935`, which is
   the first payment against this obligation. Recording it here as an obligation rather than an
   aspiration is the point, and the obligation outlives the first payment of it: a ledger that
   can only be read by the software that wrote it is a lock-in this project does not accept, so
   every ledger added after this one inherits the requirement rather than the exemption.

**A database that fails to open is never backed-up-and-recreated.** It is not renamed, not
repaired, not started fresh over the top. `createDb` throws `DatabaseOpenError`, boot stops, and
the file is left byte-for-byte as it was found. The common causes — a volume that has not
mounted, a half-finished copy, the wrong path — are all fully recoverable right up until
something helpful starts fresh. Boot already stopped here by accident, because Drizzle threw;
it now stops by decision, with a test that fails if a recovery branch is ever added.

**Pre-migration snapshots are load-bearing enough to be fatal on failure.** If the snapshot
cannot be written, the migration does not run. A migration that FAILS is already safe — SQLite
rolls DDL back with the data — so the snapshot exists for the case the transaction cannot
reach: a migration that succeeds and is wrong. Taking that step with no way back, because the
disk was full, is not a trade we make. The daily snapshot is best-effort by contrast, because
nothing irreversible follows it.

**Extension `store.db` migrations get the same treatment**, snapshotted into `backups/` beside
the store. Worth recording _why_, because the blast-radius argument for skipping it was
available and we did not take it: nothing in DorkOS calls `extension-migrator` today — grep
finds only its own tests — so the current risk is exactly zero. It is protected anyway, because
the protection should land with the mechanism rather than as a comment for whoever wires it up,
and because an extension manifest is the one place third-party `DROP TABLE` is legal
(`packages/extension-api/src/manifest-schema.ts`).

## Consequences

### Positive

- The next durable store has a rule to follow instead of a precedent to guess at, and the rule
  names the property that decides it (who writes, and whether concurrency is load-bearing)
  rather than a mechanism.
- Losing a year of conversations to a bad migration now requires losing the snapshots too. The
  window that mattered — an unattended migration at boot — is closed.
- The cost is nil in practice: `dork.db` is ~2 MB, `VACUUM INTO` takes milliseconds, and a first
  boot writes no snapshot at all — neither the pre-migration one (nothing to lose) nor the
  daily, which `index.ts` skips on the strength of a freshness reading taken _before_ migrations
  run, because afterwards a new install and an old one are the same shape.
- The export obligation is written down. It was previously not even a known gap.

### Negative

- **A snapshot is not a restore.** Nothing puts one back; a person has to. That is deliberate
  — automatic restore is the same class of "helpful" move as automatic recreation — but it
  means the safety net only works for somebody who knows the folder exists, which today is
  nobody who has not read this ADR.
- **A full disk can now stop a boot that would previously have succeeded**, on the one boot per
  upgrade where a migration is pending. It surfaces as `SnapshotFailedError`, which names the
  folder and says what to do and that nothing was migrated — but it is a new way to fail.
- **The export half is an obligation this ADR creates, not one it discharges.** A rule that
  states a requirement the codebase does not yet meet everywhere is only worth something if it
  is enforced on the next ledger as well as paid on the current one.
- Seven daily snapshots of a database that grows will eventually be a real number of megabytes.
  Retention is a constant, not a policy the operator can set.
