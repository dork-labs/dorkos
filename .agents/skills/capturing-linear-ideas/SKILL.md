---
name: capturing-linear-ideas
description: Captures a new idea into the Linear backlog as a type/idea issue without doing full triage. Use when the user wants quick idea capture or backlog intake without full triage.
---

# Capturing Linear Ideas

## Overview

This is the shared-skill replacement for the legacy Claude Code `/linear:idea` workflow.

Use it when the goal is quick idea capture rather than evaluation.

## Read First

Before acting, read:

- `.claude/skills/linear-loop/SKILL.md`
- `.claude/skills/linear-loop/config.json`

These define issue conventions, labels, comment format, and the team configuration.

## Process

1. Take the user’s input as the idea description.
2. If the input is too thin to create a meaningful issue, ask for the minimum missing detail.
3. Create a Linear issue with:
   - the configured team
   - a concise actionable title
   - the provided idea as description
   - `type/idea` and `origin/human` labels
   - Triage state
4. Add the structured next-steps comment described in `linear-loop/SKILL.md`.
5. Report the created issue ID and title.

## Guardrails

- Do not triage or evaluate the idea here.
- Do not expand the scope beyond what the user asked for.
- If the user wants classification, planning, or prioritization, use `running-product-loop` instead.
- If Linear tooling is unavailable, explain the limitation clearly.
