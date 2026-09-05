---
id: 260726-234122
title: One server per data directory, enforced by a corroborated lock file
status: accepted
created: 2026-07-26
spec: null
superseded-by: null
---

# 260726-234122. One server per data directory, enforced by a corroborated lock file

## Status

Accepted (2026-07-26, DOR-532, PR #503).

## Context

A DorkOS data directory is not shareable, and nothing enforced that. Two servers
pointed at the same `dorkHome` open the same SQLite file, run two agent reconcilers
over the same `agents/` tree, and race each other's writes. This was not
hypothetical: the desktop app and a CLI server each pick their own port, so the
existing `EADDRINUSE` check never fires, and both happily ran against one `~/.dork`
with no detection at all (`lib/instance-lock.ts:1-13`).

The port was the wrong boundary. The resource being contended is the directory.

## Decision

**One server per data directory, claimed at boot before anything opens the
database.** `acquireInstanceLock` (`lib/instance-lock.ts:286`) writes
`instance.lock` inside `dorkHome` recording `pid`, `port`, `startedAt`, and
`version`. The write uses `flag: 'wx'`, which fails if the file exists, so the claim
is atomic against another server starting in the same moment. `start()` calls it
before `initConfigManager` and before any reconciler runs; a failed claim logs the
reason to both the logger and stderr and exits 1 (`index.ts:250-262`).

**A stale claim is taken over; a live one refuses the boot.** Pid existence alone is
not sufficient in either direction. After a SIGKILL the file survives naming a dead
pid, and operating systems recycle pids onto unrelated processes — a pid-only check
would refuse every future start forever while telling the operator to kill something
that has nothing to do with DorkOS. So the holder is corroborated: it must have
_started_ no later than the moment it wrote the lock, with a 120-second tolerance for
wall-clock skew (`assessInstanceLockHolder` and `DEFAULT_PID_REUSE_TOLERANCE_MS`;
see the amendment below for where those live now). A pid that started afterwards is
a recycled pid and reads `gone`, so the next boot simply takes the lock. Where the start time cannot be read the state is
`live-unconfirmed`, which refuses the boot but withholds the `kill <pid>` hint,
because naming a pid we could not confirm is an instruction to damage an innocent
process (`:221`).

**Released in `shutdownServices()`, not `shutdown()`** (`index.ts:1984-1988`, and
the declaration comment at `:227-230`). The admin restart path calls
`shutdownServices()` and then spawns a successor, which must find the directory free;
releasing in `shutdown()` would leave the lock held across exactly that handoff.
Release also refuses to delete a claim naming any process other than this one — the
cost of leaving a dead process's file behind is that the next start clears it,
whereas deleting a file we do not own frees the directory out from under a live
instance (`instance-lock.ts:364`).

**Two escape hatches.** The lock is inert under `NODE_ENV=test`, because suites boot
many servers against throwaway directories, and behind `DORKOS_SKIP_INSTANCE_LOCK`
for anyone who knows better than the check (`isInstanceLockEnabled`,
`instance-lock.ts:83`).

## Consequences

### Positive

- The corruption this exists to prevent — two reconcilers and two SQLite writers on
  one directory — is now impossible to reach by accident, including in the desktop
  plus CLI case that motivated it.
- The refusal is actionable: it names the holding pid, its port, its DorkOS version,
  the contested directory, and the two ways out (`DORK_HOME=/path/to/other dorkos`,
  or the skip flag). It mirrors the `EADDRINUSE` message's shape deliberately.
- A crash never wedges the next start. Both failure directions were reasoned about
  explicitly, and the tolerance is asymmetric on purpose: too tight and a live holder
  reads as gone, which produces the exact corruption being prevented; too loose only
  means a recycled pid holds the lock a little longer.
- The desktop surfaces the refusal as text a person can read. The supervisor keeps a
  redacted, bounded tail of the child's stderr and shows it, so "a data directory
  another process already holds" reaches the user instead of an exit code
  (`apps/desktop/src/main/server-spawn.ts:68-77`, `server-output.ts`).

### Negative

- **The corroboration shells out to `ps`, and `ps -o lstart=` is locale-dependent.**
  macOS renders it through `strftime("%c")`, and `new Date()` parses almost none of
  those forms — `fr_FR` yields `dim. 26 juil. 15:40:36 2026` → `NaN`. The call
  therefore pins `LC_ALL=C` (`instance-lock.ts:144-161`). Without that pin the
  corroboration silently degrades to `live-unconfirmed` on most of the macOS locale
  set, while CI — Linux in the `C` locale — stays green, so an inert safety check
  looks like a working one. Measured during the DOR-532 review by enumerating the
  installed macOS locales and parsing each one's `lstart` output with `new Date()`:
  48 of 84 produced `NaN` (independently reproduced at 47 of 83 on a second machine,
  the spread being locale-set enumeration, not disagreement). Any future code reading
  `ps` output must pin the locale the same way.
- Windows has no `ps`, so `processStartTime` returns `null` and the check falls back
  to pid-only liveness there. A recycled pid on Windows keeps the directory locked
  until the operator uses `DORKOS_SKIP_INSTANCE_LOCK`.
- A synchronous `execFileSync` sits on the boot path. It is bounded at 2 seconds and
  only runs on the rare path where a lock file exists AND names a live pid, never on
  a normal boot (`PS_TIMEOUT_MS`, `instance-lock.ts:112`).
- `DORKOS_SKIP_INSTANCE_LOCK` is a foot-gun by construction: it re-enables the
  corruption. It is documented as such and named in the refusal only as a last
  resort.
- The lock is advisory. It stops DorkOS from starting twice; it does not stop anything
  else from writing to `~/.dork`.

### Alternatives considered

- **Keep relying on the port check.** Rejected on the motivating case: the desktop app
  and the CLI listen on different ports, so `EADDRINUSE` never fires while both share
  one directory.
- **An OS advisory file lock (`flock`) held for the process lifetime.** Rejected: it
  releases on process death with no record of _who_ held it, so the refusal could not
  name a pid, a port, or a version — and the actionable message is most of this
  feature's value. It is also the weakest option on network filesystems.
- **Pid-only liveness, no corroboration.** Rejected: a recycled pid wedges the data
  directory permanently and the error tells the operator to kill an unrelated process.
- **Refuse on any existing lock file, and make the operator delete it.** Rejected: an
  OOM kill or forced logout would then require manual cleanup before DorkOS starts
  again, which is a worse default than taking over a claim that is provably stale.

## Amendment — 2026-09-04 (DOR-542): the reading half moved to `@dorkos/shared`

The desktop shell's "Reset All Data" deletes the whole data directory, so it has
to answer the same question this ADR's lock answers — is anyone holding this? —
from a process that must never take the lock. Reading it needs the file's name,
its schema, and the recycled-pid corroboration; taking it must stay with the
process that opens the directory.

So those three moved to `packages/shared/src/instance-lock.ts`
(`INSTANCE_LOCK_FILENAME`, `readInstanceLock`, `assessInstanceLockHolder`, plus
`liveInstanceLockHolder` for callers that only want a yes or no). The tolerance
constant is now `DEFAULT_PID_REUSE_TOLERANCE_MS` from
`@dorkos/shared/process-liveness`, which already held the same 120 seconds for
the same reason. `acquireInstanceLock` and `releaseInstanceLock` — the only two
that write — stay in `apps/server/src/lib/instance-lock.ts`, unchanged in
behaviour. Nothing in the decision above changed; the line numbers cited in it
did.

**The desktop's check is a read, not a claim, and is advisory in one more way
than this ADR's.** It runs between the supervisor's stop and its start, so a
foreign instance could still take the directory in the moment between the check
and the delete. Claiming `instance.lock` with `wx` first would close that, but
the record carries a `port` and the shell is not a server — an invented one
would put a lie in the file an operator reads to decide what to stop. The gap is
documented at `wipeDataDirectory` in `apps/desktop/src/main/admin/index.ts`
rather than closed.
