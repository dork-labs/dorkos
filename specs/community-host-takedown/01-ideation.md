---
slug: community-host-takedown
number: 260923-214420
created: 2026-09-23
status: ideation
linear-issue: DOR-2281
project: Cloud-Hosted Communities
---

# Let a host take down illegal content

**Slug:** community-host-takedown
**Author:** Claude (for DOR-2281)
**Date:** 2026-09-23

---

## 1) Intent & Assumptions

- **Task brief:** A host must be able to take down illegal content (for example child sexual abuse material) at the level of one message, one file, or a whole community, without first opening an export window to the uploader, while preserving evidence separately for the authorities, with a notice and a full audit. Today the only host deletion path starts from a hold, which lets the owner export for at least 7 days. The design must respect ADR `260923-121150` (host keys never reach content): a takedown must not let a host read content through the API; the preserved copy goes to a separate, host-configured evidence store; members see a tombstone ("removed by the host"). Consider a separate scope `communities:takedown`, an optional two-person rule, and propagation to DorkOS mirrors through the redaction feed. Launch blocker.
- **Source material:** `specs/community-host-operator-api/02-specification.md` (host authority, host keys, hold and host-started deletion, host links with the Report link); `specs/community-member-erasure/02-specification.md` (tombstones, `entry_redactions`, the redaction feed, the 72-hour window); `specs/community-single-item-delete/` (the shared removal module); `specs/community-export-any-size/` (the export job); ADRs `260920-201101`, `260923-121150`, `260923-121712`.
- **Assumptions:**
  - A host is legally responsible for what it stores once it knows about it. Many jurisdictions require removing some content quickly and preserving it for authorities (for example, a US provider that reports child sexual abuse material must preserve the report's contents for a year; the EU's Digital Services Act expects a statement of reasons to the affected person). This spec gives the host the mechanism; the host's own policy and counsel decide how to use it.
  - The host operator already controls the database and object storage. The line ADR `260923-121150` draws is that **host authority through the API** never reads content. A takedown can keep that line: it names content by id, removes it, and writes a copy only to a store outside the API.
  - Reports reach the host through the host's report link (host-operator "Host links"), which carries the community and entry UUIDs, never content.
  - The Community server sends no email. Notices are shown in the product.
  - The operator pre-authorized decisions in this programme.
- **Out of scope:**
  - Detecting content automatically (hash matching, classifiers).
  - Filing reports with authorities. The host does that from the evidence.
  - Suspending or banning an account across the whole host (follow-up).
  - A `pending_owner` community (nobody can read it; the host abandons it).

## 2) Pre-reading Log

