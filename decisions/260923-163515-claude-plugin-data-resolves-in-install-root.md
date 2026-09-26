---
id: 260923-163515
title: ${CLAUDE_PLUGIN_DATA} resolves to the install root's .dork/data/, one directory per install
status: accepted
created: 2026-09-23
spec: marketplace-package-file-ownership
superseded-by: null
---

# 260923-163515. ${CLAUDE_PLUGIN_DATA} resolves to the install root's .dork/data/, one directory per install

## Status

Accepted (extracted from spec: marketplace-package-file-ownership)

## Context

Claude Code tells plugin authors not to write state into the plugin's install directory, which is versioned and swept after an update. They are to use `${CLAUDE_PLUGIN_DATA}` (`~/.claude/plugins/data/<id>/`, one per plugin per user) instead. Claude Code substitutes it inline in skills, agents, hooks, monitors and MCP/LSP config. The DorkOS marketplace is a Claude Code superset, but Harness Sync rewrote only `${CLAUDE_PLUGIN_ROOT}` in projected commands and hooks. A projected hook using the data token ran as a project hook, where the variable is unset, so `"${CLAUDE_PLUGIN_DATA}/x"` became `/x`. DorkOS already reserved `<installRoot>/.dork/data/` as package data that survives updates.

## Decision

`${CLAUDE_PLUGIN_DATA}` resolves to `<installRoot>/.dork/data`: **one directory per install, deliberately.** Claude Code keeps one per plugin per user, shared by every scope. DorkOS scopes installs to projects, and the same plugin in two projects carries two projects' settings (flow: two Linear teams).

- **Created** by every flow at activation. An empty one is pruned on uninstall.
- **Rewritten inline** by Harness Sync everywhere it rewrites `${CLAUDE_PLUGIN_ROOT}` (command wrappers, Claude Code hooks, Codex and OpenCode hook paths), with a warning for a projected skill, which cannot be rewritten.
- **Exported as environment variables.** Claude Code also exports both variables to hook, MCP and LSP processes, so projected hook commands are prefixed with a quoted `export CLAUDE_PLUGIN_ROOT=… CLAUDE_PLUGIN_DATA=…;` and a script reading the environment gets the same paths. Plugin MCP and LSP servers are not projected today; their environment is a recorded limit for whoever adds that.
- **Always the person's.** `.dork/data/**` is a reserved path a package may not ship, so under ADR 260923-163513 it survives update, reinstall and uninstall, and only `--purge` removes it.
- **Dependencies:** a `node_modules` a plugin puts in its data directory (a pattern Claude Code suggests) is cloned on every update. That is near-free on copy-on-write filesystems and a real copy on ext4. DorkOS already installs a package's declared dependencies into its own `node_modules` (an owned path), and the authoring docs say so.
- **Global plugins still delivered through the SDK** get Claude Code's own directory until DOR-174, which must move that data when it switches.

## Consequences

### Positive

- A plugin written for Claude Code keeps its state correctly under DorkOS.
- Data is per install, so flow in two projects has two data directories, which Claude Code's per-user layout cannot give.
- Scripts that read the variable from the environment work in projected hooks too.
- It reuses the path DorkOS already documented as package data; no new location.

### Negative

- DorkOS keeps data on uninstall by default, where Claude Code deletes it unless `--keep-data`. The two differ, deliberately, to keep DorkOS's existing contract.
- Until DOR-174, a global plugin's data lives in two different places depending on how it is delivered.

## Alternatives Considered

- **A separate tree outside the install root** (`<scope>/.dork/package-data/<root>/<name>/`, mirroring ADR-0201's `extension-data`). Rejected: under ADR 260923-163513 the install root already keeps the person's files, and a second location would need its own uninstall and purge wiring.
- **Mirror Claude Code exactly** (`~/.claude/plugins/data/<id>/`). Rejected: one directory per user cannot hold per-project settings, and it would write into another program's home.
