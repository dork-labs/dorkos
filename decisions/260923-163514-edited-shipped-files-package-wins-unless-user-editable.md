---
id: 260923-163514
title: A shipped file a person edited is replaced with their copy saved beside it, unless the package declares it userEditable
status: draft
created: 2026-09-23
spec: marketplace-package-file-ownership
superseded-by: null
---

# 260923-163514. A shipped file a person edited is replaced with their copy saved beside it, unless the package declares it userEditable

## Status

Draft (extracted from spec: marketplace-package-file-ownership)

## Context

Under ADR 260923-163513 a file the package shipped and the person then changed no longer hashes to the record, so it is not provably the package's. Two opposite failures are possible. Keeping every edit leaves a package half one version and half another: its prompts, hooks and code silently stop updating. Replacing every edit throws away a persona or a config default the person was meant to change. dpkg answers with conffiles, and rpm with `%config` (save the edit as `.rpmsave`) and `%config(noreplace)` (keep the edit, write `.rpmnew`).

## Decision

By default the package wins. The new version's copy is installed and the person's edited copy is saved beside it as `<file>.dork-old`. A package can list shipped paths in `userEditable` (manifest; exact paths or `dir/**` only). For those the person wins, and when the package's default changed, the new default is saved as `<file>.dork-new`. An agent package's `.dork/agent.json`, `.dork/SOUL.md`, `.dork/NOPE.md` and `.dork/MEMORY.md` are user-editable without being declared. Saved names never overwrite an existing file (`.dork-old.2`, …). Each outcome is returned as a `PackageFileNotice` and as one plain sentence on the result's warnings. A package may not ship `*.dork-old` / `*.dork-new` files.

## Consequences

### Positive

- No edit is ever lost, and a package's own content always updates unless its author said a file is meant for editing.
- DOR-1789's refusal to edit a package's shipped schedule stays true: such an edit is still replaced on update (with the copy saved).
- The pattern subset needs no glob library and cannot be ambiguous.

### Negative

- A person who customised a shipped skill has to re-apply the change from `.dork-old` after an update.
- Authors must know to declare `userEditable`, and an older DorkOS ignores it (packages that rely on it set `minDorkosVersion`).

## Alternatives Considered

- **The person always wins** (rpm `noreplace` everywhere). Rejected: packages drift into mixed versions silently.
- **The package always wins, with no declaration.** Rejected: agent personas and editable defaults would be reset on every update.
- **Ask interactively, like dpkg.** Rejected: updates run from agents, the MCP tools and headless CLI runs, where nobody is there to answer.
