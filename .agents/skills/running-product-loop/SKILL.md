---
name: running-product-loop
description: Reviews the current Linear product loop, recommends the most important next action, and optionally executes it. Use when asked to assess project status, decide what to do next, audit loop health, or work a specific Linear issue directly.
---

# Running Product Loop

## Overview

This is the shared-skill replacement for the legacy Claude Code `/pm` workflow.

Use it to:

- assess the current state of the product loop
- recommend the highest-priority next action
- process a specific Linear issue directly
- audit workspace health
- classify freeform product input into the right Linear issue shape

## Read First

Before acting, read:

- `.claude/skills/linear-loop/SKILL.md`
- `.claude/skills/linear-loop/config.json`

These remain the canonical source for the Loop methodology, label taxonomy, project transitions, and spec bridge conventions.

## Request Modes

Interpret the user request using these modes:

### Default loop review

Use when the user asks for:

- the current loop state
- the next most important action
- product triage or prioritization
- a product-manager style recommendation

Action:

1. Sync current Linear and spec state
2. Present a concise dashboard
3. Recommend one next action
4. Wait for approval before executing unless the user explicitly asked for autonomous execution

### Autonomous loop execution

Use when the user explicitly asks to run automatically or continue without pauses.

Action:

1. Read `pm.autoLimit` and `pm.approvalGates` from config
2. Execute actions sequentially
3. Pause at approval gates or real ambiguity
4. Report completed actions and remaining blockers

### Direct issue mode

Use when the user names a specific Linear issue such as `DOR-47`.

Action:

1. Fetch the issue
2. Show relevant context
3. Route by issue type using the rules in `linear-loop/SKILL.md`
4. Execute the appropriate action

### Audit mode

Use when the user asks for workspace or loop health.

Action:

1. Load `.claude/skills/linear-loop/templates/audit-workspace.md`
2. Look for stale work, wrong labels, orphaned issues, and status drift
3. Report findings and recommended fixes

### Freeform intake mode

Use when the user gives an idea, brief, bug report, or product prompt that is not already a Linear issue.

Action:

1. Read `.claude/skills/linear-loop/templates/triage-intake.md`
2. Classify the input
3. Create or recommend the correct issue shape
4. Add next-steps guidance

## Cross-Agent Rules

- Do not assume slash commands exist.
- Treat this skill as the portable replacement for `/pm`.
- If Linear tooling is unavailable, say so clearly and stop instead of pretending to execute the workflow.
- Ask a short bounded question only when ambiguity materially changes the outcome.
- Prefer one recommended next action over a long menu unless the user explicitly asks for options.

## Related Skills

- `capturing-linear-ideas` for fast idea capture
- `closing-linear-loop` for explicit issue completion and project pulse checks
