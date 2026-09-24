---
id: 260924-163130
title: Whether DorkOS may edit a schedule inside an install root is read from the installed-files record
status: draft
created: 2026-09-24
spec: marketplace-agent-schedules
superseded-by: null
---

# 260924-163130. Whether DorkOS may edit a schedule inside an install root is read from the installed-files record

## Status

Draft (extracted from spec: marketplace-agent-schedules). Finishes DOR-1791 in the shape DOR-2245 made possible (DOR-2272).

## Context

DOR-1789 decided whether DorkOS may write a schedule's file by where the file sits: anything in a plugin or Shape install, and anything under an agent directory that carries a package marker. That was the only honest answer while an update replaced the whole install root. It cost a real capability: a person could not schedule anything for a marketplace agent.

DOR-2245 gave every install root a record of the files the install put there, and made an update keep every file the record does not list. Location no longer says what an update will do to a file. The record does.

## Decision

A file inside an install root that has a record is the package's exactly when the record lists it (in `files` or under `ownedPaths`) and it does not match the record's `userEditable` patterns. Whether its bytes still match is ignored: an edited shipped file is still replaced by the next update, so DorkOS still must not write it. A record left behind by an uninstall (`uninstalledAt`) claims nothing.

An install root with no record (installed before DOR-2245, not yet updated) keeps the DOR-1789 answer: location for plugin and Shape roots, a marker for agent directories.

Both task doors ask this one question about the file they would write. Create is refused only where update would be refused, so a person can never make a schedule DorkOS then refuses to let them edit.

The separate preserved task root DOR-1791 designed (`<installRoot>/.dork/schedules/`) is not built. The agent's existing `.agents/skills/` root is durable now, and a second root would add a watched directory, a naming collision and a schedule the agent cannot invoke as a skill, for nothing the record does not already give.

## Consequences

### Positive

- A person can make and edit schedules for a marketplace agent, and they survive the package's updates.
- One ownership rule for the create door, the update door and discovery's sync rules, derived from the same record the installer acts on, so the two cannot disagree about a file.

### Negative

- Legacy installs keep the old refusal until their next update or reinstall writes a record.
- A later package version that ships a schedule with the same name as a person's takes the path; the person's copy is saved as `SKILL.md.dork-old` and stops running. The update result says so, and the replaced schedule parks for approval.
- Each ownership question reads a small JSON file.
