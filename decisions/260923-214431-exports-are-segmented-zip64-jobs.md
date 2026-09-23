---
id: 260923-214431
title: Exports are resumable background jobs that write one segmented ZIP64 archive with a version 2 manifest
status: accepted
created: 2026-09-23
spec: community-export-any-size
superseded-by: null
---

# 260923-214431. Exports are resumable background jobs that write one segmented ZIP64 archive with a version 2 manifest

## Status

Accepted (from spec: community-export-any-size; decisions pre-authorized by the operator for this programme).

## Context

Owner exports ran inside one request, read every collection into memory, and refused communities with more than 10,000 rows in any table or 1 GiB of files. Every storage write is staged on local disk first and must commit within an hour of its reservation. The zip library in use has no ZIP64. An owner must be able to take their data out however large the community grew, and another host must be able to import it.

## Decision

An export is a background job with a lease and a deadline. It writes one ZIP64 archive stored as consecutive segments of bounded size, each committed on its own; the archive is their concatenation, and each segment's central-directory records are kept relative to the segment so a segment can be rewritten and only the tail recomputed. Messages are read up to a per-channel watermark taken at the start; removals since then (every one leaves an `entry_redactions` row and a content-version bump) rewrite only the segments they touch, and the tail commits only if the content version still matches. Manifest version 2 puts rows in NDJSON files and adds the community's name, description, admission policy, icon, channel memberships, and a removal marker. Ready archives download with byte ranges and live 24 hours. Import reads versions 1 and 2 through one central-directory reader and accepts uploads in resumable parts; the move contract gains an optional `parts` field.

## Consequences

### Positive

- No size cap; disk per job is one segment; restarts resume at the last segment.
- One file for people, which every common unzip tool opens; downloads resume.
- Erasure's guarantee holds without restarting a long export for one change.

### Negative

- The server owns a small ZIP64 writer and reader instead of a library.
- An export is no longer an exact point-in-time snapshot: messages up to its start, names and memberships as of its end.
- Archives live longer, so they use more storage while they exist.
