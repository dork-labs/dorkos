---
id: 260925-191411
title: Retire the Obsidian plugin
status: accepted
created: 2026-09-25
spec: obsidian-retirement
superseded-by: null
amends: '0001'
supersedes: '260825-194924'
---

# 260925-191411. Retire the Obsidian plugin

## Status

Accepted. Amends [ADR-0001](0001-use-hexagonal-architecture.md): the Transport seam, context injection and test mocks remain; the requirement for a shipping in-process Obsidian implementation ends. Supersedes [ADR 260825-194924](260825-194924-obsidian-carries-a-prebuilt-sqlite-and-never-migrates.md), whose embed packaging and read-only index rules no longer govern a shipping surface.

## Context

The operator does not use the Obsidian plugin, which remains under-tested despite ongoing runtime, native dependency, build and theme maintenance. Its in-process services duplicate the normal server path with a different feature set. Maintaining that path takes time from web, desktop, phone, Cloud and Community work. Public source-build instructions existed; absence from the community directory and release assets does not establish that nobody used it.

## Decision

We will retire the plugin app, DirectTransport and code used only by that host, after checking callers. We retain Transport and shared server, desktop, native dependency and UI behavior used by supported surfaces. We preserve the old guide URL for migration and exact source recovery through Git history, without publishing an obsolete binary. A future thin client using the normal server would require demonstrated demand and a new decision; this work does not build one.

## Consequences

### Positive

- One supported local service path for the browser, phone and desktop renderer.
- No plugin-specific CommonJS rewrites, native add-on packaging or host theme upkeep.
- Historical source and decisions stay recoverable; active docs stop asking contributors to maintain a retired surface.

### Negative

- Users lose the in-vault sidebar, active-note prompt context, dragged-in note context and native note opening.
- Opening a vault folder in the normal app requires ordinary filesystem permissions and does not reproduce those features.
- Source-built external installs cannot be counted from release assets or directory listings; migration guidance must remain reachable.

## Recovery and distribution evidence

The preserved pre-removal snapshot is commit `dbff5a6f6b3005d4e9815d1b3d485446528f2900`, tree `63cb22d2e6011aa358b406be3bc83491323662c6`. [The retained guide](../docs/guides/obsidian-plugin.mdx) gives a separate-checkout recovery procedure and data-preserving uninstall guidance. This is a source snapshot, not a claim that the historical plugin is verified or supported.

On 2026-09-25, a paginated read of [DorkOS releases](https://github.com/dork-labs/dorkos/releases) found no assets named for Obsidian/Copilot or the standalone plugin files. The [official community directory](https://github.com/obsidianmd/obsidian-releases/blob/master/community-plugins.json) contained no `dorkos-copilot` or `dork-labs/dorkos` entry. An all-state GitHub issue search for `obsidian` returned no issues. These checks found no distribution or reported-use evidence; they cannot rule out source-built installs or private reports.
