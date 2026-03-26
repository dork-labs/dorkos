---
name: verification-before-completion
description: Use when about to claim work is complete, fixed, or passing, before committing or creating PRs - requires running verification commands and confirming output before making any success claims; evidence before assertions always
---

# Verification Before Completion

## Overview

Claiming work is complete without verification is dishonesty, not efficiency.

**Core principle:** Evidence before claims, always.

**Violating the letter of this rule is violating the spirit of this rule.**

## The Iron Law

```
NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
```

If you haven't run the verification command in this message, you cannot claim it passes.

## The Gate Function

```
BEFORE claiming any status or expressing satisfaction:

1. IDENTIFY: What command proves this claim?
2. RUN: Execute the FULL command (fresh, complete)
3. READ: Full output, check exit code, count failures
4. VERIFY: Does output confirm the claim?
   - If NO: State actual status with evidence
   - If YES: State claim WITH evidence
5. ONLY THEN: Make the claim

Skip any step = lying, not verifying
```

## DorkOS Verification Commands

| Claim            | Command                                       | What to check                |
| ---------------- | --------------------------------------------- | ---------------------------- |
| Tests pass       | `pnpm vitest run` or `pnpm vitest run <path>` | 0 failures, exit 0           |
| Linter clean     | `pnpm lint`                                   | 0 errors, 0 warnings         |
| Types check      | `pnpm typecheck`                              | 0 errors across all packages |
| Build succeeds   | `pnpm build`                                  | exit 0 for all packages      |
| Single test file | `pnpm vitest run <path-to-test-file>`         | 0 failures, exit 0           |

When scoped to a single package, prefer filtered commands:

- `pnpm vitest run apps/server/src/path/to/test.ts`
- `dotenv -- turbo typecheck --filter=@dorkos/server`

## Common Failures

| Claim                 | Requires                        | Not Sufficient                 |
| --------------------- | ------------------------------- | ------------------------------ |
| Tests pass            | Test command output: 0 failures | Previous run, "should pass"    |
| Linter clean          | Linter output: 0 errors         | Partial check, extrapolation   |
| Build succeeds        | Build command: exit 0           | Linter passing, logs look good |
| Bug fixed             | Test original symptom: passes   | Code changed, assumed fixed    |
| Regression test works | Red-green cycle verified        | Test passes once               |
| Agent completed       | VCS diff shows changes          | Agent reports "success"        |
| Requirements met      | Line-by-line checklist          | Tests passing                  |

## Red Flags - STOP

- Using "should", "probably", "seems to"
- Expressing satisfaction before verification ("Great!", "Perfect!", "Done!", etc.)
- About to commit/push/PR without verification
- Trusting agent success reports
- Relying on partial verification
- Thinking "just this once"
- Tired and wanting work over
- **ANY wording implying success without having run verification**

## Rationalization Prevention

| Excuse                                  | Reality                    |
| --------------------------------------- | -------------------------- |
| "Should work now"                       | RUN the verification       |
| "I'm confident"                         | Confidence is not evidence |
| "Just this once"                        | No exceptions              |
| "Linter passed"                         | Linter is not compiler     |
| "Agent said success"                    | Verify independently       |
| "I'm tired"                             | Exhaustion is not excuse   |
| "Partial check is enough"               | Partial proves nothing     |
| "Different words so rule doesn't apply" | Spirit over letter         |

## Key Patterns

**Tests:**

```
pnpm vitest run
pnpm vitest run apps/client/src/layers/widgets/session/__tests__/SessionPage.test.tsx

Result: "Tests  34 passed (34)" "Test Files  1 passed (1)"
Only THEN: "All tests pass"
```

**Regression tests (TDD Red-Green):**

```
Write test -> Run (pass) -> Revert fix -> Run (MUST FAIL) -> Restore -> Run (pass)
Not: "I've written a regression test" (without red-green verification)
```

**Build:**

```
pnpm build
Result: exit 0, all packages built
Only THEN: "Build passes"
Not: "Linter passed" (linter does not check compilation)
```

**Types:**

```
pnpm typecheck
Result: 0 errors across all packages
Only THEN: "Types check"
Not: "Build passed" (build may skip strict checks)
```

**Requirements:**

```
Re-read plan -> Create checklist -> Verify each -> Report gaps or completion
Not: "Tests pass, phase complete"
```

**Agent delegation:**

```
Agent reports success -> Check VCS diff -> Verify changes -> Report actual state
Not: Trust agent report
```

## Why This Matters

From 24 failure memories:

- the user said "I don't believe you" - trust broken
- Undefined functions shipped - would crash
- Missing requirements shipped - incomplete features
- Time wasted on false completion, then redirect, then rework
- Violates: "Honesty is a core value. If you lie, you'll be replaced."

## When To Apply

**ALWAYS before:**

- ANY variation of success/completion claims
- ANY expression of satisfaction
- ANY positive statement about work state
- Committing, PR creation, task completion
- Moving to next task
- Delegating to agents

**Rule applies to:**

- Exact phrases
- Paraphrases and synonyms
- Implications of success
- ANY communication suggesting completion/correctness

## The Bottom Line

**No shortcuts for verification.**

Run the command. Read the output. THEN claim the result.

This is non-negotiable.
