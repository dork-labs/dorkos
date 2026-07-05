---
description: Review processes for clarity, consistency, and improvements
argument-hint: '[area to review (optional)]'
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, AskUserQuestion, Agent, WebSearch
---

# System Review

Review the Claude Code harness (commands, agents, skills, rules, hooks, README, AGENTS.md) for correctness, consistency, and fit. `$ARGUMENTS` optionally scopes the review: an area (`commands`, `agents`, `skills`, `rules`, `hooks`, `memory`) or a pattern (`git commands`, `debug/*`). Empty means review everything.

For the component-type reference (what each component is, where it lives, how it's invoked, naming conventions), use `.claude/README.md` — don't re-derive it.

## Mechanical checklist

Verifiable facts — check with grep/glob/scripts, not judgment:

- **Inventory counts** — actual file counts under `.claude/commands`, `.claude/agents`, `.claude/skills`, `.claude/rules` vs the counts and tables in `.claude/README.md`.
- **Broken file references** — paths mentioned in commands/skills/README that don't exist on disk.
- **Phantom components** — references to agents, tools, commands, skills, or rules that don't exist (e.g. an agent name not present in `.claude/agents/` or the Agent tool's available types; MCP tool names that don't match the current plugin-prefixed forms).
- **Frontmatter validity** — every command has `description` and appropriate `allowed-tools`; skills have gerund names and "Use when" descriptions; rules have valid `paths:` globs that actually match files.
- **ADR drift** — run `node .claude/scripts/adr-drift-check.mjs` (orphan files, slug collisions, manifest entries without files). Also spot-check that manifest statuses match ADR frontmatter.
- **Hook wiring** — every hook in `.claude/settings.json` points at a script that exists in `.claude/hooks/`.

## Judgment checklist

Requires reading and thinking:

- **Staleness vs current code** — commands assert facts about the codebase (paths, package names, port numbers, API shapes, tech stack). Verify claims against source; AGENTS.md is authoritative for conventions, the code is authoritative for facts. Flag anything the repo has since outgrown.
- **Opus-fit** — this harness runs Opus-class models. Commands should state goals, constraints, project-specific facts, and verification criteria. Flag as issues to cut: step-by-step micromanagement of things the model can decide, fill-in-the-blank output templates, AskUserQuestion decision trees for inferable choices, and CRITICAL/MUST/ALWAYS scaffolding that substitutes emphasis for information.
- **Consistency** — conflicting instructions between files, same concept under different names, duplicated content that should be a pointer.
- **Right component type** — content that teaches reusable methodology living in a command (should be a skill), agents that never need isolation, rules that duplicate AGENTS.md.

## Severity

| Severity       | Meaning                                             | Action     |
| -------------- | --------------------------------------------------- | ---------- |
| **Critical**   | Broken functionality — bad refs, phantom components | Must fix   |
| **Warning**    | Stale facts, inconsistency, confusion risk          | Should fix |
| **Suggestion** | Opus-fit trims, structural improvements             | Optional   |

## Process

1. Build the in-scope file list and run the mechanical checklist.
2. Read in-scope files against the judgment checklist (verify staleness claims against actual source before reporting them).
3. Present findings grouped by severity, each with file, issue, and proposed fix. Where the right answer is obvious from AGENTS.md or the code, just propose the fix; use AskUserQuestion only for genuine ambiguity.
4. Batch the fixes and get one user confirmation before applying. Preserve intent — fix bugs and staleness, don't redesign unless asked.
5. Report what changed and anything deferred.
