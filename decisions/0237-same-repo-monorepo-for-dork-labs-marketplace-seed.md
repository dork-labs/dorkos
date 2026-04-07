---
number: 237
title: Same-Repo Monorepo for dork-labs/marketplace Seed
status: accepted
created: 2026-04-07
spec: marketplace-05-claude-code-format-superset
superseded-by: null
---

# 237. Same-Repo Monorepo for dork-labs/marketplace Seed

## Status

Accepted (marketplace-05 implementation landed)

## Context

The original marketplace-04 plan required 9 separate GitHub repositories to launch the seed catalog: 1 registry repo plus 8 individual package repos (`code-reviewer`, `security-auditor`, etc.). This created significant repo sprawl, duplicated tooling across 8 repos, forced coordinated PRs across 2+ repos for any cross-package refactor, and introduced a "create a new repo" step to the contributor workflow that Obsidian's community plugin ecosystem has explicitly identified as painful.

Peer ecosystem research showed that same-repo monorepos are the dominant pattern for first-party plugin seeds: Homebrew's `homebrew-core`, VS Code's first-party extensions monorepo, Astro's Starlight monorepo, and most tellingly — Anthropic's own `claude-plugins-official` marketplace, which is simultaneously the registry (`.claude-plugin/marketplace.json` at repo root) and the package directory (individual plugins in `plugins/*/`). CC's `metadata.pluginRoot` field was added specifically to support this pattern, letting entries write `"source": "code-reviewer"` instead of `"source": "./plugins/code-reviewer"`.

## Decision

The Dork Labs seed lives in a single repository: `github.com/dork-labs/marketplace`. The repository structure holds both the registry files (`.claude-plugin/marketplace.json` + `.claude-plugin/dorkos.json`) AND the 8 seed packages (`plugins/code-reviewer/`, `plugins/security-auditor/`, etc.) as subdirectories. The `marketplace.json` sets `metadata.pluginRoot: "./plugins"` so each entry uses the terse `"source": "<name>"` form.

Community-contributed packages continue to live in their own repositories and are referenced from `marketplace.json` via `github` or `git-subdir` source types. The seed monorepo pattern is the Dork Labs default, not an exclusive pattern. A package graduates to its own repo when it has its own release cadence, contributors, and CI — the monorepo serves as an incubator.

## Consequences

### Positive

- Drops seed deployment from 9 repos to 1 repo (unblocks #28 with minimal bootstrap work)
- Atomic catalog+code PRs — no coordinated cross-repo PRs for refactors
- Zero tooling overhead (no private npm registry, no publishing workflow, no release coordination)
- Lowest contributor friction — new Dork Labs packages are a single PR to `dork-labs/marketplace`
- Matches Anthropic's own `claude-plugins-official` pattern exactly
- `metadata.pluginRoot` exists precisely for this use case, so the implementation is trivial

### Negative

- Dork Labs packages do not have independent release cadences until they graduate to their own repos (shared git history and versioning)
- Per-package git tags require prefixed conventions (`code-reviewer@v1.2.0`) if we ever want independent versioning within the monorepo
- Repository access control is all-or-nothing — anyone with write access can modify any seed package
