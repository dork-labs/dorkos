---
slug: community-export-any-size
number: 260923-214430
created: 2026-09-23
status: ideation
linear-issue: DOR-2283
project: Cloud-Hosted Communities
---

# Export a Community of any size

**Slug:** community-export-any-size
**Author:** Claude (for DOR-2283)
**Date:** 2026-09-23

---

## 1) Intent & Assumptions

- **Task brief:** An owner must be able to export a community of any size. Today the export answers `413` above 1 GiB of files or 10,000 rows in any table (`routes/exports.ts`, `MAX_EXPORT_BYTES`, `MAX_ROWS`). Design a streamed or chunked export bounded by time and disk, with a resumable download, and keep import (host-operator P3, manifest version 1) able to read it. Decide whether to introduce manifest version 2 with the name, icon, and channel-membership additions the host-operator spec proposed.
- **Source material:** `apps/community/src/routes/exports.ts` (as on `origin/flow/dor-2256-short-names`, which carries erasure, hold, and short names); `specs/community-host-operator-api/02-specification.md` P3 (import) and its resolved Open Question 6 ("a follow-up that adds the community name, description, icon, and channel memberships to the owner export as version 2, with import accepting both versions"); `specs/community-member-erasure/02-specification.md` (content version, export deletion on erasure); `packages/cloud-api/src/communities.ts` (the published move contract).
- **Assumptions:**
  - An owner's right to take their data out does not depend on how big the community grew. It is launch-blocking for a hosted service that stores communities for people.
  - The Community server may run on a small machine: memory and local disk per export must be bounded by configuration, not by community size.
  - Import (host-operator tasks 4.1 and 4.2) is not built yet; its migration will be 0016.
  - The move contract in `packages/cloud-api` is published and can only grow additively.
