---
name: syncing-agent-skills
description: Keeps skill definitions aligned between Claude Code and Codex. Use when creating, migrating, renaming, or updating skills that must work across `.claude/skills` and `.agents/skills`, or when auditing drift between the two systems.
---

# Syncing Agent Skills

## Overview

This skill maintains the repo's dual-harness skill strategy:

- **Shared skills** live canonically in `.agents/skills/`
- **The projection engine** (`@dorkos/harness`, driven by `dorkos harness sync`) projects the canonical layer to every enabled harness — Claude Code, Codex, Cursor, Gemini, Copilot
- **`.agents/harness.manifest.json`** declares the exceptions: Claude-only skills, tool-specific wrappers, command mappings, and instruction/hook projections
- **Claude Code** consumes shared skills through per-skill symlinks in `.claude/skills/`; **Codex** discovers them directly from `.agents/skills/`

The goal is to keep shared expertise in one place and let the engine, not by-hand symlinking, keep every harness's view aligned.

## Primary Workflow: the Sync Engine

The engine is the source of truth for projection mechanics. Run it from the repo root:

```bash
dorkos harness sync                      # report drift, touch nothing (same as --check)
dorkos harness sync --fix                # realize the plan on disk (symlinks, scaffolds, generated files)
dorkos harness sync --check --harness codex   # narrow to one harness (claude-code|codex|cursor|gemini|copilot)
```

- `--check` (the default) prints the per-harness projection plan and exits `1` on drift — safe to run any time, ideal after creating/renaming/moving a skill
- `--fix` applies the plan: creates missing symlinks, scaffolds wrappers, regenerates projected files, and reports anything it dropped
- The engine runs fully offline (no server, no `~/.dork` needed for repo-scope work); it lives in `packages/harness`, with the CLI entry in `packages/cli/src/harness-sync-command.ts`

**Typical loop when touching skills:**

1. Make the change in the canonical location (`.agents/skills/<name>/`, or `.claude/skills/<name>/` for Claude-only skills)
2. If the skill's classification changed (shared ↔ Claude-only, new wrapper), update `.agents/harness.manifest.json`
3. `dorkos harness sync --check` — read the drift report
4. `dorkos harness sync --fix` — let the engine realize it
5. Re-run `--check` to confirm a clean exit

## When to Apply

- Creating a new skill that should work in both Claude Code and Codex
- Migrating an existing Claude Code skill into shared discovery paths
- Renaming a skill for one harness while preserving another's version
- Updating a shared skill and deciding where the real fix should live
- Auditing drift between `.claude/skills/` and `.agents/skills/` (that audit **is** `dorkos harness sync --check`)

## Source Of Truth Rules

### Shared skills

When the skill content can be identical in both systems:

- Keep the real files in `.agents/skills/<skill-name>/`
- Claude Code sees it via a per-skill symlink at `.claude/skills/<skill-name>` (the engine creates and maintains these)
- Make shared fixes in `.agents/skills/<skill-name>/`

### Tool-specific wrappers

When a harness needs a different name, description, or small behavior adjustments:

- Keep the shared skill in `.agents/skills/<skill-name>/` when a shared version exists
- Declare the wrapper in `harness.manifest.json` (`skillWrappers`) and let the engine scaffold it
- Keep the wrapper thin; it adapts discovery and wording, not the whole workflow

### Claude-only skills

If a skill is still tightly coupled to Claude-only tools or workflows:

- Keep it only in `.claude/skills/` and list it in the manifest's `claudeOnlySkills` with a reason
- Do not expose it in `.agents/skills/` until a portable shape exists

## Decision Matrix

| Situation                                              | Structure                              | Where real fixes live                                                   |
| ------------------------------------------------------ | -------------------------------------- | ----------------------------------------------------------------------- |
| Same name, same behavior, same wording                 | Per-skill symlink in `.claude/skills/` | `.agents/skills/<skill-name>/`                                          |
| Same behavior, different per-harness name/description  | Real wrapper + shared source           | Shared logic in `.agents/skills/`; tool-specific wording in the wrapper |
| A harness needs meaningfully different behavior        | Separate real directories              | In the system-specific skill being changed                              |
| Skill depends on Claude-only tools or command concepts | Claude-only for now                    | `.claude/skills/<skill-name>/` + `claudeOnlySkills` manifest entry      |

## Portability Rules

Prefer capability language over tool-specific language so one skill can serve every harness.

### Prefer

- "Ask a short bounded clarifying question if ambiguity blocks safe progress."
- "Keep and update a short execution plan during multi-step work."
- "Delegate independent subtasks only when the user explicitly asks for parallel or subagent work."

### Avoid in shared skills

- Naming Claude-only tool primitives as requirements when the behavior can be stated more generally
- Hard-coding slash-command assumptions for other harnesses
- Duplicating long instructions across per-harness variants

Tool-specific examples are acceptable only when they are genuinely required for that system.

## Manual Mechanics (Fallback)

If the built CLI is unavailable (e.g. mid-bootstrap), the engine's on-disk contract can be maintained by hand — this is what `--fix` automates:

- A shared skill is a real directory `.agents/skills/<name>/` plus a **relative** per-skill symlink: `ln -s ../../.agents/skills/<name> .claude/skills/<name>`
- Never symlink the entire `.claude/skills/` directory — per-skill links let the repo mix shared skills, wrappers, and Claude-only skills
- Verify with `ls -la .claude/skills/` (links must not dangle) and reconcile against `harness.manifest.json`
- Follow up with `dorkos harness sync --check` as soon as the CLI is available again

## Repo Spec

For the full repo-specific harness synchronization design, read:

- `references/sync-harnesses-spec.md`
- `../../harness.manifest.json`

Use that document when defining canonical locations, deciding what can be projected to other harnesses, or planning how Claude-only concepts such as project hooks and custom slash commands should degrade elsewhere.

## Current Named Exception

`reading-session-transcripts` is a planned exception (recorded in the manifest's `skillWrappers`):

- Claude Code skill stays as `reading-session-transcripts`
- Codex version should be renamed to `reading-claude-code-transcripts`
- Keep the existing Claude transcript paths such as `~/.claude/projects/...`

Because the Codex version changes identity, it uses a real wrapper directory instead of a symlink.

## Validation Checklist

Before finishing a sync or migration:

- [ ] The skill name follows repo naming conventions
- [ ] The description clearly states what the skill does and when to use it
- [ ] The chosen structure is intentional: shared symlink, wrapper, or Claude-only
- [ ] Shared fixes were made in `.agents/skills/`, not only in a wrapper
- [ ] `.agents/harness.manifest.json` reflects the classification
- [ ] `dorkos harness sync --check` exits clean (or the remaining drift is intentional and explained)
