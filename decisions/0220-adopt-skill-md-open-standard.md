---
number: 220
title: Adopt SKILL.md Open Standard for Task and Command Definitions
status: accepted
created: 2026-04-01
spec: skills-package
superseded-by: null
---

# 220. Adopt SKILL.md Open Standard for Task and Command Definitions

## Status

Accepted

## Context

DorkOS manages three types of agent instruction files — tasks (`.dork/tasks/`), commands (`.claude/commands/`), and skills (`.claude/skills/`). All share the same shape: markdown with YAML frontmatter plus a body. Yet each had its own parser, schema, and validation approach. The command parser even had a hand-rolled YAML fallback.

The Agent Skills open standard (`agentskills.io`) defines a universal format for these files. Claude Code, Cursor, GitHub Copilot, and 30+ other tools have adopted it. By building on this standard, DorkOS task files become portable across tools and shareable across installations.

## Decision

DorkOS adopts the agentskills.io SKILL.md format as the base for task and command file definitions. A new `packages/skills/` (`@dorkos/skills`) package provides:

- **Base schema** (`SkillFrontmatterSchema`) conforming to the agentskills.io spec
- **Extension schemas** for tasks (`TaskFrontmatterSchema`) and commands (`CommandFrontmatterSchema`)
- **Generic parser** (`parseSkillFile`) — schema-parameterized, replaces three separate parsers
- **Atomic writer** (`writeSkillFile`) — temp+rename pattern for crash safety
- **Directory scanner** (`scanSkillDirectory`) — batch discovery of `*/SKILL.md` entries
- **Utilities** — slug validation/generation, duration parsing, humanization

Tasks use the **directory format**: `{name}/SKILL.md` (not flat `.md` files). This aligns with the SKILL.md spec's support for `scripts/`, `references/`, and `assets/` subdirectories.

Installation-specific fields (`agentId`, `cwd`) are excluded from the file format — they are derived from the file's directory location. `tags` are removed entirely (filtering by agent/status/type is sufficient). The `name` field is a kebab-case identifier matching the directory name; `display-name` provides the human-readable label.

Files are the source of truth (extending the ADR-0043 pattern from agents to tasks). The DB is a derived cache synced via file watcher + periodic reconciler.

## Consequences

### Positive

- One parser replaces three — less code to maintain, consistent behavior
- Task files are portable across DorkOS installations and compatible with Claude Code skills
- Directory format supports bundled assets (scripts, references) per the SKILL.md spec
- Users can edit task files directly on disk; changes sync automatically

### Negative

- Existing task files (flat `.md` format) need migration to directory format
- Two naming conventions coexist: kebab-case `name` (file) vs human-readable `display-name`
- Commands still use flat `.md` files (Claude Code's native format) — the shared schema is used for validation but not the directory structure

## Addendum (2026-04-06): Optional `kind` Field

The marketplace foundation spec (`marketplace-01-foundation`) introduced an
optional `kind` field on `SkillFrontmatterSchema` with values `skill`, `task`,
or `command`. The field is OPTIONAL and existing files continue to work
unchanged.

**Rationale**: When SKILL.md files are distributed in marketplace packages, the
installer needs to know each file's purpose (skill vs task vs command) to
place it in the correct destination directory. Location-based inference works
inside a single installation but breaks at the marketplace boundary, where the
package author chooses arbitrary directory layouts.

**Inference rules** when `kind` is absent:

1. If `cron` field present → `task`
2. If file is under `commands/` or `.claude/commands/` → `command`
3. Otherwise → `skill`

Marketplace package authors SHOULD include `kind` explicitly. User-created
files (not destined for marketplace distribution) MAY omit it.
