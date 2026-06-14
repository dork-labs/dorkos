---
name: debugging-test-failures
description: Systematically investigates failing tests, distinguishes between test bugs and implementation bugs, and drives a fix with verification. Use when the user wants to debug failing tests.
---

# Debugging Test Failures

## Overview

This is the shared-skill replacement for the legacy Claude Code `/debug:test` workflow.

Use it when tests are failing and the goal is to identify the real root cause instead of making blind changes.

## Read First

Before acting, read:

- `.agents/skills/debugging-systematically/SKILL.md`
- `.claude/skills/test-driven-development/SKILL.md` when the failing test is tied to new feature work or a bugfix

## Core Workflow

1. **Run the relevant test scope**
   - one file or one pattern when possible
   - whole-suite only when needed
2. **Parse the failure output**
   - failing test names
   - expected vs actual behavior
   - error messages and stack traces
3. **Read the failing test first**
   - understand arrange / act / assert
   - explain what the test is trying to prove
4. **Read the implementation under test**
   - trace inputs, transformations, and outputs
5. **Decide where the bug lives**
   - implementation
   - test logic
   - mock/setup
   - broader shared root cause
6. **Apply a minimal fix**
   - fix the real problem, not just the symptom
7. **Re-run verification**
   - the failing test
   - nearby tests when relevant

## Decision Heuristics

- Prefer implementation fixes when the test encodes correct expected behavior.
- Prefer test fixes when the implementation is correct and the test is asserting the wrong thing.
- If multiple failures share one cause, fix the root cause before touching individual assertions.
- If the test never demonstrated a correct RED state, repair the test before trusting it.

## Cross-Agent Rules

- Treat this skill as the portable replacement for `/debug:test`.
- Keep a short execution plan, but do not depend on a tool-specific todo API.
- Ask bounded clarification only if multiple failure scopes or fix strategies are materially different.
- Always end with real verification, not reasoning alone.