- **Out of scope:**
  - Incremental or differential exports, scheduled exports, and backups (a host's backups stay the recovery path).
  - Exporting to a third-party destination (the owner downloads the file).
  - Changing what a personal export contains.

## 2) Pre-reading Log

- `routes/exports.ts`: the export runs **inside the request**: `snapshot()` reads every collection into memory in one `REPEATABLE READ` transaction with `LIMIT MAX_ROWS + 1` and answers `413 ATTACHMENT_TOO_LARGE` (the wrong code) above 10,000 rows, above 1 GiB of files, or above a 16 MiB manifest; `zipSource()` streams a zip through `fflate`'s `Zip` into `blobStore.put` with `maxBytes: 1 GiB`; the commit checks the content version and inserts `export_archives` with a one-hour life. The download re-checks membership twice per chunk and has no `Range` support.
- `storage/blob-store.ts`: `stageBlob` writes every `put` to a private local temp file first (the S3 store too, `s3-blob-store.ts`), with a ceiling of 1 GiB for exports and 25 MiB otherwise. So an export's disk use equals its size today.
- `storage/managed-blobs.ts`: a reservation must commit within `MANAGED_BLOB_RESERVATION_TTL_MS` (one hour). A multi-hour single write cannot commit.
- `fflate` 0.8.3 writes and reads zip but has no ZIP64, so it cannot produce or read an archive over 4 GiB or with more than 65,535 entries.
- Member erasure (#2029): every content change bumps `community_content_versions` and inserts `entry_redactions` rows in the same transaction; export commit refuses when the version moved; erasure deletes every live export.
- Host-operator P3: import streams the uploaded zip through `fflate`'s `Unzip`, requires `manifest.json` first, validates the whole manifest in memory, and restores rows in one transaction of at most about 60,000 rows. The upload is one `PUT` of at most 1 GiB.
- `packages/cloud-api/src/communities.ts`: `CommunityMoveUploadSchema = { url, token, expiresAt, maxBytes }` describes a single `PUT`.
- Browser: `Manage.tsx` and `CommunityAdministration.tsx` call `POST /owner/export` and then download `GET /exports/:id`. No other consumer (`apps/server`, `apps/client`) calls the export routes.

## 3) Codebase Map

- **Primary components:** `routes/exports.ts` (becomes routes only), new `export-worker.ts`, new `archive/zip64-writer.ts` and `archive/zip-reader.ts`, `storage/blob-store.ts` + both stores (ranged `get`), `erasure.ts` (`deleteExports`), `schema.ts` + migration, browser export UI.
- **Import side (later task):** `routes/imports.ts`, `import-worker.ts` (host-operator 4.1/4.2), `packages/shared/src/community-wire.ts` (manifest schemas), `packages/cloud-api/src/communities.ts` (additive `parts`).
- **Data flow:** owner asks → job row → worker plans and writes segments (each a managed blob) → re-checks removals → writes tail segments (small collections, manifest, central directory) → ready → download streams the segments in order, honouring `Range`.
- **Config:** new `COMMUNITY_EXPORT_SEGMENT_BYTES`, `COMMUNITY_EXPORT_TTL_HOURS`, `COMMUNITY_EXPORT_MAX_HOURS`, `COMMUNITY_EXPORT_CONCURRENCY`, `COMMUNITY_IMPORT_MAX_BYTES`, `COMMUNITY_IMPORT_UPLOAD_HOURS`.
- **Blast radius:** export routes and wire schemas (only the same-origin browser parses them), the blob store interface (additive), erasure's export step, import (later), the move contract (additive).

## 5) Research

**Container.**

1. **Many independent zips of at most 1 GiB (parts 1 of N).** Keeps `fflate`. The owner downloads N files; import and the DorkOS move flow must accept N files. Worst experience; rejected.
2. **One ZIP64 archive, stored as consecutive segments (recommended).** The archive is one logical file: the concatenation of segment blobs, each a whole number of zip entries, and a tail with the central directory. Each segment is written and committed on its own (bounded disk, bounded time, restartable). A small built-in writer (stored and deflated entries, data descriptors, ZIP64 records) replaces `fflate` for writing; a small central-directory reader over ranged reads replaces `fflate`'s streaming reader for import and reads version 1 archives too. Every desktop unzip tool opens ZIP64.
3. **One tar (pax) archive.** Trivially segmentable (no central directory) and trivially streamable, but import would need a second reader for version 1 zips, and the file people download changes type. Rejected in favour of one format family.

**Consistency.** A multi-hour `REPEATABLE READ` transaction holds back vacuum on a busy database. Instead: a per-channel sequence watermark taken at start (messages are append-only), small collections read at the end, and removals caught through `entry_redactions` rows, rebuilding only the segments they touch.

**Manifest version 2.** Version 1 cannot describe more than 10,000 rows per collection within a 16 MiB manifest, so a large export needs a new format anyway. Version 2 moves rows into NDJSON files, adds the community's name, description, admission policy, icon, channel memberships, and a removal marker on entries, and puts `manifest.json` last (readers find it through the central directory).

## 6) Decisions

| #   | Decision              | Choice                                                                                                                                                                                                               | Rationale                                                                                                |
| --- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1   | Where the export runs | A background job with a lease, like the deletion worker; the request only creates it                                                                                                                                 | A request cannot run for hours or survive a restart                                                      |
| 2   | Container             | One ZIP64 archive stored as segments of at most `COMMUNITY_EXPORT_SEGMENT_BYTES` (default 256 MiB), each a whole number of entries, plus tail segments with the central directory                                    | One file for people; disk bounded by one segment; each segment commits within the one-hour reservation   |
| 3   | Writer and reader     | Small built-in modules on Node's `zlib` (`crc32`, raw deflate), no new runtime dependency; `yauzl` as a dev dependency cross-checks them in tests                                                                    | `fflate` has no ZIP64; the formats needed are small and fixed                                            |
| 4   | Consistency           | Messages up to a per-channel watermark taken at start; removals since start rebuild only affected segments (at most 5 passes); small collections read at the end; commit only if the content version still matches   | No long transaction; honours the erasure rule that an export made before a change never commits after it |
| 5   | Manifest              | Version 2 for every new export, owner and personal; version 1 is no longer written                                                                                                                                   | A large export cannot be version 1; one writer, one shape                                                |
| 6   | What version 2 adds   | Rows in NDJSON files; community name, description, admission policy, icon; human and agent channel memberships; a `removal` marker on entries; attachments stored under their real (sanitized) names                 | The Open Question 6 set, plus what makes the file readable by a person and restorable faithfully         |
| 7   | Download              | A separate `GET /exports/:id/archive` with single-range `Range`, `If-Range`, and a strong `ETag`; access re-checked every 16 MiB or 10 seconds                                                                       | Browsers resume interrupted downloads; per-chunk database checks do not scale to tens of gigabytes       |
| 8   | Lifetime              | Ready archives live `COMMUNITY_EXPORT_TTL_HOURS` (default 24, 1–168); one open owner export per community and one personal export per member                                                                         | A large download takes hours; one at a time bounds storage                                               |
| 9   | Time bound            | `COMMUNITY_EXPORT_MAX_HOURS` (default 24) per job; lease 5 minutes, renewed per segment                                                                                                                              | A stuck job ends and frees its storage                                                                   |
| 10  | Import                | Accepts versions 1 and 2 through one central-directory reader; archives up to `COMMUNITY_IMPORT_MAX_BYTES` (default 1 GiB, so a host that changes nothing keeps P3's bound); resumable part uploads; batched restore | Any-size export is only useful if another host can take it                                               |
| 11  | Move contract         | `CommunityMoveUploadSchema` gains optional `parts: { partBytes, maxBytes }`; the single `PUT` and `maxBytes` keep their meaning                                                                                      | Additive; older apps keep working within 1 GiB                                                           |
| 12  | Erasure and takedown  | Both delete ready exports (all segments); jobs in progress rebuild instead of failing                                                                                                                                | Keeps erasure's guarantee without restarting a many-hour export for one change                           |
