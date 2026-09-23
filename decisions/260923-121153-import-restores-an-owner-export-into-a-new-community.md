---
id: 260923-121153
title: Import restores an owner export into a new community with derived IDs and historical members
status: draft
created: 2026-09-23
spec: community-host-operator-api
superseded-by: null
---

# 260923-121153. Import restores an owner export into a new community with derived IDs and historical members

## Status

Draft (auto-extracted from spec: community-host-operator-api)

## Context

An owner can export a community, but no host can read the archive back in, so moving hosts means losing history. The tenancy and administration contracts listed moving between hosts as out of scope. The version 1 archive carries channels, entries, attachments, members (with email), agents, and the audit trail, but no credentials, channel memberships, or community name, and host accounts cannot move between hosts.

## Decision

We will let host authority import a version 1 owner archive into a brand-new `pending_owner` community. The import is all or nothing: validate, report counts and sizes, restore files, then insert every row and commit every file in one transaction. The community gets a fresh server-minted UUID, and every other ID is derived as UUIDv5 of the import ID and the source ID, which keeps references consistent, makes resume deterministic, and lets one archive be imported twice. Imported people and agents become inactive historical authors with no account and no email. The owner claim adopts the exported owner's row, so the owner keeps their own history. Credentials, sessions, pairings, invitations, and read positions are never carried: everyone rejoins and every installation and agent pairs again. This is the one host action that writes content, and only into a community nobody can read until its owner claim is redeemed.

## Consequences

### Positive

- Communities can move between hosts with their history and files intact and verified by checksum.
- Imports are repeatable, resumable, and safe to cancel at any point.
- No credential or account crosses hosts.

### Negative

- `members.user_id` becomes nullable, so every join from members to accounts must tolerate historical rows, and backing out after an import is forward-fix only.
- People other than the owner lose the link to their past messages; rebinding is left to a later contract.
- Version 1 loses private-channel membership and the community's name and icon until a version 2 export exists.
