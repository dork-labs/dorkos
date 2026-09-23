---
id: 260923-163513
title: An installed package owns only the files its install put there, proven by a recorded hash
status: draft
created: 2026-09-23
spec: marketplace-package-file-ownership
superseded-by: null
---

# 260923-163513. An installed package owns only the files its install put there, proven by a recorded hash

## Status

Draft (extracted from spec: marketplace-package-file-ownership). Amends ADR-0233 (the update's preserve-and-restore steps) and ADR-0304 (adds a carry-over step to the transaction).

## Context

Updating a marketplace package was uninstall then install, and only `<installRoot>/.dork/data/` and `.dork/secrets.json` survived it. A plain reinstall kept nothing at all, because the transaction deletes the moved-aside target on success. The installer had no record of which files it had installed, so it treated the whole install root as the package's. flow's settings (`config/config.json`, `config/config.local.json`, written by `/flow:init`, never shipped) were reset on every update, and the operator restored them by hand four times. An agent package's `.dork/agent.json`, persona and memory were rewritten, so the agent got a new id. The question: who owns which files in an install root, for every package type, and how does a package say so?

## Decision

Every marketplace install writes `<installRoot>/.dork/installed-files.json` into the staged tree before activation: each shipped file's root-relative path and SHA-256, the installer-generated trees it owns wholesale (`node_modules`), the package's source, and its resolved `userEditable` list. `runTransaction` computes it whenever a flow passes `ownership`, so no flow can forget it. **DorkOS removes or replaces only files it can prove the install put there, unchanged.** Everything else in an install root is the person's. Update, reinstall and a plain uninstall keep it; only `--purge` removes it. Installing over an existing root copies the person's files from the backup into the staged tree (step 3b) under a fixed rule table, leaving the backup whole until the install commits. Uninstall without purge leaves the person's files and the record in place. Such a root has no manifest and counts as not installed. A legacy install without a record gets one rebuilt from its recorded commit's tree; if that tree cannot be had, a no-loss fallback deletes nothing it cannot prove.

## Consequences

### Positive

- One rule fixes every package type, including packages whose authors did nothing: flow's config, `/flow:init`'s generated adapter, an agent's workspace, a person's schedule file under a package agent.
- The two hard-coded preserve constants, the update's scratch-dir snapshot and `findInstallRootFromPreservedPath` are deleted rather than extended.
- Reinstall and update share one code path and one guarantee.
- The record gives later work an exact answer to "is this file the package's?" (DOR-1791's `isPackageOwned` heuristics can read it).

### Negative

- Every install hashes its staged tree, and every update or reinstall copies the person's files once. Large agent working trees pay a real copy, chosen over moves for crash safety.
- An uninstalled package can leave a directory behind (its kept files plus the record). It is invisible to every "installed" view, but it is on disk.
- Legacy installs need a one-time rebuild that may fetch the recorded commit.

## Alternatives Considered

- **A package-declared preserve list** (`preserve: [...]`). Rejected: protects only what an author anticipated, not an agent's writes, `/flow:init`'s generated adapter or a person's schedule. A Claude-Code-format package has no DorkOS manifest to declare it in.
- **Move all user state out of the install root** (Claude Code's `${CLAUDE_PLUGIN_DATA}` model, VS Code's `globalStorageUri`), replacing the root wholesale. Rejected as the whole answer: it fixes no existing package until its author changes it. It cannot work for agent packages, whose install root is the agent's working directory. A per-plugin, per-user directory is also wrong for per-project settings. Its useful half, a conventional data directory, is kept as ADR 260923-163515.
- **Three-way merge of the person's tree, the old version and the new one.** Rejected: conflict markers in a SKILL.md or hooks.json are worse than a saved copy, and it needs the old tree on every update.
- **Detect edits by mtime.** Rejected: copying and restoring files rewrites mtimes, which is exactly how the operator restored flow's config.
