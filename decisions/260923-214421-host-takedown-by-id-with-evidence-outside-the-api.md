---
id: 260923-214421
title: A host takes down content by id and preserves evidence outside the API
status: accepted
created: 2026-09-23
spec: community-host-takedown
amends: 260923-121712, 260920-201101
superseded-by: null
---

# 260923-214421. A host takes down content by id and preserves evidence outside the API

## Status

Accepted (from spec: community-host-takedown; decisions pre-authorized by the operator for this programme). Amends `260923-121712` (host-started deletion no longer needs a noticed hold when it is a takedown) and `260920-201101` (host authority may now remove a single message or file, and may make an owner's deletion its own).

## Context

A host that learns it stores illegal content must usually remove it at once and preserve it for the authorities. The only host removal path was deletion after a hold with a 7-day notice, during which the owner can export: the uploader would get a copy and the content would stay up for a week. Host authority must never read community content through the API (`260923-121150`), and reports arrive as community and entry ids, never content.

## Decision

A new scope, `communities:takedown` (a person also re-enters their password), lets host authority take down one entry, one file, or a whole community by id. Content is hidden from every reader in the same transaction (the shared tombstone for entries; access revoked and `deletion_pending` for a community), and ready exports are deleted. No takedown response or route ever carries content. When the host configures an evidence store (a filesystem path or bucket separate from primary storage), the server holds the bytes unreachable, writes the content, the files, and who posted them to that store with put-only access, and only then deletes the primary bytes; `record.json` is written last so a complete copy is recognisable. Without a store, takedowns still work and purge at once. The owner and author get a category and reference unless the host withholds them. A community takedown can be reversed by the host, to `suspended`, until deletion begins. There is no two-person rule.

## Consequences

### Positive

- Illegal content leaves members' view immediately, without an export window for the uploader.
- Evidence is preserved outside the API; a leaked takedown key can remove content but cannot read it.
- Takedowns reuse the removal module, the deletion worker, and the export job.

### Negative

- The host now holds a store of the most sensitive data it has, and must secure and expire it outside the product.
- Content can sit unreachable on primary storage while the evidence store is down.
- A compromised takedown key can destroy content (audited, noticed, and reversible only for whole communities).
