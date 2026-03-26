---
description: Trace through recent code changes to verify implementation correctness and completeness
allowed-tools: Read, Grep, Glob, Edit
---

# Review Recent Work

Double check your most recent work, tracing your way through each function to make sure that the implementation is both correct and complete.

## Task

1. Identify the files and functions that were recently modified
2. For each function, explain:
   - What the function does
   - What depends on it (callers)
   - What dependencies it has (callees)
3. Trace through the logic to verify correctness
4. Correct any issues found during the review

## Output Format

For each function reviewed:

```
### `functionName` in `path/to/file.ts`

**Purpose**: [what it does]

**Dependencies**:
- Calls: [list of functions/modules it uses]
- Called by: [list of callers]

**Review**: [assessment of correctness]

**Issues Found**: [none, or list of issues with fixes applied]
```

## Structured Review Option

This command provides a quick inline self-review. For deeper, more rigorous review — especially after completing a major feature, finishing a spec task, or before merging to main — dispatch the **code-reviewer** subagent instead.

The code-reviewer agent (`.claude/agents/code-reviewer.md`) is a senior reviewer that independently inspects actual code against plans, specs, and DorkOS coding standards. It verifies FSD layer compliance, SDK import confinement, architecture boundaries, test coverage, and production readiness.

**How to dispatch:** Follow the instructions in the `/skill:requesting-code-review` skill, which walks through obtaining git SHAs, assembling the review context, dispatching the subagent, and acting on feedback.

**When to escalate from self-review to structured review:**

- The changes span multiple packages or architectural layers
- You modified shared interfaces or transport contracts
- You added or changed database schemas
- You are about to merge to main
- You want a fresh perspective after being stuck
