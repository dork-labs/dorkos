---
number: 201
title: Separate Extension Data Storage from Extension Code Directories
status: draft
created: 2026-03-26
spec: ext-platform-03-extension-system
superseded-by: null
---

# 201. Separate Extension Data Storage from Extension Code Directories

## Status

Draft (auto-extracted from spec: ext-platform-03-extension-system)

## Context

Extensions need persistent storage (`loadData`/`saveData`). The question is where this data lives on the filesystem. Options considered: colocated in the extension directory (Obsidian pattern), scoped key in DorkOS config, SQLite table, or a separate data directory. DorkOS extensions can be agent-written and version-controlled, making code directory pollution problematic. VS Code uses a similar separation between extension code and extension storage paths.

## Decision

Extension persistent data lives at `{dorkHome}/extension-data/{ext-id}/data.json` for global extensions and `{cwd}/.dork/extension-data/{ext-id}/data.json` for project-local extensions. This creates a parallel directory structure that cleanly separates code from runtime data.

## Consequences

### Positive

- Agent-written extension directories stay clean — no data pollution in code directories
- Symmetric handling for global and local scopes
- Data is easy to backup, restore, or inspect independently of code
- Follows VS Code's `globalStorageUri` pattern of separating code from data

### Negative

- One more directory path to manage and document
- Data doesn't travel with the extension when copying directories (unlike Obsidian's colocation model)
