---
id: 260923-122615
title: A marketplace package's latest version is what an install would resolve, by Claude Code's chain
status: draft
created: 2026-09-23
spec: marketplace-version-truth
superseded-by: null
---

# 260923-122615. A marketplace package's latest version is what an install would resolve, by Claude Code's chain

## Status

Draft (extracted from spec: marketplace-version-truth)

## Context

The update check compared an installed package's `.dork/manifest.json` version with the `version` on its marketplace index entry. That entry field is optional, and no `dork-labs/marketplace` entry sets it. Claude Code's docs also advise against setting it beside `plugin.json`, which silently wins. So the check reported every package as current, forever (DOR-2244). DorkOS marketplaces are a superset of Claude Code's format (ADR-0238), and Claude Code already defines what a plugin's version is: the one in `plugin.json`, else the entry's, else the resolved commit SHA.

## Decision

The latest version of an installed package is what installing it now would give. The update check resolves the package through the installer's own resolve → stage → validate pipeline, and reads the version by Claude Code's chain: the package's declared version, else the index entry's `version`, else the commit SHA. The installed side is read by the same chain, from the install's files and its `install-metadata.json`.

When the source's current commit, its normalized source (`sourceKeyOf`: clone URL, subpath, effective ref) and its index entry version all equal what the install recorded, the package is current, with no clone. Commit lookups are memoized per repository and ref for 60 seconds. Otherwise the package is staged through the same path an install uses, into the SHA-keyed cache (ADR-0232). Installed trees are read without any validity gate, so an install that predates today's rules is still checked.

An update is offered when both sides are semver versions and the latest is strictly newer, or, for commit-identified packages, when the commit differs. A package that cannot be checked is reported as `unknown` with a reason, never dropped and never called current.

## Consequences

### Positive

- The check is true for every marketplace, including third-party ones that never set an entry version.
- DorkOS and Claude Code agree about which version an installed plugin is.
- No new copy of the version exists to keep in step, since the index stays optional.

### Negative

- A check costs one `git ls-remote` per repository, and a sparse clone for each package whose commit moved. For same-repo marketplaces (ADR-0237), any commit to the repo re-stages every installed package from it on the next check. The cache bounds it.
- A package that declares no version is identified by commit, so unrelated commits in its repository surface as updates. This matches Claude Code, and declaring a version opts out.
