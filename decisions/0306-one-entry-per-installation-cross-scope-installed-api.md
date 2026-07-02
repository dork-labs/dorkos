---
number: 306
title: 'One entry per installation: cross-scope installed API'
status: draft
created: 2026-07-02
spec: marketplace-scoped-install-visibility
superseded-by: null
---

# 0306. One entry per installation: cross-scope installed API

## Status

Draft (auto-extracted from spec: marketplace-scoped-install-visibility)

## Context

The installed-package model was one entry per package name: either the global
scan or a merged single-project view. That shape cannot represent "installed
globally AND on two agents", so agent-scoped installs were invisible to the
marketplace UI and unmanageable after the fact. Client-side fan-out (querying
per agent) and a DB-backed install registry were considered and rejected —
the former pushes agent enumeration to every client with N round-trips and no
MCP parity; the latter creates a second source of truth against the
file-first convention (ADR-0043).

## Decision

`GET /api/marketplace/installed` (no `projectPath`) returns one entry PER
INSTALLATION: the global roots plus every registered agent's
`.dork/plugins`, enumerated server-side via an injected
`listAgentScopes()` (wired to `meshCore.listWithPaths()`, display name
preferred, resolved per request). Agent entries carry
`agentPath`/`agentId`/`agentName` and are tagged `override` when the package
also exists globally, else `agent-local`; ordering is deterministic (global
first, agents by display name). `GET /installed/:name` returns
`{ installations: [...] }` with per-installation capability counts. The
`?projectPath=` merged view is retained for scope-accurate reinstall
detection, and the SDK-activation scan (`listEnabledPluginNames`) is
deliberately untouched.

## Consequences

### Positive

- The UI and any MCP consumer can show and manage each installation
  independently; agent display names travel with the record so clients never
  re-derive identity from paths.
- The marketplace grid's "Installed" badge reflects any-scope installs with
  no extra plumbing.
- Scan cost is bounded and observable: readdir + two small JSON reads per
  registered agent per request.

### Negative

- List consumers must handle duplicate package names (filter, not find).
- Installations under _unregistered_ agents are invisible to the scan;
  orphan surfacing moves to agent-unregistration time (spec Phase 2.3).
- The transport method `getInstalledPackage` was renamed to
  `listPackageInstallations` with a new response shape — a clean break,
  acceptable because all consumers are in-repo.
