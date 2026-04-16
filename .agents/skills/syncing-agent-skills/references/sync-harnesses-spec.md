# Sync Harnesses Spec

## Overview

This spec defines how DorkOS should synchronize agent harness assets across:

- Claude Code
- Cursor
- Codex

The core principle is honesty over false parity. These tools do not expose the same primitives, so the sync system must distinguish between:

- **canonical shared assets** we can keep once and project outward
- **tool-specific projections** generated from shared assets
- **tool-only features** that must remain native to one tool

## Goals

- Keep shared project intelligence in vendor-neutral locations where possible
- Avoid duplicating long-lived instructions across `.claude`, `.cursor`, and Codex-specific layouts
- Preserve Claude Code power features without pretending Cursor or Codex support them identically
- Make drift visible and intentional
- Prefer generated projections over hand-maintained copies

## Non-Goals

- Force every harness concept to exist in every tool
- Emulate unsupported features through brittle hacks
- Store automatically generated Cursor memories in the repo
- Invent custom Codex slash command files without documented support

## External Constraints

These constraints come from the current official docs checked during this design:

- **Claude Code**
  - Project hooks are configured in `.claude/settings.json`
  - Custom slash commands are stored as Markdown files in `.claude/commands/`
  - Project memory lives in `./CLAUDE.md`
- **Cursor**
  - Project rules live in `.cursor/rules`
  - `AGENTS.md` is supported as a simpler alternative to `.cursor/rules`
  - `.cursorrules` is legacy
  - Memories are generated rules managed by Cursor rather than a normal repo file primitive
- **Codex**
  - Project instructions are driven by `AGENTS.md`
  - Skills are discovered from `.agents/skills`
  - Built-in slash commands are documented, but repo-local custom slash command files are not

## Canonical Model

### Canonical shared locations

These should be the source of truth when the concept is portable:

| Asset Type                   | Canonical Location                                | Why                                                                             |
| ---------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------- |
| Shared skills                | `.agents/skills/`                                 | Vendor-neutral, Codex-native, portable by symlink or copy                       |
| Shared project instructions  | `AGENTS.md`                                       | Supported directly by Codex and Cursor, useful as source text for Claude memory |
| Sync policy and mapping docs | `.agents/skills/syncing-agent-skills/references/` | Keeps the migration logic with the sync skill                                   |

### Tool-native locations

These remain the user-facing projection points:

| Tool        | Skills                                                          | Instructions                     | Commands                                  | Hooks                                  | Memory                                              |
| ----------- | --------------------------------------------------------------- | -------------------------------- | ----------------------------------------- | -------------------------------------- | --------------------------------------------------- |
| Claude Code | `.claude/skills/`                                               | `AGENTS.md` and `CLAUDE.md`      | `.claude/commands/`                       | `.claude/settings.json`                | `CLAUDE.md`                                         |
| Cursor      | `.cursor/skills/` only if we explicitly choose to project there | `AGENTS.md` and `.cursor/rules/` | No repo-local command format in this spec | No repo-local hook format in this spec | Cursor-managed memories, not repo canonical         |
| Codex       | `.agents/skills/`                                               | `AGENTS.md`                      | No repo-local command format in this spec | No repo-local hook format in this spec | No separate repo memory file primitive in this spec |

## Asset Classification

### Class A: Shared canonical assets

These should be authored once and projected outward:

- reusable skills
- project-wide instruction content
- architecture conventions
- coding standards
- durable workflow guidance that is not tied to one tool's private API

### Class B: Tool-specific projections

These may be generated from shared canonical assets:

- Cursor `.cursor/rules/*.mdc` derived from shared instruction manifests
- Claude compatibility symlinks in `.claude/skills/`
- Claude memory imports in `CLAUDE.md` pointing at shared docs
- Codex wrappers when a shared skill needs a Codex-specific name

### Class C: Tool-only assets

These stay native unless a documented equivalent emerges:

- Claude custom slash commands in `.claude/commands/`
- Claude hook configuration in `.claude/settings.json`
- Cursor generated memories
- any future Codex or Cursor proprietary project surfaces that lack stable cross-tool semantics

## Projection Strategy

### 1. Skills

**Canonical source:** `.agents/skills/<skill>/`

**Claude projection:** `.claude/skills/<skill>` symlink for shared skills, or real wrapper directory for renamed or Claude-only variants.

**Cursor projection:** optional. Do not project every skill by default. Only project a skill into `.cursor/skills` if Cursor actually benefits from direct skill discovery in your workflow.

**Codex projection:** none needed beyond canonical storage because Codex already reads `.agents/skills`.

### 2. Project instructions

**Canonical source:** `AGENTS.md`

Projection rules:

- Codex reads `AGENTS.md` directly.
- Cursor supports `AGENTS.md` directly, so this should remain the primary shared instruction surface.
- Claude should keep using `CLAUDE.md` for project memory, but that file should reference shared project guidance rather than duplicate it when possible.

Recommended approach:

- Keep high-level repo doctrine and durable conventions in `AGENTS.md`
- Keep Claude-only operating instructions in `CLAUDE.md`
- Prefer imports or references over copy-pasted duplication

### 3. Memory

Memory is not portable as a single file abstraction.

- **Claude Code:** project memory remains `./CLAUDE.md`
- **Cursor:** memories are managed by Cursor, not by a durable repo file we should treat as canonical
- **Codex:** use `AGENTS.md` and shared skills instead of inventing a separate memory projection

