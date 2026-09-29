---
slug: community-single-item-delete
number: 260923-214410
created: 2026-09-23
status: specified
linear-issue: DOR-2282
project: Cloud-Hosted Communities
---

# Delete one message or one file: implementation plan

Three tasks in one phase. The canonical plan, with self-contained descriptions and acceptance criteria, is `03-tasks.json`.

## Phase 1 — Delete one message or file

- [ ] **1.1 Remove one message or file on the Community server through a shared remove-in-place module** (large, high). After member erasure 1.1 (#2029) and **before member erasure 2.1 (the redaction feed, DOR-2266) is built**: it bumps the content version before inserting redaction rows, so ids become visible in commit order, and refactors erasure onto the shared module. Migration (next free number at build time): `entries.removed_at`, `entries.removed_by` (`author`, `moderator`, `host`). New `src/content-removal.ts` (`removeEntry`, `removeAttachment`, tombstone texts, blob queue, redaction row, content version) with erasure refactored onto it; `DELETE /entries/:entryId` and `DELETE /attachments/:attachmentId` with the author/admin/owner rank rule; replay of a removed entry returns the tombstone; tenant audit; the "every content change writes a redaction row" source-scan guard. AC-1 to AC-11. On the launch path because the host takedown builds on it.
- [ ] **1.2 Add Delete and Remove to messages and files in the Community browser** (medium). Menus, confirm dialogs with the exact copy, tombstone rendering. After 1.1.
- [ ] **1.3 Carry removals to open tabs and DorkOS mirrors through the redaction feed** (small). After 1.1 and member erasure task 2.1. Browser polls the feed for the open channel; a DorkOS mirror test for a removal. AC-12.
