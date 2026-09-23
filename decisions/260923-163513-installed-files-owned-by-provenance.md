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

Every marketplace install writes `<installRoot>/.dork/installed-files.json` into the staged tree before activation. It holds each shipped file's root-relative path and SHA-256, the installer-generated paths it owns wholesale (`node_modules`, and a `package-lock.json` npm wrote), the package's source, and its resolved `userEditable` list. An agent package's four identity files are never recorded: DorkOS writes them itself, and they are the agent's. `runTransaction` computes the record whenever a flow passes `ownership`, so no flow can forget it.

**DorkOS removes or replaces only files it can prove the install put there and nobody has changed since.** Proof means bytes that match, reached through real directories with no symlink on the path. Everything else in an install root is the person's. Update, reinstall and a plain uninstall keep it; only `--purge` removes it.

**A person's file is never moved out of its own directory:**

- Installing over an existing root stages in a same-filesystem sibling of the target. Before the target is backed up, it clones the person's files from the live root into the staged tree under a fixed rule table. A late-write pass before the backup is deleted catches anything written during the update.
- Uninstall runs in place. Only record-proven package files move, to a same-filesystem sibling, under a write-ahead journal: identity files move last and come back first, and a `committed` marker after the side effects decides whether crash recovery rolls back or finishes. For an agent package the last side effect unregisters the agent through mesh, after parking its manifest so a reinstall can restore the same id.
- Uninstall prunes the record to the kept entries, so a root it leaves has no manifest and counts as not installed.

The three install siblings (`.dorkos-bak-`, `.dorkos-stage-`, `.dorkos-uninstall-`) are recognised by one shared predicate in every reader of an install root. They are recovered by one janitor (DOR-2273's) with a policy per kind: a backup is restored or deleted, with the record as the proof of "whole"; a stage is deleted; an uninstall is rolled back or finished by its journal. The janitor covers registered project scopes at startup, and a target's own siblings under its lock. Because that lock is per process and two servers can share a project, every sibling carries an owner stamp (pid, data dir, process start time). A sibling is recovered early only when its owner is provably dead; otherwise the janitor waits for a 10-minute age floor.

A legacy install without a record gets one rebuilt from its recorded commit's tree (requires DOR-2248's pinned fetch), and discarded if more than 10% of the recorded files present in the live root differ from it. If no trustworthy tree can be obtained, a file counts as the package's only when some obtainable tree has the same bytes at the same path.

## Consequences

### Positive

- One rule fixes every package type, including packages whose authors did nothing: flow's config, `/flow:init`'s generated adapter, an agent's workspace, a person's schedule file under a package agent.
- The two hard-coded preserve constants, the update's scratch-dir snapshot and `findInstallRootFromPreservedPath` are deleted rather than extended.
- Reinstall and update share one code path and one guarantee.
- The record gives later work an exact answer to "is this file the package's?" (DOR-1791's `isPackageOwned` heuristics can read it).

### Negative

- Every install hashes its staged tree, and every update or reinstall clones the person's files once. A clone is near-free on APFS/btrfs/ReFS; on ext4 it is a real copy, chosen over moving the person's files for crash safety.
- An uninstalled package can leave a directory behind (its kept files plus the pruned record). It is invisible to every "installed" view, but it is on disk. An untouched package leaves nothing.
- Uninstalling an agent package now unregisters the agent (the full mesh cascade), where before the reconciler found it gone eventually.
- Legacy installs need a one-time rebuild that may fetch the recorded commit.

## Alternatives Considered

- **Move the whole root aside to `os.tmpdir()` and copy the person's files back after the side effects** (the first draft of this ADR, and today's uninstall). Rejected in design review: a crash strands the person's files where the OS cleans up, and on tmpfs a large agent tree goes through RAM.

- **A package-declared preserve list** (`preserve: [...]`). Rejected: protects only what an author anticipated, not an agent's writes, `/flow:init`'s generated adapter or a person's schedule. A Claude-Code-format package has no DorkOS manifest to declare it in.
- **Move all user state out of the install root** (Claude Code's `${CLAUDE_PLUGIN_DATA}` model, VS Code's `globalStorageUri`), replacing the root wholesale. Rejected as the whole answer: it fixes no existing package until its author changes it. It cannot work for agent packages, whose install root is the agent's working directory. A per-plugin, per-user directory is also wrong for per-project settings. Its useful half, a conventional data directory, is kept as ADR 260923-163515.
- **Three-way merge of the person's tree, the old version and the new one.** Rejected: conflict markers in a SKILL.md or hooks.json are worse than a saved copy, and it needs the old tree on every update.
- **Detect edits by mtime.** Rejected: copying and restoring files rewrites mtimes, which is exactly how the operator restored flow's config.
