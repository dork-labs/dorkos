---
slug: community-export-any-size
number: 260923-214430
created: 2026-09-23
status: specified
linear-issue: DOR-2283
project: Cloud-Hosted Communities
---

# Export a Community of any size: implementation plan

Four tasks in two phases. The canonical plan, with self-contained descriptions and acceptance criteria, is `03-tasks.json`.

## Phase 1 — Any-size export (launch blocker)

- [ ] **1.1 Add the ZIP64 segment writer, central-directory reader, and ranged blob reads** (large, high). `archive/zip64-writer.ts` (segments with structured entry rows, a tail that encodes every central-directory record with the ZIP64 extra field, ZIP64 end records), `archive/segmented-source.ts`, `archive/zip-reader.ts` (reads version 1 and ZIP64, refuses tampering), `BlobStore.get(…, { range })` on both stores, the `export_segment` put kind, `yauzl` as a dev dependency for cross-checks. No behaviour change. AC-2 (including `unzip`, `bsdtar`, Python `zipfile`, and `ditto` cross-checks) and byte-exact unit tests.
- [ ] **1.2 Make exports background jobs that write a segmented version 2 archive with a resumable download** (xl, high). After 1.1 and member erasure 1.1. Migration (next free number): job columns on `export_archives`, `export_segments`. Worker with lease, deadline, per-segment commits, watermark, targeted rebuilds after removals (plus a per-segment digest for unexplained changes and a rewrite when a file vanishes mid-segment), evidence-scope authority and reservations, tail with small collections and `manifest.json` last; manifest version 2 schemas; job routes and `GET /exports/:id/archive` with `Range`; 24-hour lifetime; erasure's export deletion and husk check limited to `ready` exports with segment keys queued first; downloads stop when the export row is deleted; `evidence` scope for the takedown; browser progress and download UI. AC-1, AC-3 to AC-13, AC-6b, AC-10b.

## Phase 2 — Import any size

- [ ] **2.1 Let import read version 1 and version 2 archives of any size, uploaded in parts** (large, medium). After host-operator 4.2. Reader swap, version dispatch, streaming validation, batched resumable restore, version 2 restore additions (description, admission policy, icon, removal markers, owner memberships), parts upload with resume, whole-file digest, and in-flight part limits (`429`), `COMMUNITY_IMPORT_MAX_BYTES`. AC-14.
- [ ] **2.2 Publish parted move uploads in cloud-api and use them in the DorkOS move flow** (medium, medium). After 2.1 and host-operator 5.2. Additive `parts` on `CommunityMoveUploadSchema` (contract PR first, `cloud-contract`), then the DorkOS move flow uploads in parts and resumes. AC-15.
