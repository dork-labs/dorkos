---
name: syncing-agent-skills
description: Keeps skill definitions aligned between Claude Code and Codex. Use when creating, migrating, renaming, or updating skills that must work across `.claude/skills` and `.agents/skills`, or when auditing drift between the two systems.
---

# Syncing Agent Skills

## Overview

This skill maintains the repo's dual-harness skill strategy:

- **Shared skills** live canonically in `.agents/skills/`
- **Codex** discovers repo skills directly from `.agents/skills/`
- **Claude Code** consumes shared skills through compatibility entries in `.claude/skills/`
- **Per-skill symlinks** are preferred when the exact same skill content should serve both systems
- **Real wrapper directories** are used when Claude Code or Codex needs a different name, description, metadata, or behavior

The goal is to keep shared expertise in one place while allowing small Codex-specific adapters where needed.

## When to Apply

- Creating a new skill that should work in both Claude Code and Codex
- Migrating an existing Claude Code skill into Codex discovery paths
- Renaming a skill for Codex while preserving the Claude Code version
- Updating a shared skill and deciding where the real fix should live
- Auditing drift between `.claude/skills/` and `.agents/skills/`

## Source Of Truth Rules

### Shared skills

When the skill content can be identical in both systems:

- Keep the real files in `.agents/skills/<skill-name>/`
- Create a **per-skill symlink** at `.claude/skills/<skill-name>` pointing to the shared skill directory
- Make shared fixes in `.agents/skills/<skill-name>/`

Do **not** symlink the entire `.claude/skills/` directory. Per-skill symlinks let the repo mix:

- shared skills
- tool-specific wrappers
- Claude-only skills that should not be exposed to Codex yet

### Tool-specific wrappers

When Claude Code or Codex needs a different name, description, or small behavior adjustments:

- Keep the shared skill in `.agents/skills/<skill-name>/` when a shared version exists
- Create a real directory in the tool-specific location that needs the wrapper
- Keep the wrapper thin; it should adapt discovery and wording, not fork the whole workflow
- Continue making shared logic changes in `.agents/skills/` unless the change is truly tool-specific

### Claude-only skills

If a skill is still tightly coupled to Claude-only tools or workflows:

- Keep it only in `.claude/skills/`
- Do not expose it in `.agents/skills/` until a Codex-compatible shape exists

## Decision Matrix

| Situation                                                  | Structure                              | Where real fixes live                                                   |
| ---------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------- |
| Same name, same behavior, same wording                     | Per-skill symlink in `.claude/skills/` | `.agents/skills/<skill-name>/`                                          |
| Same behavior, different Codex or Claude name/description  | Real wrapper + shared source           | Shared logic in `.agents/skills/`; tool-specific wording in the wrapper |
| Codex needs meaningfully different behavior                | Separate real directories              | In the system-specific skill being changed                              |
| Skill depends on Claude-only task APIs or command concepts | Claude-only for now                    | `.claude/skills/<skill-name>/`                                          |

## Portability Rules

Prefer capability language over tool-specific language so one skill can serve both systems.

### Prefer

- "Ask a short bounded clarifying question if ambiguity blocks safe progress."
- "Keep and update a short execution plan during multi-step work."
- "Delegate independent subtasks only when the user explicitly asks for parallel or subagent work."

### Avoid in shared skills

- Naming Claude-only tool primitives as requirements when the behavior can be stated more generally
- Hard-coding slash-command assumptions for Codex
- Duplicating long instructions across Claude and Codex variants

Tool-specific examples are acceptable only when they are genuinely required for that system.

## Sync Workflow

1. **Classify the skill**
   Decide whether it should be shared, wrapped for Codex, or remain Claude-only.
2. **Choose the structure**
   Use a per-skill symlink in `.claude/skills/` for shared skills; use a real wrapper when discovery or wording must differ.
3. **Normalize the instructions**
   Rewrite shared guidance in capability terms where possible.
4. **Preserve repo-specific references**
   Real repo paths may stay when they are useful and accurate.
5. **Update inventories**
   Keep harness documentation accurate after creating or moving skills.
6. **Validate discovery**
   Confirm the final directory layout matches how Claude Code and Codex scan skills.

## Repo Spec

For the full repo-specific harness synchronization design, read:

- `references/sync-harnesses-spec.md`

Use that document when defining canonical locations, deciding what can be projected to Cursor or Codex, or planning how Claude-only concepts such as project hooks and custom slash commands should degrade in other tools.

## Current Named Exception

`reading-session-transcripts` is a planned exception:

- Claude Code skill stays as `reading-session-transcripts`
- Codex version should be renamed to `reading-claude-code-transcripts`
- Keep the existing Claude transcript paths such as `~/.claude/projects/...`

Because the Codex version changes identity, it should use a real wrapper directory instead of a symlink.

## Validation Checklist

Before finishing a sync or migration:

- [ ] The skill name follows repo naming conventions
- [ ] The description clearly states what the skill does and when to use it
- [ ] The chosen structure is intentional: shared symlink, Codex wrapper, or Claude-only
- [ ] Shared fixes were made in `.agents/skills/`, not only in a wrapper
- [ ] No whole-folder symlink was introduced for `.claude/skills/`
- [ ] Inventory docs reflect the new skill or count changes
