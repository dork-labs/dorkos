---
description: Ask how to do something in this repository
argument-hint: [question]
allowed-tools: Read, Grep, Glob, Bash, Skill, SlashCommand, AskUserQuestion, Agent, WebSearch
---

# System Help

Answer the question in `$ARGUMENTS`: how to accomplish a task in this repository, using Claude Code or manually.

## Search order

Consult these sources, in order, until you can answer confidently:

1. `.claude/README.md` — complete harness inventory: every command, agent, skill, rule, and hook, plus naming conventions and maintenance guides
2. `AGENTS.md` — project architecture, conventions, quality standards
3. `decisions/` — ADRs explaining why things are the way they are (use `decisions/manifest.json` to find by topic)
4. `contributing/` — 28 developer guides with detailed patterns (`contributing/INDEX.md` maps topics to guides)
5. `.claude/rules/` — path-specific rules (each has `paths:` frontmatter declaring which files it governs)

Read the files the question actually touches — don't answer from memory when a source file can confirm.

## Escalation

- **Claude Code / Agent SDK / Claude API questions** not answered by local docs: dispatch the `claude-code-guide` agent — it has direct access to official documentation and is authoritative for hooks, skills, slash commands, MCP, settings, and SDK usage.
- **Non-Claude topics** (libraries, general patterns): WebSearch.

## When no process exists

If the repo has no defined process for the question, say so plainly, give best-effort guidance from similar patterns, then suggest the right follow-up:

- `/system:learn` — when experimentation is needed to figure out the approach first
- `/system:update` — when the fix/process is already known and just needs codifying

## Answer format

Give a direct answer with concrete file paths. When both exist, show **both** the Claude Code method (slash command, agent, or skill — prefer a slash command when one exists) and the manual method (the actual files/commands to touch). Note relevant caveats, e.g. `/flow:*` commands require the flow plugin (dork-labs/marketplace) loaded via `--plugin-dir`. Offer to execute the Claude Code method when that's clearly what the user wants.
