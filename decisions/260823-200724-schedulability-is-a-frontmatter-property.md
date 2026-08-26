---
id: 260823-200724
title: Schedulability is a frontmatter property, not a directory
status: accepted
created: 2026-08-23
spec: universal-scheduled-tasks
superseded-by: null
amends: null
---

# 260823-200724. Schedulability is a frontmatter property, not a directory

## Status

Proposed — extracted from spec `universal-scheduled-tasks`.

## Context

A scheduled task could only ever live at `<tasksDir>/<slug>/SKILL.md` under one of two
blessed roots wired at boot (`apps/server/src/index.ts:2104-2143`). The file format was
already a strict superset of a skill (`TaskFrontmatterSchema extends SkillFrontmatterSchema`),
and the `flow` marketplace plugin already shipped cron frontmatter inside plain `skills/`
dirs that DorkOS could not discover without a hand-copied file. The location requirement
blocked the ecosystem goal: an existing skill could never become a schedule, and marketplace
packages other than `shape` had no schedules slot at all.

## Decision

**A top-level `schedule:` frontmatter block is the sole marker of schedulability.** Any
skill in any scanned skills root that carries the block is a scheduled task; removing the
block turns it back into a plain skill. The special task directories
(`~/.dork/tasks/`, `<project>/.dork/tasks/`) are retired; discovery moves to
`<project>/.agents/skills/` (per registered agent) and a new global `~/.dork/skills/`
(spec §2). We rejected a `skills/scheduled/` subdirectory namespace: every scanner that
matters — DorkOS's harness and skills scanners and Claude Code itself — reads exactly one
level deep, so a nested skill would be invisible to all of them, silently recreating the
special directory this decision exists to kill. The namespace stays flat; the Schedules UI
groups by presence of `schedule:`, never by path.

## Consequences

### Positive

- Any existing skill, in any scanned root, becomes a scheduled task by adding one
  frontmatter block, with zero relocation.
- Marketplace packages beyond `shape` (plugin, agent, skill-pack) can ship schedules for
  the first time — schedulability is a property of the file, not a slot only shapes had.
- One flat namespace with no path-based sublanguage for scanners to special-case.

### Negative

- Discovery must scan every skill file per root to find the ones that opt in, rather than
  listing a dedicated tasks directory — mitigated by a fast frontmatter-key reject before
  full schema validation (spec, Performance Considerations).
- "Is this a scheduled task" is no longer answerable by `ls`; it requires opening the file
  and parsing frontmatter, so a scanner bug that misparses frontmatter can silently hide a
  schedule instead of a directory simply not existing.
- Grouping in the UI is now derived state rather than structural, so provenance
  (root + agent) has to do the disambiguation work a directory used to do for free.