Policy:

- Do not attempt to sync Cursor-generated memories into the repo
- Treat `AGENTS.md` as the cross-tool durable memory layer
- Treat `CLAUDE.md` as a Claude-specific adapter layer

### 4. Slash commands

Slash commands are not portable across the three tools.

Current official Anthropic docs still document custom slash commands in `.claude/commands/`. This repo is migrating command workflows into shared skills proactively for cross-agent compatibility, not because Anthropic already provides an official slash-command-to-skill migration format.

- **Claude Code:** keep `.claude/commands/` as the real implementation
- **Cursor:** no project-local slash command format is defined in this spec
- **Codex:** do not project Claude slash commands directly; convert important commands into skills or `AGENTS.md` workflows

Policy:

- Do not sync `.claude/commands/` as if they were universal assets
- Instead, maintain a command-to-skill mapping for workflows worth sharing

### 5. Hooks

Hooks are also not portable as a shared file format.

- **Claude Code:** `.claude/settings.json` remains canonical for Claude hooks
- **Cursor:** no equivalent repo hook system is assumed here
- **Codex:** no equivalent repo hook system is assumed here

Policy:

- Keep hook logic modular in scripts when possible
- Allow Claude hook commands to call reusable project scripts
- If another tool later supports project hooks, add a projection adapter then

## Proposed Repo Structure

```text
/
├── AGENTS.md
├── CLAUDE.md
├── .agents/
│   └── skills/
│       ├── syncing-agent-skills/
│       │   └── references/
│       │       └── sync-harnesses-spec.md
│       └── ...
├── .claude/
│   ├── skills/
│   │   ├── <shared-skill> -> ../../.agents/skills/<shared-skill>
│   │   └── <claude-only-skill>/
│   ├── commands/
│   ├── hooks/
│   └── settings.json
└── .cursor/
    └── rules/
```

## Sync Manifest

The sync system should eventually use a manifest rather than ad hoc file discovery.

Recommended path:

- `.agents/harness.manifest.json`

Recommended top-level fields:

```json
{
  "version": 1,
  "sharedSkills": [],
  "claudeOnlySkills": [],
  "skillWrappers": [],
  "commandMappings": [],
  "instructionProjections": [],
  "hookPolicies": []
}
```

### Suggested manifest concepts

| Field                    | Purpose                                                              |
| ------------------------ | -------------------------------------------------------------------- |
| `sharedSkills`           | Skills whose source of truth is `.agents/skills`                     |
| `claudeOnlySkills`       | Skills intentionally left in `.claude/skills`                        |
| `skillWrappers`          | Renamed or tool-specific wrapper definitions                         |
| `commandMappings`        | Claude command -> shared skill or AGENTS workflow mapping            |
| `instructionProjections` | Rules for deriving `CLAUDE.md` or Cursor rule files from shared docs |
| `hookPolicies`           | Which Claude hooks are pure Claude, and which call reusable scripts  |

## Generation Rules

### Shared skill generation

- Never generate shared skills into `.claude/skills` first
- Author or move shared skills into `.agents/skills`
- For Claude visibility, generate per-skill symlinks into `.claude/skills`
- For renamed projections, generate a real wrapper instead of a symlink

### Instruction generation

- `AGENTS.md` is hand-authored and canonical
- `CLAUDE.md` should be curated, not blindly generated
- Cursor rules may be generated from selected shared instruction fragments, not from all of `AGENTS.md`

### Command generation

- No automatic projection from Claude commands to Codex or Cursor commands
- Shared command intent should instead map to:
  - a shared skill
  - a shared script
  - an `AGENTS.md` workflow section

## Conflict Resolution

When the same concept exists in multiple places:

1. Prefer the canonical shared location if the concept is truly cross-tool.
2. Prefer the tool-native location if the concept depends on unsupported primitives elsewhere.
3. If two files diverge and neither is clearly canonical, stop and require human review.

Never silently merge:

- shared skill content and wrapper content
- `AGENTS.md` and `CLAUDE.md`
- generated Cursor rules and hand-authored Cursor rules

## Rollout Plan

### Phase 1

- Make `.agents/skills/` canonical for shared skills
- Backfill `.claude/skills/` with per-skill symlinks
- Keep Claude-only skills in `.claude/skills/`

### Phase 2

- Add a manifest describing shared skills, wrappers, and exceptions
- Define `reading-claude-code-transcripts` as the first real Codex wrapper
- Document command-to-skill replacements for the highest-value Claude commands

### Phase 3

- Introduce optional Cursor rule projections for selected shared instructions
- Extract reusable hook scripts from Claude hook commands where practical
- Add a validation command that audits harness drift

## Open Questions

- Should Cursor get a projected `.cursor/skills/` layer at all, or should it rely on `AGENTS.md` plus `.cursor/rules`?
- How much of `CLAUDE.md` should stay Claude-specific versus import shared docs?
- Should the manifest live at `.agents/harness.manifest.json` or inside the sync skill directory?
- Do we want a generated report that explains why a given asset is shared, projected, or tool-only?

## Recommended Next Work

1. Add a manifest for shared skills and exceptions.
2. Draft the first command-to-skill mapping table for `/pm`, `/linear:*`, `/ideate`, and `/spec:*`.
3. Decide whether Cursor needs projected skills, projected rules, or both.
4. Define the wrapper spec for `reading-claude-code-transcripts`.
