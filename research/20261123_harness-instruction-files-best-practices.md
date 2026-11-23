---
title: 'Harness and instruction-file best practices: November 2026 refresh'
date: 2026-11-23
type: external-best-practices
status: active
tags: [harness, claude-code, agents-md, claude-md, skills, hooks, subagents, context-engineering]
---

# Harness and instruction-file best practices: November 2026 refresh

This report refreshes [the July 2026 harness audit](20260705_harness-audit-opus-optimization.md) with what Anthropic and the wider industry published since. Every source was fetched live on 2026-11-23. `/system:review` (`.claude/commands/system/review.md`) applies these findings, so this report is the "why" behind its checklist.

## The one test

**Write down only what an agent cannot find by reading the repo, or would spend real time rediscovering.** Everything else costs attention on every task and goes stale.

- Anthropic: "Only write down what Claude can't find by reading the repo, or what it would otherwise spend time rediscovering every session." Its cut list includes "Describe your architecture and file layout in CLAUDE.md. Claude reads the repo itself." ([best practices](https://code.claude.com/docs/en/best-practices))
- Evidence, ETH Zurich, "Evaluating AGENTS.md" ([arXiv 2602.11988](https://arxiv.org/abs/2602.11988), Feb 2026):
  - Context files "do not generally improve task success rates" and raise inference cost by over 20%.
  - Model-generated files lowered success slightly.
  - Short hand-written files helped a little, about +4% on one benchmark, and not for Claude Code.
  - Repo overviews were in 8 of 12 developer files, and they did not help agents find files faster.
  - Agents do follow the files, which makes them test and explore more.
- Evidence, Vercel ([blog](https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals), Jan 2026): a compressed 8 KB AGENTS.md index of version-specific docs took a Next.js 16 eval from 53% to 100%. The two studies agree once you look at the content. Vercel's file held facts the model could not know. ETH's held overviews the model could discover.
- Practitioners agree: Cursor's rules docs, [HumanLayer](https://www.humanlayer.dev/blog/writing-a-good-claude-md), [Addy Osmani](https://addyosmani.com/blog/audit-your-agent-files/) and the [Thoughtworks Radar on "agent instruction bloat"](https://www.thoughtworks.com/en-sg/radar/techniques/agent-instruction-bloat).
  - Keep: run commands, costly operations, generated files, safety boundaries and gotchas.
  - Cut: summaries of existing code, README duplicates, generic clean-code advice, and rules added after one error and never removed.

## Size budgets

| Surface                             | Budget                                                                                                              | Source                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| CLAUDE.md / AGENTS.md               | under 200 lines; "Longer files consume more context and reduce adherence"                                           | [memory docs](https://code.claude.com/docs/en/memory)                                                    |
| `@import`                           | saves nothing: imported files load with the importer                                                                | memory docs                                                                                              |
| AGENTS.md as Codex reads it         | **32 KiB** combined (`project_doc_max_bytes`); anything past it is never seen                                       | [Codex docs](https://learn.chatgpt.com/docs/agent-configuration/agents-md)                               |
| SKILL.md body                       | under 500 lines (agentskills.io: under 5,000 tokens); references one level deep, a table of contents past 100 lines | [skill best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices) |
| Skill `description` + `when_to_use` | truncated at 1,536 characters in Claude Code (1,024 in the base spec); put the key use case first                   | [skills](https://code.claude.com/docs/en/skills)                                                         |
| Loaded skill body                   | "stays in context across turns, so every line is a recurring token cost"                                            | skills                                                                                                   |
| Enforced hooks                      | "If you ever find yourself at forty of them, most are probably preferences"                                         | best practices                                                                                           |

At this report's date, the repo's `AGENTS.md` is 251 lines but about 61 KB, nearly twice the Codex cap. No repo or user config raises `project_doc_max_bytes`, so Codex silently drops the second half.

## Hooks versus prose

- "CLAUDE.md is for guidelines, and Claude is allowed to decide a guideline doesn't apply." A rule with zero exceptions belongs in a hook, a deny rule, a linter or a test.
- "If you keep adding emphasis to a CLAUDE.md line and Claude still misses it, that's a sign the line belongs in a hook. The reverse holds too: if you have hooks for things that are only preferences, delete them." ([best practices](https://code.claude.com/docs/en/best-practices))
- What the model sees: exit 2 sends stderr to Claude, and `additionalContext` must sit inside `hookSpecificOutput` or it is silently ignored. Output on exit 0 never reaches the model. Use `onFailure: "block"` when a crashing guard must still block. `prompt` and `agent` hooks are not deterministic. ([hooks guide](https://code.claude.com/docs/en/hooks-guide))
- Once a rule is enforced, the prose only needs one line saying it exists and why. It does not need to restate the mechanism.

## Writing for the newest models (Claude 5 family)

From the [prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices) and its per-model pages:

- **Emphasis over-triggers.** Write "Use this tool when…", not "CRITICAL: You MUST…". "If in doubt, use [tool]" also over-triggers.
- **Absolutes are taken literally.** Fable 5.2 "treats an instruction that contains 'never' as absolute". Rewrite absolute rules with their scope and reason, and "delete cautions whose reason no longer holds." A rule that listed outside messages as needing approval made the model hold back about half of routine requests to colleagues.
- **Explain why.** A reason lets the model generalize correctly.
- **Opus 5 over-delegates and over-verifies.** Its page asks you to remove explicit "double-check" instructions and to state delegation limits.
- **Ownership framing works.** "You are the owner and long-term maintainer of this codebase" made consolidation of duplicates about 75% likely, against under 10% without it.

## Skills, commands, agents, plugins

- **Commands merged into skills.** "Custom commands have been merged into skills. Your existing `.claude/commands/` files keep working." Moving `.claude/commands/x.md` to `.claude/skills/x/SKILL.md` keeps `/x`. ([skills](https://code.claude.com/docs/en/skills))
- **Open standard.** Claude Code skills follow the [Agent Skills spec](https://agentskills.io/specification).
  - The name must match the parent directory, using lowercase letters, digits and single hyphens.
  - Outside Claude Code only six frontmatter fields are valid: `name`, `description`, `license`, `compatibility`, `metadata` and `allowed-tools`. Other harnesses reject the rest with a hard error. That matters for `.agents/skills/`, which other harnesses read.
- **Naming.** The gerund form is _recommended_. Noun phrases and verb-first names are "acceptable alternatives".
- **Scripts over prose** for deterministic steps. Give a default plus an escape hatch, not a menu of options.
- **Subagents** are for side tasks that would flood the main context. Only `name` and `description` are required. The Task tool is now `Agent`.
- **Plugins** package several skills, agents, hooks and MCP servers as one unit. Every enabled plugin costs context through its names and descriptions.

## Keeping a harness from rotting

- **Re-test per model.** Anthropic's [harness design post](https://www.anthropic.com/research/harness-design-long-running-apps) says harness components "can quickly go stale as models improve". Remove one component at a time and see whether anything breaks. Thoughtworks calls this "progression testing".
- **Evals, not only judgment.**
  - `claude plugin eval` runs prompts with and without a plugin and can gate CI. `/skill-doctor` and `/doctor prompt-audit` audit skills and prompts. ([plugin evals](https://code.claude.com/docs/en/plugin-evals))
  - Anthropic's skill guidance: write at least three scenarios and a no-skill baseline before writing the skill.
  - Osmani's removal test: run a real task without the skill, and keep the skill only if the failure it prevents comes back.
- **Pointers rot too.** One study ([arXiv 2606.09090](https://arxiv.org/html/2606.09090)) found 23% of sampled repos had at least one stale code reference in their agent config files. Path and symbol checks are cheap to automate.
- **Time-sensitive facts rot fastest:** product status, PR numbers, "shipped on date X". Skill guidance says no time-sensitive information. Put it in a roadmap or tracker and point to that.

## Where sources disagree

- **Always-loaded index versus on-demand skills.** Vercel's skill went unused in 56% of runs until its trigger wording was made explicit. Use always-loaded context for the few facts every task needs, and skills with sharp "Use when" descriptions for the rest.
- **Size ceilings** run from 60 lines (HumanLayer's own file) to 500 (Cursor). None is measured. Anthropic's 200 lines and Codex's 32 KiB are the two that bind this repo.
- **Instruction counts.** HumanLayer's "150 to 200 instructions" leans on [IFScale](https://arxiv.org/abs/2507.11538), which measured keyword inclusion, not coding rules. Treat it as a direction, not a threshold.
