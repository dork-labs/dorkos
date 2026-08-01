---
id: 260801-204127
title: A session's Claude account is derived from the root its transcript lives under, never stored
status: accepted
created: 2026-08-01
spec: claude-code-accounts
superseded-by: null
---

# 260801-204127. A session's Claude account is derived from the root its transcript lives under, never stored

## Status

Accepted. Shipped in #621 (DOR-729).

## Context

Once DorkOS reads several Claude accounts at once (260801-204126), every read holding a bare session id
becomes ambiguous: resuming a session, tailing its transcript, or reading its todos must all act on the
account that session belongs to, not on whichever account happens to be active. Sending a turn to the
wrong account is a real-money failure — the accounts are per paying client.

DorkOS already has a registry for exactly this shape of question. ADR-0255 binds a session to its
runtime in `session_metadata`, first-write-wins, and the obvious move is a second column beside it.

A read-only trace of the resume path before implementation found that the answer is already on disk and
already computed. `SessionStore.ensureForMessage` calls `transcriptReader.hasTranscript(...)` on the
resume path and **throws away the root that probe resolved**, keeping only `hasStarted`.

## Decision

We will define a session's account as **which root its transcript lives under**, and record it nowhere.
The winning root from the probe the resume path already runs is widened to be returned rather than
discarded, and carried on the live session as `accountRoot`. Reads that hold only a session id resolve
it through a memoizing `SessionRootIndex`, which probes the root set in order, active first, and
remembers the winner.

We reject a `session_metadata` binding. Its `runtime` column is documented immutable and first-write-wins,
which is the wrong semantics for a directory a person can move or delete — disk is self-healing where a
registry drifts. There is no first-write race, no migration for the 96 existing sessions, and no second
copy of a fact the filesystem already answers. A registry would also buy nothing: every consumer holding
a bare session id has to touch disk for the transcript regardless.

On the wire, `Session.account` is modelled on `origin`, not on `runtime`: optional, best-effort, derived,
absent meaning "the unmarked default". Runtimes with no account concept need no changes, and neither
does history from before accounts existed.

The index memoizes **hits only**. A miss is not a durable fact — the commonest miss is a session's todo
file, which does not exist when the session starts and appears the moment the agent writes its first
plan, so a negative memo would mean that plan never shows up.

## Consequences

### Positive

- Nothing can drift, because there is nothing to keep in sync. Deleting or moving an account directory
  changes the answer on the next read.
- No migration. All 96 pre-existing sessions carried correct accounts the moment the union scan landed.
- Listing pays nothing to tag a session: the account is `path.dirname` three times on a path the scan
  already resolved — no syscall, no config read.
- The account survives a resume failure. `message-sender` retries a failed resume as a brand-new SDK
  session, and `accountRoot` deliberately survives that reset alongside `hasStarted`; clearing it would
  silently move a paying client's conversation onto whatever account is active. This is the one place
  where "derived" is not enough on its own, and it is tested.

### Negative

- **Every consumer holding a bare session id must touch disk.** That is the price, and it is charged
  per call: one `access` per registered account (one on a default install, three on the operator's
  machine). It was paid to fix `getTodoFilePath(sessionId)` and friends, which resolved the config root
  directly and were account-blind by signature — under multi-account they silently returned another
  account's todos.
- The memo is keyed by bare session id with no root in the key. That is safe only because session ids
  are root-unique, an invariant of the SDK rather than of DorkOS. It is asserted in a test rather than
  assumed, and it is the assumption that breaks first if the SDK ever changes id allocation.
- Refusing to memoize misses means a session with no todo file re-probes every account on every poll.
  Bounded and small, but it is real work repeated on a path that already reads a file.
- `account` is deliberately excluded from `dorkos://sessions`. It is the absolute path of a config
  directory, so publishing it would tell every MCP client — agents included — how the operator's paying
  clients are laid out on disk, to no benefit, since nothing reachable through `/mcp` acts on an account.
  The cockpit reads it from `GET /api/sessions` instead. The consequence is that the two surfaces show
  different session shapes.
- `sessionMetaEqual`, the change-suppression comparator, deliberately omits `account`. Correct — a
  transcript cannot move between accounts, so the value can never differ between two readings — but it
  is an omission that only a comment distinguishes from an oversight.

## Relationships

- **Deliberately unlike [ADR-0255](0255-per-session-runtime-binding.md)** (per-session runtime binding).
  That ADR is untouched and still governs runtime binding; this records why its pattern is the wrong
  tool for a fact that lives on disk and that a person can change from outside the product.
- **Depends on 260801-204126** for the set of roots it probes.
- **Constrains 260801-204129**: an in-process SDK helper must be handed this session's own root, which
  is why that lock takes a root parameter rather than resolving one.