- `routes/host-lifecycle.ts` (#2036): host-started deletion requires `held`, a published notice at least 7 days old, and the id suffix; it enters `deletion_pending` with a 7-day `delete_after` and a host requester the host can cancel back to `held`. The hold lets the owner export. Nothing lets a host remove one message.
- `host/authority.ts` (host keys, P1): four scopes; `assertHostActor` re-reads the key inside the write transaction; `recordHostAudit` writes `host_audit_events` with the actor.
- `migrations/0012_host_keys_and_limits.sql`: `host_api_keys_scopes` check `cardinality(scopes) BETWEEN 1 AND 4` and the four-scope subset.
- `migrations/0010_administration.sql`: tenant `audit_events.actor_kind IN ('member','system')`.
- `erasure.ts` and `specs/community-single-item-delete/`: tombstone in place, files deleted, `entry_redactions` row, content version bump; `queueBlobs` moves blobs to `pending_delete`.
- `storage/blob-store.ts`, `storage/factory.ts`, `config.ts`: one store per server, configured by `COMMUNITY_STORAGE_DRIVER`, `COMMUNITY_STORAGE_PATH`, `COMMUNITY_S3_*`. The tenant reconciliation lists the whole namespace, so a second use of the same bucket or directory would confuse it.
- Better Auth's `session` table stores `ipAddress` and `userAgent` for each session.
- DorkOS (`apps/server/src/services/communities/remote/`): mirrors cache entry text and file metadata; file bytes are fetched on demand, never cached. Until the redaction feed (erasure task 2.1) ships, cached text stays.

## 3) Codebase Map

- **Primary components:** new `routes/host-takedowns.ts`, `takedown-worker.ts`, `evidence/sink.ts` (filesystem and S3, write-only), `content-removal.ts` (from the single-delete spec, gains an evidence hold), `host/authority.ts` (new scope), `deletion-worker.ts` and `erasure-worker.ts` (wait for evidence), `routes/administration.ts` (`GET /owner/deletion` explains a takedown), `tenant-context.ts` (the removed-by-host message), host page and member notices in the browser.
- **Data flow (item):** host names an entry or file → one transaction hides it (tombstone, files detached, blobs held), stages an evidence record, deletes ready exports, audits → worker copies record and files to the evidence store → releases the held blobs to the normal cleanup.
- **Data flow (community):** host names a community → access revoked, `deletion_pending` with a short reversal window → an evidence export (export-any-size job, `evidence` scope) → worker copies it to the evidence store → deletion worker runs.
- **Blast radius:** host routes and scopes, the removal module, two workers' gates, the managed-blob states, configuration, the host page, member-facing notices.

## 5) Research

**Removing without an export window.** The hold-and-notice path exists so an owner can take their data before a host deletes it. For illegal content that is the opposite of what is needed: the uploader must not get a copy. A takedown is therefore a separate, narrower power: immediate, by id, with its own scope and audit.

**Preserving without reading.** Options:

1. **Return the content to the host in the takedown response.** Breaks ADR `260923-121150` outright. Rejected.
2. **Keep taken-down content inside the Community database, flagged.** Content that must be gone stays reachable by anyone with a route bug, and by every backup. Rejected.
3. **Write a copy to a separate, host-configured evidence store, write-only from the server (recommended).** The API never returns content; the server can put objects but never read, list, or delete them there; the host reaches the evidence with its own storage credentials, outside the product, as it would reach a backup. A compromised host key can remove content (visibly, with notices and an audit trail) but cannot read it.

**Removal before or after the copy?** Removing only after the copy succeeds would leave illegal content visible whenever the evidence store is down. Instead the content is hidden from every reader at once and its bytes are held (unreadable through any route) until the copy lands, then deleted.

**Two-person rule.** It delays removal, which is the point of a takedown, and a host that wants review can give the `communities:takedown` scope only to a reviewed tool. Rejected for now; a host-level setting can add it later without changing the data model.

**Community takedown.** Reuse `deletion_pending` (it already blocks every member request and revokes access) with a host requester, no notice precondition, a short window in which only the host can reverse it, and the deletion held until evidence is stored.

## 6) Decisions

| #   | Decision                     | Choice                                                                                                                                                                                                                                             | Rationale                                                                                        |
| --- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1   | Authority                    | New scope `communities:takedown`; a person needs password reauthentication                                                                                                                                                                         | Destructive and rare; a host gives it to few keys                                                |
| 2   | Targets                      | One entry, one file, or one community, named by id                                                                                                                                                                                                 | Matches what a report carries                                                                    |
| 3   | What members see             | Entry: `This message was removed by the host.` (the single-delete tombstone, `removed_by='host'`). File: gone from its message. Community: "This community was removed by its host."                                                               | Honest, and reuses the shared tombstone                                                          |
| 4   | Content through the API      | Never; every takedown response and list carries ids, category, reference, and states only                                                                                                                                                          | ADR `260923-121150`                                                                              |
| 5   | Evidence                     | Optional host-configured store (filesystem path or S3 bucket, never the primary one), write-only from the server; each takedown writes files then `record.json` last under `takedowns/<id>/attempt-<n>/`                                           | Preserved outside the API; a partial attempt is recognisable; no overwrite without read access   |
| 6   | Order of removal and copy    | Hidden at once; bytes held until the copy lands, then deleted; retried with backoff while the store is down; tenant deletion and (for a community) erasure wait                                                                                    | Never visible while evidence is pending; never lost to a race                                    |
| 7   | No evidence store configured | Takedowns still work and purge at once; each records `not_configured`; the host page warns                                                                                                                                                         | Self-hosters without a store can still remove content                                            |
| 8   | Community takedown           | From `active`, `archived`, `held`, `suspended`, or `deletion_pending`: revoke all access, enter `deletion_pending` (host requester, no notice needed), evidence export, delete after `COMMUNITY_TAKEDOWN_REVERSAL_HOURS` (default 72) and evidence | Reuses the deletion worker; a mistaken takedown can be reversed before anything is destroyed     |
| 9   | Reversal                     | Community only, by the host, before deletion starts: back to `suspended`, credentials stay revoked. Item takedowns cannot be reversed                                                                                                              | Content that was purged cannot come back; a community waits for the host to resume it on purpose |
| 10  | Notice                       | A category (`child_safety`, `illegal_content`, `legal_order`, `terms_violation`) and an optional host reference, shown to the owner and the author in the product; `notify: false` withholds it and the audit records that                         | A statement of reasons where the law expects one, and silence where an order requires it         |
| 11  | Audit                        | `host_audit_events` for every takedown and reversal; a tenant `audit_events` row with a new actor kind `host` for item takedowns                                                                                                                   | The owner's own audit trail shows the host acted                                                 |
| 12  | Exports                      | A takedown deletes every ready export in the community                                                                                                                                                                                             | They may contain the item                                                                        |
| 13  | Propagation                  | `entry_redactions` rows, carried by the redaction feed (member erasure task 2.1)                                                                                                                                                                   | One mechanism for every content change                                                           |
| 14  | Two-person rule              | Not now                                                                                                                                                                                                                                            | Speed matters; scope limits cover the risk                                                       |
| 15  | Build order                  | Single-delete task 1.1 first (the removal module), then item takedowns (phase 1); export-any-size task 1.2 before the community takedown (phase 2)                                                                                                 | Each part reuses existing machinery                                                              |
