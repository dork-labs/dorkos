---
id: 260829-085855
title: A delete path in a shared cache root names its target by identity, never by suffix
status: accepted
created: 2026-08-29
spec: desktop-updater-overhaul
superseded-by: null
amends: null
---

# 260829-085855. A delete path in a shared cache root names its target by identity, never by suffix

## Status

Accepted. Shipped in the Desktop Resilience program (DOR-1455).

## Context

A staged update that already landed does not clean itself up. The reporting user's machine held
exactly this: 0.63.0 staged in Squirrel's state directory and sitting in the updater's pending
directory, having already been installed. The support remedy for a broken updater is a manual
overwrite install — and a leftover staged copy would then be applied on the next quit, silently
**downgrading** the person who just fixed themselves by hand.

Purging it means deleting directories in `~/Library/Caches`, which is not ours. Squirrel and
electron-updater name their directories after each app's own identifiers, so the naming conventions
`*.ShipIt` and `*-updater` are shared by every Electron app on the machine. On a real developer's
Mac they match Slack's, Discord's, Notion's, Cursor's and Claude's directories alongside DorkOS's.
The diagnostic report genuinely wants that broad listing; a purge that used it would delete a
co-tenant's in-progress download. The first version of the test suite was green while the code did
precisely that.

## Decision

**Anything we delete under the shared cache root is resolved by identity, and when identity cannot
be established we delete nothing.** `ourUpdaterCacheDir()` reads `updaterCacheDirName` out of the
`app-update.yml` electron-builder ships into our own resources; `ourShipItDir()` reads the bundle
identifier out of the running bundle's own `Info.plist`. Either returning `null` short-circuits the
whole purge. Names are validated as a single plain path segment before use.

**We deliberately refuse the fallback electron-updater takes for itself.** It guesses the app name
when the config key is absent; we return `null`. A guess is fine when the cost is re-downloading an
update, and unacceptable when the cost is deleting a directory belonging to somebody else.

**Suffix matching survives for listing only.** `findCacheDirs()` keeps the tolerant `*.ShipIt` /
`*-updater` scan, documented and test-enforced as never feeding a delete path, because a report that
says what update state exists should over-report rather than miss a renamed directory.

**We delete only what we can judge.** The staged version is parsed from the artifact name by
requiring a whole delimiter-separated segment to be a version, core-only, no prerelease suffix —
otherwise `DorkOS-0.66.0-arm64-mac.zip` reads as a prerelease of `0.66.0`, ranks below a real
`0.66.0-rc.1`, and an rc build deletes the release it is waiting for on every launch, forever.
Anything whose version cannot be read is left alone: deleting what we could not judge is how you
throw away someone's legitimately newer update. The condition for removal is that the version about
to run is at or above the staged one — which covers both "it already installed" and "a person
overwrote us with something newer".

**Squirrel's own logs are never removed**, even while the rest of its state directory is purged.
Their absence is the strongest evidence in a support archive that ShipIt failed silently; deleting
them destroys the diagnosis this whole program was built out of.

## Consequences

### Positive

- The downgrade-after-manual-overwrite trap is closed, which matters most for the users who already
  had a broken updater.
- Every co-tenant app on the machine is out of blast radius by construction rather than by care —
  the purge cannot name a directory it has not proven is ours.
- The suite seeds real co-tenant fixtures (Slack, Cursor, Notion, Linear, Claude) and asserts in
  every `afterEach` that none were touched. That invariant exists because the suite that lacked it
  was green while the code deleted a co-tenant's in-progress download.

### Negative

- The purge silently does nothing in development and in any build that is not ours, because
  `app-update.yml` is absent there. Correct, and it means the path is exercised only by packaged
  builds and by tests that fabricate the config.
- Two identity sources (a generated YAML file in resources, a plist in the bundle) are now
  load-bearing for a delete path. A build-config rename that skips either turns the purge into a
  no-op — the safe direction, but a silent one.
- Version-from-filename is a parser against artifact names electron-builder owns; a naming change
  upstream degrades this to "cannot judge, leave alone".
- Two ways to find the same directories now coexist, and the difference between them is a comment
  and a test rather than a type. A future caller can reach for the wrong one.

## Alternatives rejected

- **Reusing `findCacheDirs()` for the purge.** It is the bug: those suffixes belong to Squirrel and
  electron-updater, not to DorkOS.
- **Falling back to the app name when the config key is missing**, as electron-updater does. Fine
  for a download cache, not for `rm -rf`.
- **Hardcoding `com.dorkos.desktop.ShipIt` and `@dorkosdesktop-updater`.** A build-config rename
  would leave a confident, wrong path in a delete call.
- **Searching artifact names for anything version-shaped.** Ranks release builds below their own
  release candidates and deletes the wrong one.
- **Purging the ShipIt directory wholesale, logs included.** Cheaper, and it destroys the only
  evidence that distinguishes a silent ShipIt failure from every other cause.

## Related

- `260829-085852` — the next-launch verdict. The purge clears its intent record when it removes an
  install nobody attempted, so the next launch does not count a failure against it.
- `260829-085854` — the install handoff, the other half of not letting the updater act on anything
  it has not proven.
- `plans/desktop-resilience-program.md` §4 items 2.7–2.8 — the staged-update and manual-overwrite
  states found on the reporting user's machine.
