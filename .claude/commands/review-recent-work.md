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
