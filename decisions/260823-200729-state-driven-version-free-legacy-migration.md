---
id: 260823-200729
title: State-driven, version-free legacy migration with a sunset
status: proposed
created: 2026-08-23
spec: universal-scheduled-tasks
superseded-by: null
amends: null
---

# 260823-200729. State-driven, version-free legacy migration with a sunset

## Status

Proposed — extracted from spec `universal-scheduled-tasks`.

## Context

Retiring the special task directories and legacy top-level cron fields (ADR
260823-200724) requires every existing installation to move onto the new format, but
DorkOS is pre-launch alpha with no version-gate infrastructure guaranteeing anyone passes
through a specific release. Approval grants (the `bypassPermissions` keep-grant and the new
arm-approval grant, ADR 260823-200726) are keyed on file content, so a naive rewrite of
frontmatter would silently un-approve every previously-approved schedule the moment its
content changed.

## Decision

**A single boot-time detector, keyed on the presence of legacy state, not on a version
number**, runs before watchers start on every boot (spec §4). Detection covers legacy
`tasks/` directories and any file carrying legacy top-level cron/enabled/permissions/
max-runtime fields; when nothing legacy exists, it no-ops in microseconds. This makes the
migration idempotent and safe for version-skippers by construction — someone jumping many
releases hits the same detector as someone upgrading one release at a time, with no "must
pass through release N" requirement. Every stored content-keyed grant for a rewritten file
is re-keyed to the new content transactionally in the same pass as the rewrite, so a crash
mid-migration cannot leave a grant pointing at content that no longer exists — the failure
mode is fail-closed (grant lost → re-park), never grant-without-review. The migration
module carries its own documented removal condition (6 months post-ship / 2027-02, or
v1.0, whichever comes first), tracked by a ticket filed at ship time; after removal,
release notes document the migration floor ("coming from before the shipping version?
install it once first"). We rejected a dual-format acceptance window — accepting both old
and new frontmatter shapes indefinitely would mean every future reader of a schedule file
forever carries two parsers, for a pre-launch install base tiny enough not to need it.

## Consequences

### Positive

- No release-to-release "must upgrade through N" constraint; the same detector handles a
  person on the previous release and a person eight releases behind identically.
- Approved schedules survive the upgrade transparently — re-keying rides the same
  transaction as the rewrite, so an operator never has to re-approve a schedule they
  already approved before upgrading. With one exception worth stating plainly: when the
  schedule's name is already taken at its destination, the file moves aside under a
  suffixed name and the approval is dropped, because the thing at that name is no longer
  the thing the operator approved. That schedule parks with a reason naming both paths.
  "Transparently" is therefore true of every schedule whose name is free, which is nearly
  all of them, and knowingly untrue of the rest.
- The removal condition lives in one place (a header comment plus a filed, dated ticket),
  so the migration module doesn't linger as permanent legacy-compat code nobody remembers
  to delete.

### Negative

- The migration module is a small but permanent per-boot detection cost on every install
  that has already migrated, until the sunset date arrives and it is deleted.
- A crash mid-migration that trips the fail-closed path silently drops a previously
  approved schedule back to `pending_approval` — correct and safe, but a real behavior
  change an operator will notice and have to re-approve.
- The sunset date is a promise the team has to keep: after removal, an installation that
  skipped the entire window loses automatic migration — an unparseable or legacy-shaped
  file parks with a warning instead, and the operator must follow the documented floor by
  hand.
