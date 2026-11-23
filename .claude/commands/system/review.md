---
description: Review the agent harness for correctness, bloat, consistency and fit with current models
argument-hint: '[area to review (optional)]'
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, AskUserQuestion, Agent, WebSearch
---

# System Review

Review the agent harness and keep it small, true and current. `$ARGUMENTS` optionally scopes the review. It can be an area (`agents-md`, `commands`, `agents`, `skills`, `rules`, `hooks`, `memory`) or a pattern (`git commands`, `debug/*`). Empty means everything.

**In scope:**

- `AGENTS.md`, plus `.claude/CLAUDE.md`, which imports it
- `.claude/README.md`, `.claude/commands/`, `.claude/agents/`, `.claude/rules/`, `.claude/hooks/`, and the hook wiring in `.claude/settings.json`
- Skills in `.claude/skills/` and in `.agents/skills/`, the canonical home of shared skills, which Codex and other harnesses also read

**Report but don't edit**, because these live outside this repo:

- the workspace `../CLAUDE.md`, owned by the private `.workspace` repo
- the auto-memory index `MEMORY.md`, which loads every session

`.claude/README.md` describes each component type and where it lives. Projected plugin files (`.claude/commands/flow/`, `.claude/skills/flow__*`) belong to the marketplace repo, so report problems there rather than editing them.

The evidence behind this checklist, with sources, is `research/20261123_harness-instruction-files-best-practices.md`. Re-check those sources when they are more than a few months old, or when a new model family ships. Use the `claude-code-guide` agent for Anthropic docs.

## The core test

Every always-loaded line costs attention on every task. Studies show context files that repeat what the repo already says raise cost without raising success. So for each line ask two things:

1. **Can an agent find this by reading the repo, or would it spend real time rediscovering it?** If it can find it cheaply, cut it or replace it with a pointer. Examples: folder trees, package lists, route lists, architecture summaries, tech stacks, and anything a script or lint rule already states.
2. **Is it a rule with zero exceptions?** Then it belongs in a hook, lint rule, test or permission, and the prose shrinks to one line naming the rule and why it exists. A rule with exceptions stays as prose, with its scope and reason.

Keep what lives only in people's heads: intent, vocabulary decisions, costly or dangerous operations, gotchas, and the reasons behind enforced rules.

## Mechanical checks

Check these with scripts, grep and file counts, not judgment.

- **Size budgets.**
  - `AGENTS.md` under 200 lines, and **under 32 KiB in bytes**. Codex reads only that much by default, so text past it never reaches Codex.
  - Rules without `paths:` count against the same always-loaded budget.
  - `SKILL.md` bodies under 500 lines, with references one level deep.
  - A skill's `description` plus `when_to_use` under 1,536 characters, with the main use case first.
  - Report the measured sizes, not just pass or fail.
- **Inventory counts.** Compare file counts under each component directory with the counts and tables in `.claude/README.md`. Count both skill homes.
- **Broken and phantom references.** Paths, agents, skills, commands, rules, tools and MCP tool names that don't exist. Check the Agent tool's available types too.
- **Skill spec conformance** ([agentskills.io](https://agentskills.io/specification)).
  - `name` matches its directory.
  - Lowercase letters, digits and single hyphens only.
  - Shared skills in `.agents/skills/` use only the six portable frontmatter fields (`name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`), because other harnesses reject the rest.
  - Gerund names are preferred, not required: scheduled and noun-named skills are fine.
- **Frontmatter.**
  - Commands have `description` and fitting `allowed-tools`.
  - Skill descriptions say what the skill does and when to use it.
  - Rules have `paths:` globs that match real files.
- **Hook wiring.** Every hook in `.claude/settings.json` points at a script that exists.
- **ADR drift.** Run `node .claude/scripts/adr-drift-check.mjs`, and spot-check manifest statuses against ADR frontmatter.
- **Built-in audits.** Run `/skill-doctor` where available. Where a skill has evals, run `claude plugin eval`. A doctor report is triage, not a verdict.

## Judgment checks

- **Discoverability**: the core test above, applied line by line to always-loaded files first, since they cost the most.
- **Time-sensitive facts.** Flag text that will go stale and has a better home:
  - product status and release state
  - PR and ticket numbers given as history
  - "shipped on date X"
  - counts of things a test already guards

  Move status to `meta/ROADMAP.md` or the tracker and point to it.

- **Wording for current models.**
  - Emphasis (CRITICAL, MUST, ALWAYS, bold warnings) makes models over-apply a rule. Rewrite it as a plain instruction with its reason.
  - Claude 5 models take "never" literally, as having no exceptions. Keep it only where that is true and enforced. Elsewhere give the scope and reason.
  - Delete cautions whose reason no longer holds.
  - Flag step-by-step micromanagement, fill-in-the-blank templates, question trees for inferable choices, and standing "double-check your work" or "use subagents" lines. Opus 5 already over-verifies and over-delegates.
- **Hooks that are only preferences.** The enforced set should stay small. A hook that blocks something with legitimate exceptions is a bug in either direction.
- **Staleness against the code.** Verify claims about paths, packages, ports, APIs and the stack against source. The code is authoritative for facts, and `AGENTS.md` for conventions.
- **Consistency.** Look for:
  - conflicting instructions across files, including the workspace `CLAUDE.md`
  - one concept under two names
  - copies that should be pointers
- **Right component type.**
  - Methodology living in a command should be a skill. Commands have merged into skills upstream, and new work goes in skills.
  - Agents that never need isolation should go.
  - Rules that repeat `AGENTS.md` should go.
  - Always-loaded text that only one task needs should become a skill or a path-scoped rule.
- **Earned keep.** For a skill or rule you suspect does nothing, say what failure it prevents. If nobody can name one, propose removing it. An eval or a removal test settles it: run a real task without the skill and see whether the failure returns.

## Severity

| Severity       | Meaning                                                                                            | Action     |
| -------------- | -------------------------------------------------------------------------------------------------- | ---------- |
| **Critical**   | Broken: bad references, phantom components, content past a hard cap such as the Codex 32 KiB limit | Must fix   |
| **Warning**    | Stale facts, conflicts, discoverable bloat in always-loaded files, absolutes that over-restrict    | Should fix |
| **Suggestion** | Wording trims, structural moves, conversions such as command to skill                              | Optional   |

## Process

1. Build the in-scope file list, run the mechanical checks, and record the measured sizes.
2. Read in-scope files against the judgment checks. Verify every staleness claim against source before reporting it.
3. Present findings by severity, each with the file, the issue and the proposed fix.
   - For always-loaded files, show the before and after size.
   - Where `AGENTS.md` or the code makes the answer obvious, propose the fix.
   - Ask only about real product or policy choices, such as whether a vision paragraph stays.
4. Get one confirmation for the batch, then apply it in a worktree (see `AGENTS.md`, Worktrees) and land it through a PR. Preserve intent: trim and correct, and redesign only when asked.
5. Report what changed, the new sizes, and what was deferred. File follow-ups for anything outside this repo, such as the workspace `CLAUDE.md` or the marketplace plugin.
