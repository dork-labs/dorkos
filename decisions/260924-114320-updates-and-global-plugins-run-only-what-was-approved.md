---
id: 260924-114320
title: Updates and global plugins run only what a person approved
status: draft
created: 2026-09-24
spec: marketplace-update-disclosure-binding
superseded-by: null
---

# 260924-114320. Updates and global plugins run only what a person approved

## Status

Draft (auto-extracted from spec: marketplace-update-disclosure-binding)

## Context

A globally installed plugin loads into every Claude Code session through the SDK, with its hooks, MCP and language servers, monitors and `bin/` commands. DOR-2195 bound the MCP update apply to what the new version runs, but the HTTP apply reinstalled with nothing shown and nothing bound (tier `act`, so any agent with a shell could call it), and activation loaded whatever sat under `~/.dork/plugins` without asking. The SDK cannot load a plugin without its hooks.

## Decision

The HTTP apply has one door, `POST /api/marketplace/updates`, whose body names each installation with the version and the disclosure it was shown; the server recomputes both and refuses the batch (409) if either moved, and the installer re-checks before removing anything. An agent additionally needs the same approval card `marketplace_update` raises. Global activation loads a package that runs anything on its own only when a person approved exactly that set of programs for it, stored as a `<name>@global-<digest>` entry in the existing hook-decision lists; consent is recorded where a person approved (a trusted apply or install, or a granted card), and a withheld package raises a card. Existing global plugins are withheld until approved rather than grandfathered.

## Consequences

### Positive

- One content gate at activation covers every way a global package can change: HTTP, MCP, CLI, or a file edited on disk.
- The app shows what an update runs, and the install is held to it.

### Negative

- After upgrading, each global plugin that runs programs of its own is paused until a person allows it once.
- A plugin is withheld whole, skills included, because the SDK has no partial load.
- A hook's script content is not bound, the same stated limit as project hook consent.
