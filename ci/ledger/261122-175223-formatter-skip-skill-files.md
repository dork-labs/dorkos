---
id: 261122-175223
title: Prettier skips the SKILL.md files in the task skill roots
kind: hygiene
status: proposed
actor: agent
gates:
  [
    claude.Stop.format-changed,
    lefthook.pre-commit.format,
    lefthook.pre-push.formatting,
    wf.lint.lint,
  ]
prs: []
ratchet-release: []
field-changes: []
---

A scheduled task's SKILL.md is held to the hash its agent or a person
approved. On Nov 22 the Stop hook reflowed one seconds after its agent wrote
and approved it, and the task ran with fewer permissions from then on
(DOR-5060). Three `.prettierignore` lines now skip every SKILL.md under
`.agents/skills/`, `.claude/skills/` and any `.dork/tasks/`. All four formatting
layers read that one file, so nothing else changes. Any skill there can gain a
schedule, which is why all of them are skipped.

Nothing measurable should move: the gates format fewer files, and those files
are prose a formatter never needed to touch. Revert only if task approval stops
hashing the file body, which DOR-5060 also hardened against re-spacing.
