---
name: implementing-specifications
description: Implements a validated specification, keeps execution progress durable, and advances linked project work cleanly. Use when the user wants to execute a spec or replace the legacy `/spec:execute` workflow.
---

# Implementing Specifications

## Overview

This is the shared-skill replacement for the legacy Claude Code `/spec:execute` workflow.

Use it when a specification is already validated and the next job is disciplined implementation.

## Read First

Before acting, read:

- `.claude/skills/executing-specs/SKILL.md`

Load supporting files from `.claude/skills/executing-specs/` only on demand.

## Core Workflow

1. **Validate inputs**
   - confirm the specification exists
   - identify the feature slug
   - confirm task decomposition exists
2. **Scaffold or resume implementation tracking**
   - create or update `04-implementation.md`
   - persist progress incrementally, not only at the end
3. **Review the execution plan**
   - determine completed, in-progress, and pending work
   - identify dependency-aware batches or a safe sequential order
4. **Execute implementation**
   - if parallel agent work is explicitly requested and supported, use it carefully
   - otherwise execute sequentially
5. **Review outcomes**
   - check task completeness against the spec
   - check code quality after correctness
6. **Persist progress after each meaningful unit**
   - completed tasks
   - files changed
   - known issues
   - session summary
7. **Advance linked workflow**
   - if the spec is linked to a Linear issue, leave progress breadcrumbs when tooling is available
   - recommend the next completion step when implementation finishes

## Portability Rules

- Treat this skill as the portable replacement for `/spec:execute`.
- Do not assume task APIs, background agents, or slash commands exist.
- When those capabilities are unavailable, keep the same execution discipline using sequential work and manual progress tracking.
- Preserve the existing DorkOS spec file structure and terminology.

## Verification Rules

- Do not claim completion without running the relevant checks.
- Keep implementation tracking durable across long-running work.
- Prefer spec compliance review before code-style or polish review.
