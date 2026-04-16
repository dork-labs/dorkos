---
name: debugging-typescript-errors
description: Systematically investigates TypeScript compiler errors, traces the real type mismatch, and applies a minimal verified fix. Use when the user wants to debug type errors or replace the legacy `/debug:types` workflow.
---

# Debugging TypeScript Errors

## Overview

This is the shared-skill replacement for the legacy Claude Code `/debug:types` workflow.

Use it when TypeScript errors need real diagnosis rather than cargo-cult assertions or broad type loosening.

## Read First

Before acting, read:

- `.agents/skills/debugging-systematically/SKILL.md`
- `AGENTS.md`

## Core Workflow

1. **Collect the error**
   - use the provided error text when available
   - otherwise run the narrowest useful typecheck scope
2. **Parse the compiler signal**
   - error code
   - file and location
   - expected vs actual type
3. **Read the surrounding code**
   - never propose a fix before reading the file
4. **Trace the type source**
   - where the actual type comes from
   - where the expected type is defined
   - where inference or narrowing goes wrong
5. **Classify the problem**
   - wrong data
   - wrong type definition
   - missing narrowing
   - generic inference failure
   - invalid assertion
6. **Apply the smallest correct fix**
   - fix data before widening types
   - fix definitions before forcing assertions
   - use assertions only as a last resort
7. **Re-run typecheck**
   - confirm the original error is gone
   - check that no new related errors were introduced

## Cross-Agent Rules

- Treat this skill as the portable replacement for `/debug:types`.
- Keep a short execution plan, but do not depend on a tool-specific todo API.
- Ask bounded clarification only when the repair strategy changes system behavior or type contracts materially.
- Prefer preserving strictness over silencing the compiler.
