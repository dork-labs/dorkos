---
number: 43
title: Use Filesystem as Canonical Source of Truth for Mesh Agent Registry
status: draft
created: 2026-02-26
spec: mesh-registry-integrity
superseded-by: null
---

# 43. Use Filesystem as Canonical Source of Truth for Mesh Agent Registry

## Status

Draft (auto-extracted from spec: mesh-registry-integrity)

## Context

The Mesh agent registry maintains agent state in two places: `.dork/agent.json` manifest files on disk and rows in the `agents` SQLite table. These can diverge silently — manual edits to manifests are never synced to the DB, and deleted project directories leave ghost entries. The non-atomic 3-step registration (file → DB → Relay) with no rollback compounds the problem.

## Decision

The `.dork/agent.json` file on disk is the canonical source of truth. The SQLite `agents` table is a derived index. On any conflict, file data overwrites DB data. API updates write-through to the file first, then update the DB. A periodic reconciliation sweep ensures the DB converges to the filesystem state.

## Consequences

### Positive

- Simple mental model — one canonical source, one direction of data flow
- Matches established patterns (Consul, systemd, Docker) where config files are authoritative
- Users can safely edit `.dork/agent.json` directly and changes propagate automatically
- Recovery is straightforward — delete the DB and let reconciliation rebuild it from files

### Negative

- Changes are not detected instantly — up to 5 minutes delay until next reconciliation sweep
- Requires reconciliation infrastructure (startup sweep + periodic timer)
- API responses may briefly show stale data between file write and next reconciliation
