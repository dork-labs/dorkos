---
id: 260923-122616
title: A package's version files must agree, and a mismatch fails validation
status: draft
created: 2026-09-23
spec: marketplace-version-truth
superseded-by: null
---

# 260923-122616. A package's version files must agree, and a mismatch fails validation

## Status

Draft (extracted from spec: marketplace-version-truth)

## Context

A marketplace package can state its version in `.dork/manifest.json` (required by ADR-0228), in `.claude-plugin/plugin.json` (what Claude Code loads it by), and in `package.json`. Nothing compared them. flow shipped with manifest 0.6.0 and `plugin.json` 0.7.2, so DorkOS reported one version and Claude Code another for the same install. Any tie-break rule would only choose which of the two programs is wrong.

## Decision

`validatePackage` fails with `VERSION_MISMATCH` when a package has both `.dork/manifest.json` and `plugin.json` and `plugin.json`'s version is missing or differs from the manifest's. It is an error wherever validation gates something: authoring, `dorkos package validate`, install, and the update check's staging of a new version. A new version that fails it is reported as not installable, with the message naming both files and values. Already-installed trees are never gated, so nothing already installed disappears.

`dorkos marketplace validate` fails with `ENTRY_VERSION_MISMATCH` when an index entry's `version` disagrees with its package's `plugin.json`. Claude Code would silently ignore the entry.

`dork-labs/marketplace` also makes `package.json` agree, as repo policy, and requires a version bump on any change to a package that declares one. Under Claude Code's rule, an unbumped change never reaches anyone.

## Consequences

### Positive

- One version per package, stated identically wherever it is stated. Every reader agrees.
- Drift is caught where it is authored, not discovered after an install reports the wrong number.

### Negative

- A third-party package with mismatched files cannot be installed until its author fixes it. The refusal says so plainly.
- Authors must bump on every shipped change, including documentation inside a package.
