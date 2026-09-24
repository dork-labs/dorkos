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

The HTTP apply has one door, `POST /api/marketplace/updates`, whose body names each installation with the version, the disclosure and the staged files' content hash it was shown; the server recomputes all three and refuses the batch (409) if any moved, and the installer re-checks the disclosure before removing anything. An agent additionally needs the same approval card `marketplace_update` raises, and an agent's global install that runs anything or replaces a global package needs the `marketplace_install` card.

Global activation loads a package that runs anything on its own only when a person approved it exactly as it is: its name, what it declares, and the content hash of its installed tree (`<name>@global-<digest>` in the hook-decision lists). One approval per package; every install, update or removal forgets the earlier ones. A yes is recorded only after an install landed whose files are the ones the person was shown, or when a card or the terminal is answered against the current hash. The runtime re-checks at the start of every turn. A held-back package is visible on its row, reviewable, and listed at startup. Existing global plugins are withheld until approved rather than grandfathered.

## Consequences

### Positive

- One content gate at activation covers every way a global package can change: HTTP, MCP, CLI, or a file edited on disk, down to its bytes.
- The app shows what an update runs, and the install is held to it.

### Negative

- After upgrading, each global plugin that runs programs of its own is paused until a person allows it once.
- A plugin is withheld whole, skills included, because the SDK has no partial load.
- Files outside the package that a hook reads at run time are not bound, and a file rewritten mid-turn runs until the turn ends.
- Every turn start costs an `lstat` walk of each global package that runs anything.
