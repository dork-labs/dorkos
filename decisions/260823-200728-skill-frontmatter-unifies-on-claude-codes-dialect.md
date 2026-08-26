---
id: 260823-200728
title: Skill frontmatter unifies on Claude Code's dialect
status: accepted
created: 2026-08-23
spec: universal-scheduled-tasks
superseded-by: null
amends: null
---

# 260823-200728. Skill frontmatter unifies on Claude Code's dialect

## Status

Proposed — extracted from spec `universal-scheduled-tasks`.

## Context

agentskills.io's spec fixes six frontmatter fields and sanctions exactly one extension
point, `metadata`, a string→string map — too cramped for a structured schedule block.
Claude Code independently merged commands into skills and defined seven invocation-control
extension fields (`disable-model-invocation`, `user-invocable`, `disallowed-tools`, `paths`,
`arguments`, `shell`, `context: fork` + `background`). DorkOS's own schemas had already
half-adopted that dialect in two separate places — `TaskFrontmatterSchema` and
`CommandFrontmatterSchema` — each tracking a different subset, so skill, command, and
schedule frontmatter had drifted into three overlapping vocabularies.

## Decision

**One `SkillFrontmatterSchema` in `@dorkos/skills`**: the agentskills.io base plus Claude
Code's seven extension fields adopted verbatim — same names, same semantics, no DorkOS
synonyms — plus the DorkOS `schedule:` block (spec §1). `TaskFrontmatterSchema` and
`CommandFrontmatterSchema` are deleted once consumers move; legacy top-level task fields
(`cron`, `timezone`, `enabled`, `max-runtime`, `permissions`, `origin`, `shape`) are no
longer accepted by the schema and are handled by migration instead (ADR
260823-200729). Because Codex and OpenCode don't read frontmatter natively, DorkOS's own
runtime adapters enforce the invocation fields for them — Codex's
`scan-skill-commands.ts` skips `user-invocable: false` from its slash palette, and
model-facing skill lists respect `disable-model-invocation` — while Claude Code needs no
adapter work since it honors the fields itself. We rejected a spec-pure schema confined to
agentskills.io's sanctioned `metadata` string-map extension point: a structured schedule
(cron, timezone, permissions, max-runtime, prompt override) does not fit string-only values
without collapsing into ugly flat keys.

## Consequences

### Positive

- One schema to validate, document, and evolve instead of three overlapping ones; a skill
  author writes one frontmatter dialect whether the file is a plain skill, a command, or a
  schedule.
- Adopting Claude Code's fields verbatim means any skill already authored for Claude Code
  is compatible with DorkOS scheduling with no translation layer.
- Runtime adapters enforcing invocation fields for Codex/OpenCode keep the same file's
  behavior consistent across runtimes that never read frontmatter themselves.

### Negative

- DorkOS now tracks and must keep pace with an external dialect it doesn't control; a
  future Claude Code frontmatter change is a forced follow, not a DorkOS design choice.
- Codex/OpenCode enforcement is adapter-side and best-effort — a regression in
  `scan-skill-commands.ts` silently un-enforces `user-invocable: false` there while Claude
  Code still honors it, so the same file can behave differently per runtime.
- Deleting `TaskFrontmatterSchema`/`CommandFrontmatterSchema` is a breaking change for
  every existing consumer, forcing a coordinated migration across `packages/skills`, the
  tasks service, and the codex/opencode adapters in one release.
