---
number: 134
title: SDK-Primary Command Discovery with Filesystem Enrichment
status: draft
created: 2026-03-15
spec: sdk-command-discovery
superseded-by: null
---

# 134. SDK-Primary Command Discovery with Filesystem Enrichment

## Status

Draft (auto-extracted from spec: sdk-command-discovery)

## Context

DorkOS discovers slash commands by scanning `.claude/commands/` on the filesystem via `CommandRegistryService`. This misses built-in commands (`/compact`, `/help`, `/clear`), user-level commands (`~/.claude/commands/`), and skills (`.claude/skills/`). The Claude Agent SDK exposes `Query.supportedCommands()` which returns the authoritative, complete list of all command types. The codebase already uses the same non-blocking pattern for `supportedModels()` and `mcpServerStatus()`.

## Decision

Use the SDK's `supportedCommands()` as the primary, authoritative source of slash commands. Retain the filesystem scanner (`CommandRegistryService`) as a supplementary metadata source that enriches SDK results with `allowedTools` and `filePath` where a command has a corresponding `.md` file on disk. Before any SDK session exists, fall back to the filesystem scanner for immediate command availability.

## Consequences

### Positive

- Complete command list in the palette (built-ins, skills, user-level commands)
- Forward-compatible — SDK handles new command formats and locations
- Follows established codebase pattern (`supportedModels()`)
- Zero client-side changes
- Filesystem metadata (`allowedTools`, `filePath`) preserved for project commands

### Negative

- Commands before first session are filesystem-only (no built-ins until first message)
- Merge logic adds complexity to `getCommands()` (O(n) map lookup, ~10 lines)
- Schema fields (`namespace`, `command`, `filePath`) become optional, requiring consumers to handle absence
