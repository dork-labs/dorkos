---
slug: marketplace-install-verification
number: 260924-175336
created: 2026-09-24
status: ideation
linear-issue: DOR-2197
project: Marketplace Package Management
---

# Say whether an installed package still matches what was installed

## Brief

- **DOR-2197:** an install's pinned commit is recorded and never checked, so a hand-edited install still claims it. The ask:
  - report `clean` / `modified` / `unknown` wherever install state shows;
  - make `unknown` degrade rather than fail for older installs;
  - warn before an update replaces edits.
- **Added scope (coordinator, 2026-09-24):** a safe background rebuild of the installed-files record for installs made before records existed. It holds the install lock, uses the fetched commit only when it matches the live files, has no byte-matching fallback, and writes nothing on a failed fetch or a mismatch.
- **DOR-2320**, the manual "prepare this package", is the same engine run on demand.

## What already exists

- DOR-2245's `.dork/installed-files.json` lists every shipped file with its SHA-256. That is the content hash the issue proposed, per file, so the record is the thing to verify against, not a second hash in `install-metadata.json`.
- `rebuildInstalledFiles` (`lib/legacy-record.ts`) rebuilds a record during update and uninstall, with a trust threshold and a byte-matching fallback. The fallback is what the DOR-2272 review showed mis-assigning shipped files offline.
- DOR-2306 (#2088, open) adds a whole-tree content hash for approvals. It is not needed here, but the two must share one per-file primitive.

## Evidence

A real legacy install (blintz's flow 0.7.3 at `ee1c8eb`) matches its fetched commit on 137 of 137 files. An exact-match rule is practical, not theoretical.

## Options considered

1. **A tree hash in `install-metadata.json`, as the issue first proposed.** Rejected: it says only _that_ something changed, and the record already holds per-file hashes.
2. **Reuse the tolerant rebuild for the background job.** Rejected: on a fetch failure it guesses, and the guesses are what the review flagged.
3. **Chosen:** verify against the record, and add one strict rebuild engine that runs in the background after boot and on demand (DOR-2320). The update path's own rebuild is unchanged and gets a follow-up.

Next: `02-specification.md`.
